import { describe, it, expect } from "vitest";
import { classify, render, spliceRegion, validateInventoryMcpServers, START, END } from "./gen-inventory.lib.mjs";

describe("classify", () => {
  it("buckets tools by readOnlyHint and flags any without an explicit hint", () => {
    const { read, write, missing } = classify([
      { name: "a", annotations: { readOnlyHint: true } },
      { name: "b", annotations: { readOnlyHint: false } },
      { name: "c" },                       // no annotations
      { name: "d", annotations: {} },      // annotations but no hint
    ], "x");
    expect(read).toEqual(["a"]);
    expect(write).toEqual(["b"]);
    expect(missing).toEqual(["x/c", "x/d"]);
  });
});

describe("render", () => {
  const data = [
    { display: "Demo", pkg: "demo-mcp", mcpKey: "demo", group: "Group A", total: 2, read: ["r1"], write: ["w1"] },
    { display: "Solo", pkg: "solo-mcp", mcpKey: "solo", group: "Group A", total: 1, read: ["only"], write: [], note: "a note" },
  ];
  const out = render(data, {
    jarvis: { display: "Jarvis", mcpKey: "jarvis", read: 5, write: 1, total: 6 },
    jarvisSection: "### Remote proxy (data egress)\n\njarvis text",
    intro: "intro text",
    serverCount: 4,
  });

  it("pluralizes tool vs tools", () => {
    expect(out).toContain("#### solo-mcp — 1 tool (read-only)");
    expect(out).toContain("#### demo-mcp — 2 tools (1 read / 1 write)");
  });
  it("emits read/write bullets and bare read-only lists", () => {
    expect(out).toContain("- **Read:** `r1`");
    expect(out).toContain("- **Write:** `w1`");
    expect(out).toContain("`only`");
  });
  it("carries per-server notes through", () => {
    expect(out).toContain("> a note");
  });
  it("computes local subtotal and advertised totals incl. jarvis", () => {
    expect(out).toContain("| **Subtotal (local)** | | **2** | **1** | **3** |");
    expect(out).toContain("**~9**"); // 3 local + 6 jarvis = 9 advertised
    expect(out).toContain("| MCP servers | **4** |");
  });
});

describe("validateInventoryMcpServers", () => {
  const data = [{ mcpKey: "jira" }];
  const remoteIds = ["sysdig-secure-mcp"];
  const entries = {
    jira: { command: "node", args: ["./packages/jira-mcp/dist/index.js"] },
    jarvis: { command: "node", args: ["./packages/jarvis-mcp/dist/index.js"] },
    "sysdig-secure-mcp": { type: "http", url: "https://secure.sysdig.com/mcp/secure" },
  };
  it("counts exactly the configured local, proxy and approved remote entries", () => {
    expect(validateInventoryMcpServers(data, { mcpServers: entries }, "jarvis", remoteIds)).toBe(3);
  });
  it("rejects additions, omissions and changed remote configuration", () => {
    expect(() => validateInventoryMcpServers(data, { mcpServers: { ...entries, extra: {} } }, "jarvis", remoteIds)).toThrow(/inventory.*MCP/i);
    const { "sysdig-secure-mcp": _unused, ...withoutSysdig } = entries;
    expect(() => validateInventoryMcpServers(data, { mcpServers: withoutSysdig }, "jarvis", remoteIds)).toThrow(/inventory.*MCP/i);
    expect(() => validateInventoryMcpServers(data, {
      mcpServers: { ...entries, "sysdig-secure-mcp": { ...entries["sysdig-secure-mcp"], headers: {} } },
    }, "jarvis", remoteIds)).toThrow(/only "type": "http" and "url"/);
  });
});

describe("spliceRegion", () => {
  it("replaces only the content between the markers", () => {
    const out = spliceRegion(`top\n${START}\nOLD\n${END}\nbottom`, "NEW");
    expect(out).toBe(`top\n${START}\n\nNEW\n\n${END}\nbottom`);
    expect(out).toContain("top");
    expect(out).toContain("bottom");
    expect(out).not.toContain("OLD");
  });
  it("throws when the markers are absent (so CI fails loudly)", () => {
    expect(() => spliceRegion("no markers here", "x")).toThrow(/markers not found/);
  });
});
