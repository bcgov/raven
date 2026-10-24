import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { filterReadOnlyTools, isReadOnlyTool } from "../read-only.js";

const tool = (
  name: string,
  readOnlyHint?: boolean,
): Tool => ({
  name,
  inputSchema: { type: "object" },
  ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
});

describe("read-only Sysdig tool policy", () => {
  it("includes tools explicitly marked read-only", () => {
    expect(isReadOnlyTool(tool("unknown_read", true))).toBe(true);
  });

  it("excludes tools explicitly marked as mutating, even if named in the read-only allowlist", () => {
    expect(isReadOnlyTool(tool("list_zones", false))).toBe(false);
  });

  it("allows only the reviewed fallback names when no read-only annotation is present", () => {
    expect(isReadOnlyTool(tool("list_runtime_events"))).toBe(true);
    expect(isReadOnlyTool(tool("save_skill_state"))).toBe(false);
    expect(isReadOnlyTool(tool("unknown_tool"))).toBe(false);
  });

  it("filters write-capable and unclassified tools from the advertised catalog", () => {
    expect(filterReadOnlyTools([
      tool("get_customer_settings"),
      tool("save_skill_state"),
      tool("arbitrary_tool", false),
      tool("new_read_only_tool", true),
    ]).map(({ name }) => name)).toEqual(["get_customer_settings", "new_read_only_tool"]);
  });
});
