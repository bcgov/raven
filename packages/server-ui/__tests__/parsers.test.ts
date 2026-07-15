import { describe, it, expect } from "vitest";
import { cleanSshOutput, parseLoad, parseDashboard } from "../src/lib/parsers.js";

// ── Realistic SSH session output ────────────────────────────────────
// This simulates what the expect-based SSH sessions actually produce,
// including the preamble, sudo escalation, history suppression, command
// echo-back, real output, and postamble.

const SSH_PREAMBLE_STANDARD = [
  "spawn ssh -o StrictHostKeyChecking=no jsmith_a@server.example.com",
  "** WARNING: This session is being recorded **",
  "** The server may log your commands for auditing purposes **",
  "+--------------------------------------------------------------+",
  "| Access to this system is restricted to authorized users only. |",
  "| person other than the authorized user is not permitted.       |",
  "| prohibited.                                                   |",
  "+--------------------------------------------------------------+",
  "password: ",
  "Last login: Mon Feb 24 10:00:00 2026 from 10.0.0.1",
  "[jsmith_a@server ~]$ unset HISTFILE; set +o history",
  "[jsmith_a@server ~]$ sudo -su wwwsvr",
  "[sudo] password for jsmith_a: ",
  "[wwwsvr@server ~]$ unset HISTFILE; set +o history",
].join("\n");

const SSH_POSTAMBLE_STANDARD = [
  "[wwwsvr@server ~]$ exit",
  "[jsmith_a@server ~]$ exit",
  "logout",
  "Connection to server.example.com closed.",
].join("\n");

// Non-standard prompt format (bash-4.2$ instead of [user@host]$)
const SSH_PREAMBLE_BASH_PROMPT = [
  "spawn ssh -o StrictHostKeyChecking=no jsmith_a@server.example.com",
  "** WARNING: This session is being recorded **",
  "password: ",
  "Last login: Mon Feb 24 10:00:00 2026",
  "bash-4.2$ unset HISTFILE; set +o history",
  "bash-4.2$ sudo -su wwwsvr",
  "[sudo] password for jsmith_a: ",
  "-bash-4.2$ unset HISTFILE; set +o history",
].join("\n");

const SSH_POSTAMBLE_BASH_PROMPT = [
  "-bash-4.2$ exit",
  "bash-4.2$ exit",
  "logout",
  "Connection to server.example.com closed.",
].join("\n");

// ── cleanSshOutput tests ────────────────────────────────────────────

describe("cleanSshOutput", () => {
  it("strips standard [user@host]$ SSH preamble and postamble", () => {
    const actual = "2024-02-24 ERROR something broke\n2024-02-24 WARN low memory";
    const raw = `${SSH_PREAMBLE_STANDARD}\n[wwwsvr@server ~]$ grep ERROR /apps_ux/logs/RRS/rrs-api/rrs-api.log\n${actual}\n${SSH_POSTAMBLE_STANDARD}`;

    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("2024-02-24 ERROR something broke");
    expect(lines).toContain("2024-02-24 WARN low memory");
    // Should not contain any SSH noise
    expect(lines.some((l) => l.includes("spawn ssh"))).toBe(false);
    expect(lines.some((l) => l.includes("WARNING"))).toBe(false);
    expect(lines.some((l) => l.includes("password"))).toBe(false);
    expect(lines.some((l) => l.includes("Last login"))).toBe(false);
    expect(lines.some((l) => l.includes("unset HISTFILE"))).toBe(false);
    expect(lines.some((l) => l.includes("set +o history"))).toBe(false);
    expect(lines.some((l) => l.includes("sudo -su"))).toBe(false);
    expect(lines.some((l) => l.includes("logout"))).toBe(false);
    expect(lines.some((l) => l.includes("Connection to"))).toBe(false);
  });

  it("strips bash-4.2$ prompt format", () => {
    const actual = "2024-02-24 10:00:00 ERROR NullPointerException";
    const raw = `${SSH_PREAMBLE_BASH_PROMPT}\n-bash-4.2$ tail -100 /apps_ux/logs/RRS/rrs-api/rrs-api.log\n${actual}\n${SSH_POSTAMBLE_BASH_PROMPT}`;

    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("2024-02-24 10:00:00 ERROR NullPointerException");
    expect(lines.some((l) => l.includes("bash-4.2"))).toBe(false);
    expect(lines.some((l) => l.includes("unset HISTFILE"))).toBe(false);
    expect(lines.some((l) => l.includes("sudo -su"))).toBe(false);
  });

  it("strips ANSI escape codes", () => {
    const raw = "\x1b[32m[user@host]\x1b[0m$ exit\nActual log content here";
    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("Actual log content here");
    expect(lines.some((l) => l.includes("\x1b"))).toBe(false);
    expect(lines.some((l) => l.includes("exit"))).toBe(false);
  });

  it("strips terminal control sequences like [?2004h", () => {
    const raw = "[?2004h[user@host]$ unset HISTFILE\nReal output\n[?2004l";
    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("Real output");
    expect(lines.some((l) => l.includes("2004"))).toBe(false);
  });

  it("preserves blank lines in output", () => {
    const raw = "Line 1\n\nLine 3";
    const cleaned = cleanSshOutput(raw);

    expect(cleaned).toContain("\n\n");
    expect(cleaned).toContain("Line 1");
    expect(cleaned).toContain("Line 3");
  });

  it("strips script informational lines (Searching, Path)", () => {
    const raw = [
      "  Searching 'ERROR' in app logs on int01...",
      "  Path: /apps_ux/logs/RRS/rrs-api/rrs-api.log",
      "",
      "1234:2024-02-24 ERROR real match",
    ].join("\n");

    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("1234:2024-02-24 ERROR real match");
    expect(lines.some((l) => l.includes("Searching"))).toBe(false);
    expect(lines.some((l) => l.startsWith("  Path:"))).toBe(false);
  });

  it("strips remote command echo-back (if [ -f ... ])", () => {
    const raw = "if [ -f /apps_ux/logs/RRS/rrs-api/rrs-api.log ]; then tail -n 100 /apps_ux/logs/RRS/rrs-api/rrs-api.log; else echo 'not found'; fi\n2024-02-24 real log line";
    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("2024-02-24 real log line");
    expect(lines.some((l) => l.includes("if [ -f"))).toBe(false);
  });

  it("strips date-range command echo-back (d='...)')", () => {
    const raw = "( d='2024-01-01'; end='2024-01-31'; while ...\n1234:match found";
    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    expect(lines).toContain("1234:match found");
    expect(lines.some((l) => l.includes("d='"))).toBe(false);
  });

  it("does NOT strip legitimate log lines containing 'exit'", () => {
    const raw = "2024-02-24 Process exit code: 1\n2024-02-24 User exited the application";
    const cleaned = cleanSshOutput(raw);

    expect(cleaned).toContain("Process exit code: 1");
    expect(cleaned).toContain("User exited the application");
  });

  it("does NOT strip legitimate log lines containing 'password'", () => {
    // password: at end of line is SSH noise, but mid-line is fine
    const raw = "2024-02-24 ERROR: Invalid password provided for user admin";
    const cleaned = cleanSshOutput(raw);

    expect(cleaned).toContain("Invalid password provided for user admin");
  });

  it("handles full realistic log tail session with standard prompts", () => {
    const logLines = [
      "2024-02-24 10:00:00 INFO  Application started",
      "2024-02-24 10:00:01 DEBUG Loading configuration",
      "2024-02-24 10:00:02 WARN  Connection pool running low",
      "2024-02-24 10:01:00 ERROR ORA-01017: invalid username/password",
      "  at com.example.db.ConnectionPool.getConnection(ConnectionPool.java:42)",
      "  at com.example.service.UserService.authenticate(UserService.java:88)",
    ];
    const raw = [
      SSH_PREAMBLE_STANDARD,
      "[wwwsvr@server ~]$ if [ -f /apps_ux/logs/RRS/rrs-api/rrs-api.log ]; then tail -n 100 /apps_ux/logs/RRS/rrs-api/rrs-api.log; fi",
      ...logLines,
      SSH_POSTAMBLE_STANDARD,
    ].join("\n");

    const cleaned = cleanSshOutput(raw);
    const lines = cleaned.split("\n").filter((l) => l.trim());

    // All actual log lines should be preserved
    for (const logLine of logLines) {
      expect(lines).toContain(logLine);
    }

    // No SSH noise should remain
    expect(lines.some((l) => l.includes("spawn"))).toBe(false);
    expect(lines.some((l) => l.includes("HISTFILE"))).toBe(false);
    expect(lines.some((l) => /^\[.*@.*\]\$/.test(l))).toBe(false);
  });
});

// ── parseLoad tests ─────────────────────────────────────────────────

describe("parseLoad", () => {
  it("parses tagged load output", () => {
    const stdout = [
      "UPTIME: 45 days, 3:21",
      "LOAD: 1.23 0.89 0.67",
      "MEM: 16384 12288 (75%)",
      "DISK: /dev/sda1 | 50G | 30G | 20G | 60% | /",
      "DISK: /dev/sdb1 | 200G | 150G | 50G | 75% | /apps_ux",
    ].join("\n");

    const load = parseLoad(stdout);

    expect(load).not.toBeNull();
    expect(load!.uptime).toBe("45 days, 3:21");
    expect(load!.load1).toBe(1.23);
    expect(load!.load5).toBe(0.89);
    expect(load!.load15).toBe(0.67);
    expect(load!.memTotalMb).toBe(16384);
    expect(load!.memUsedMb).toBe(12288);
    expect(load!.memPercent).toBe(75);
    expect(load!.disks).toHaveLength(2);
    expect(load!.disks[0].filesystem).toBe("/dev/sda1");
    expect(load!.disks[0].usePercent).toBe("60%");
    expect(load!.disks[0].mountpoint).toBe("/");
    expect(load!.disks[1].mountpoint).toBe("/apps_ux");
  });

  it("parses load output after cleanSshOutput strips noise", () => {
    // Simulate full server-load script output (human-readable + raw tagged)
    const scriptOutput = [
      "",
      "  Server Load — int01",
      "  ──────────────────────────────────────────────────",
      "",
      "  Uptime:     45 days, 3:21",
      "  Load Avg:   1.23 0.89 0.67",
      "  Memory:     12288 / 16384 MB (75%)",
      "",
      "  Filesystem               Size     Used    Avail  Use%  Mount",
      "  ──────────────────── ──────── ──────── ──────── ────── ──────",
      "  /dev/sda1                 50G      30G      20G    60%  /",
      "",
      "UPTIME: 45 days, 3:21",
      "LOAD: 1.23 0.89 0.67",
      "MEM: 16384 12288 (75%)",
      "DISK: /dev/sda1 | 50G | 30G | 20G | 60% | /",
    ].join("\n");

    const cleaned = cleanSshOutput(scriptOutput);
    const load = parseLoad(cleaned);

    expect(load).not.toBeNull();
    expect(load!.uptime).toBe("45 days, 3:21");
    expect(load!.load1).toBe(1.23);
    expect(load!.memTotalMb).toBe(16384);
    expect(load!.disks).toHaveLength(1);
  });

  it("parses load output wrapped in full SSH session noise", () => {
    const raw = [
      SSH_PREAMBLE_STANDARD,
      "[wwwsvr@server ~]$ # remote command here",
      "",
      "  Server Load — int01",
      "  ──────────────────────────────────────────────────",
      "",
      "  Uptime:     10 days, 5:30",
      "",
      "UPTIME: 10 days, 5:30",
      "LOAD: 2.50 1.80 1.20",
      "MEM: 32768 24576 (75%)",
      "DISK: /dev/vda1 | 100G | 60G | 40G | 60% | /",
      "DISK: /dev/vdb1 | 500G | 400G | 100G | 80% | /apps_ux",
      "",
      SSH_POSTAMBLE_STANDARD,
    ].join("\n");

    const cleaned = cleanSshOutput(raw);
    const load = parseLoad(cleaned);

    expect(load).not.toBeNull();
    expect(load!.uptime).toBe("10 days, 5:30");
    expect(load!.load1).toBe(2.5);
    expect(load!.load5).toBe(1.8);
    expect(load!.load15).toBe(1.2);
    expect(load!.memTotalMb).toBe(32768);
    expect(load!.memUsedMb).toBe(24576);
    expect(load!.disks).toHaveLength(2);
    expect(load!.disks[1].usePercent).toBe("80%");
  });

  it("parses load output wrapped in bash-4.2$ SSH session", () => {
    const raw = [
      SSH_PREAMBLE_BASH_PROMPT,
      "-bash-4.2$ # remote command",
      "UPTIME: 3 days, 12:00",
      "LOAD: 0.50 0.40 0.30",
      "MEM: 8192 4096 (50%)",
      "DISK: /dev/sda1 | 20G | 10G | 10G | 50% | /",
      SSH_POSTAMBLE_BASH_PROMPT,
    ].join("\n");

    const cleaned = cleanSshOutput(raw);
    const load = parseLoad(cleaned);

    expect(load).not.toBeNull();
    expect(load!.uptime).toBe("3 days, 12:00");
    expect(load!.load1).toBe(0.5);
    expect(load!.memPercent).toBe(50);
  });

  it("returns null when no UPTIME tag is found", () => {
    const raw = "some random output with no tags";
    const load = parseLoad(raw);
    expect(load).toBeNull();
  });
});

describe("cleanSshOutput — new strip patterns", () => {
  it("strips full prompt+command echo lines (e.g. [user@host dir]$ <cmd>)", () => {
    const raw = [
      "[jsmith_a@int01 ~]$ grep -c ERROR /apps_ux/RRS/logs/rrs.log",
      "[wwwsvr@int01 /apps_ux/RRS]$ tail -n 50 logs/rrs.log",
      "5",
      "ERROR something broke",
    ].join("\n");
    const cleaned = cleanSshOutput(raw);
    // Real output preserved
    expect(cleaned).toContain("5");
    expect(cleaned).toContain("ERROR something broke");
    // Prompt+command echo lines stripped
    expect(cleaned).not.toContain("grep -c ERROR /apps_ux/RRS/logs/rrs.log");
    expect(cleaned).not.toContain("tail -n 50 logs/rrs.log");
  });

  it("strips bare command echo-back lines from expect ($ grep …)", () => {
    const raw = [
      "$ grep ERROR /var/log/messages",
      "$ ls /apps_ux",
      "$ tail -n 100 something.log",
      "real output line",
    ].join("\n");
    const cleaned = cleanSshOutput(raw);
    expect(cleaned).toContain("real output line");
    expect(cleaned).not.toContain("$ grep ERROR");
    expect(cleaned).not.toContain("$ ls /apps_ux");
    expect(cleaned).not.toContain("$ tail -n 100");
  });

  it("does not strip lines that just contain a $ in normal output", () => {
    // Make sure the bare-command pattern is anchored and matches only the
    // specific allowlisted commands.
    const raw = [
      "Total cost: $50",
      "Variable: $PATH",
      "real output",
    ].join("\n");
    const cleaned = cleanSshOutput(raw);
    expect(cleaned).toContain("Total cost: $50");
    expect(cleaned).toContain("Variable: $PATH");
    expect(cleaned).toContain("real output");
  });
});

describe("parseDashboard — sawAnySection fallback", () => {
  const servers = ["int01", "test01", "prod01"];

  it("returns parsed empty result (not null) when section headers exist but content is empty", () => {
    const raw = [
      "DEPLOYMENT STATUS",
      "ERROR SUMMARY",
      "JVM HEAP",
    ].join("\n");
    const parsed = parseDashboard(raw, servers);
    expect(parsed).not.toBeNull();
    expect(parsed?.versions).toEqual([]);
    expect(parsed?.errors).toEqual([]);
    expect(parsed?.jvmHeap).toEqual([]);
  });

  it("returns null when no section headers are present at all", () => {
    const raw = "completely random output\nwith nothing recognizable";
    const parsed = parseDashboard(raw, servers);
    expect(parsed).toBeNull();
  });

  it("returns parsed result when sections have entries", () => {
    const raw = [
      "DEPLOYMENT STATUS",
      "  RRS/rrs-api               1.2.3                ",
      "ERROR SUMMARY",
      "  RRS/rrs-api               5                    ",
      "JVM HEAP",
      "  RRS/rrs-api               4096m                ",
    ].join("\n");
    const parsed = parseDashboard(raw, servers);
    expect(parsed).not.toBeNull();
  });
});
