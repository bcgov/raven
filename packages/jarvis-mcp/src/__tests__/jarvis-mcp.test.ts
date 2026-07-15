import { describe, it, expect } from "vitest";
import { resolveJarvisBaseUrl, DEFAULT_JARVIS_BASE_URL } from "../config.js";

describe("resolveJarvisBaseUrl", () => {
  it("falls back to the default Jarvis endpoint with /mcp when JARVIS_BASE_URL is unset", () => {
    expect(resolveJarvisBaseUrl({})).toBe(`${DEFAULT_JARVIS_BASE_URL}/mcp`);
  });

  it("uses JARVIS_BASE_URL when provided and appends /mcp internally", () => {
    const custom = "https://jarvis.example.test";
    expect(resolveJarvisBaseUrl({ JARVIS_BASE_URL: custom })).toBe("https://jarvis.example.test/mcp");
  });

  it("handles when JARVIS_BASE_URL already contains /mcp without duplicating it", () => {
    const custom = "https://jarvis.example.test/mcp/";
    expect(resolveJarvisBaseUrl({ JARVIS_BASE_URL: custom })).toBe("https://jarvis.example.test/mcp");
  });

  it("falls back to the default when JARVIS_BASE_URL is an empty string", () => {
    expect(resolveJarvisBaseUrl({ JARVIS_BASE_URL: "" })).toBe(`${DEFAULT_JARVIS_BASE_URL}/mcp`);
  });
});
