import { describe, expect, it } from "vitest";
import { resolveSysdigMcpUrl } from "../config.js";

describe("resolveSysdigMcpUrl", () => {
  it("defaults to the documented US East hosted MCP endpoint", () => {
    expect(resolveSysdigMcpUrl({}).toString()).toBe("https://secure.sysdig.com/mcp/secure");
  });

  it("accepts another regional Sysdig endpoint", () => {
    expect(
      resolveSysdigMcpUrl({ SYSDIG_SECURE_MCP_URL: "https://eu1.app.sysdig.com/mcp/secure/" }).toString(),
    ).toBe("https://eu1.app.sysdig.com/mcp/secure");
  });

  it.each([
    "http://secure.sysdig.com/mcp/secure",
    "https://attacker.example/mcp/secure",
    "https://secure.sysdig.com/mcp/other",
    "https://user:password@secure.sysdig.com/mcp/secure",
    "https://secure.sysdig.com/mcp/secure?token=not-allowed",
  ])("rejects an unsafe URL: %s", (value) => {
    expect(() => resolveSysdigMcpUrl({ SYSDIG_SECURE_MCP_URL: value })).toThrow(
      /regional Sysdig HTTPS/,
    );
  });
});
