import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEntry } from "@nrs/auth";
import { buildDiscoverCommand } from "../../commands/discover.js";
import { buildDashboardCommand } from "../../commands/dashboard.js";
import { buildDeployHistoryCommand } from "../../commands/deploys.js";
import { buildReadContextCommand } from "../../commands/pool-config.js";
import { buildTailCommand } from "../../commands/log-tail.js";
import { buildHeapCommand } from "../../commands/jvm-heap.js";
import { buildLogSearchCommand } from "../../commands/log-search.js";
import { diffConfig } from "../../commands/config-diff.js";
import { sshExec } from "../../ssh-client.js";

vi.mock("../../ssh-client.js", () => ({ sshExec: vi.fn() }));

const entry: ServerEntry = {
  name: "test", host: "test.example.internal", sshUser: "synthetic_a", sudoUser: "appuser",
  role: "TEST", description: "Synthetic fixture", appsBase: "/apps_ux", logsBase: "/apps_ux/logs",
};

const pathBuilders: Array<[string, (base: string) => string]> = [
  ["discover", (base) => buildDiscoverCommand(base)],
  ["dashboard apps", (base) => buildDashboardCommand(base, entry.logsBase)],
  ["dashboard logs", (base) => buildDashboardCommand(entry.appsBase, base)],
  ["deploy history", (base) => buildDeployHistoryCommand(base)],
  ["pool config", (base) => buildReadContextCommand(base, "RRS", "rrs-api")],
  ["log tail", (base) => buildTailCommand(base, "RRS", "rrs-api", "app", 20)],
];

describe.each(pathBuilders)("%s base path boundary", (_name, build) => {
  it.each(["/apps/$(printf INJECTED)", "/apps;printf INJECTED", "/apps/../etc", "/apps\n", "/apps with spaces"])("rejects %j before creating a command", (base) => {
    expect(() => build(base)).toThrow();
  });

  it("keeps valid deployment paths usable", () => {
    expect(build("/sw_ux/Tomcat-9.0_1/")).toContain("/sw_ux/Tomcat-9.0_1/");
  });
});

const identifierBuilders: Array<[string, (app: string, component: string) => string]> = [
  ["pool config", (app, component) => buildReadContextCommand(entry.appsBase, app, component)],
  ["log tail", (app, component) => buildTailCommand(entry.logsBase, app, component, "app", 20)],
  ["JVM heap", buildHeapCommand],
  ["log search", (app, component) => buildLogSearchCommand({
    logsBase: entry.logsBase, app, component, pattern: "ERROR", logType: "app", maxLines: 20, contextLines: 0,
  })],
];

describe.each(identifierBuilders)("%s identifier boundary", (_name, build) => {
  it.each(["$(printf INJECTED)", "x;printf INJECTED", "../etc", "x/y", "RRS\n", "x'quote"])("rejects %j in either path identifier", (value) => {
    expect(() => build(value, "rrs-api")).toThrow();
    expect(() => build("RRS", value)).toThrow();
  });

  it("preserves valid case, underscores, dots and hyphens", () => {
    expect(build("RRS_2", "rrs-api.v2")).toContain("RRS_2/rrs-api.v2");
  });

  it.each(["_api", "-api"])("preserves UI-supported leading punctuation in %j", (identifier) => {
    expect(build(identifier, "rrs-api")).toContain(`${identifier}/rrs-api`);
    expect(build("RRS", identifier)).toContain(`RRS/${identifier}`);
  });
});

const filterBuilders: Array<[string, (filter?: string) => string]> = [
  ["discover", (filter) => buildDiscoverCommand(entry.appsBase, filter)],
  ["dashboard", (filter) => buildDashboardCommand(entry.appsBase, entry.logsBase, filter)],
  ["deploy history", (filter) => buildDeployHistoryCommand(entry.appsBase, filter)],
];

describe.each(filterBuilders)("%s literal app filter", (_name, build) => {
  it.each(["RRS", "RRS.*", "$(printf INJECTED)", "`printf INJECTED`", 'x" ]; printf INJECTED; #', "O'Brien"])("compares %j literally without evaluating it", (filter) => {
    const clauses = build(filter).split("\n").filter((line) => line.includes('[ "$app" !='));
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) {
      // Exercise the actual comparison in a local loop with positional input.
      // Only shell builtins run; neither SSH nor a complete remote command runs.
      const script = `for app in "$1"; do\n${clause}\nprintf SELECTED\ndone`;
      expect(execFileSync("/bin/sh", ["-c", script, "filter-test", filter], { encoding: "utf8" })).toBe("SELECTED");
      expect(execFileSync("/bin/sh", ["-c", script, "filter-test", "OTHER_APP"], { encoding: "utf8" })).toBe("");
    }
  });

  it("retains no-filter behavior for omitted or empty values", () => {
    expect(build()).not.toContain('[ "$app" !=');
    expect(build("")).toBe(build());
  });
});

describe("config diff input boundaries", () => {
  beforeEach(() => {
    vi.mocked(sshExec).mockReset();
    vi.mocked(sshExec).mockResolvedValue({ stdout: "___BEGIN___\n<config/>\n___END___", stderr: "", exitCode: 0 });
  });

  it.each(["$(printf INJECTED)", "../etc", "x/y", "RRS\n"])("rejects %j identifiers before SSH", async (value) => {
    const entries = [entry, { ...entry, name: "other" }];
    await expect(diffConfig(entries, value, "rrs-api", "context.xml")).rejects.toThrow();
    await expect(diffConfig(entries, "RRS", value, "context.xml")).rejects.toThrow();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("rejects a malicious base on any entry before SSH", async () => {
    const entries = [entry, { ...entry, name: "other", appsBase: "/apps/$(printf INJECTED)" }];
    await expect(diffConfig(entries, "RRS", "rrs-api", "context.xml")).rejects.toThrow();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("still fetches and compares valid paths", async () => {
    const entries = [entry, { ...entry, name: "other" }];
    await expect(diffConfig(entries, "RRS", "rrs-api.v2", "context.xml")).resolves.toContain("identical context.xml");
    expect(sshExec).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sshExec).mock.calls[0][1]).toContain("/apps_ux/RRS/rrs-api.v2/current/webapps/rrs-api.v2/META-INF/context.xml");
  });

  it.each(["_api", "-api"])("compares existing paths with leading punctuation: %j", async (identifier) => {
    const entries = [entry, { ...entry, name: "other" }];
    await expect(diffConfig(entries, identifier, identifier, "context.xml")).resolves.toContain("identical context.xml");
    expect(vi.mocked(sshExec).mock.calls[0][1]).toContain(`/apps_ux/${identifier}/${identifier}/current/webapps/${identifier}/META-INF/context.xml`);
  });
});
