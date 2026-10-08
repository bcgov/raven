import { describe, it, expect } from "vitest";
import { resolveJarvisBaseUrl } from "../config.js";

describe("resolveJarvisBaseUrl", () => {
  it("requires a configured Jarvis base URL", () => {
    expect(() => resolveJarvisBaseUrl({})).toThrow(/JARVIS_BASE_URL is required/);
    expect(() => resolveJarvisBaseUrl({ JARVIS_TOKEN: "token", JARVIS_BASE_URL: "   " }))
      .toThrow(/JARVIS_BASE_URL is required/);
  });

  it("uses JARVIS_BASE_URL when provided and appends /mcp internally", () => {
    const custom = "https://jarvis.example.test";
    expect(resolveJarvisBaseUrl({ JARVIS_BASE_URL: custom })).toBe("https://jarvis.example.test/mcp");
  });

  it("handles when JARVIS_BASE_URL already contains /mcp without duplicating it", () => {
    const custom = "https://jarvis.example.test/mcp/";
    expect(resolveJarvisBaseUrl({ JARVIS_BASE_URL: custom })).toBe("https://jarvis.example.test/mcp");
  });

  it("rejects an empty Jarvis base URL", () => {
    expect(() => resolveJarvisBaseUrl({ JARVIS_BASE_URL: "" })).toThrow(/JARVIS_BASE_URL is required/);
  });
});
