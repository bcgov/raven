import { describe, it, expect } from "vitest";
import { parseVersionOutput, detectMismatches } from "../../commands/versions.js";

describe("parseVersionOutput", () => {
  it("parses pipe-delimited version lines", () => {
    const raw = "RRS|rrs-api|rrs-2.4.1|\nDMS|dms-document-api|dms-3.0.1|\n";
    const result = parseVersionOutput(raw);
    expect(result.get("RRS|rrs-api")).toBe("rrs-2.4.1");
    expect(result.get("DMS|dms-document-api")).toBe("dms-3.0.1");
  });

  it("returns empty map for blank input", () => {
    expect(parseVersionOutput("").size).toBe(0);
  });
});

describe("detectMismatches", () => {
  it("finds version mismatches across servers", () => {
    const serverData = new Map([
      ["int01", new Map([["RRS|rrs-api", "rrs-2.4.0"]])],
      ["prod01",   new Map([["RRS|rrs-api", "rrs-2.4.1"]])],
    ]);
    const mismatches = detectMismatches(serverData);
    expect(mismatches).toContain("RRS/rrs-api");
  });

  it("returns no mismatches when all versions match", () => {
    const serverData = new Map([
      ["int01", new Map([["RRS|rrs-api", "rrs-2.4.1"]])],
      ["prod01",   new Map([["RRS|rrs-api", "rrs-2.4.1"]])],
    ]);
    expect(detectMismatches(serverData)).toHaveLength(0);
  });

  it("ignores missing entries (—) in mismatch check", () => {
    const serverData = new Map([
      ["int01", new Map([["RRS|rrs-api", "rrs-2.4.1"]])],
      ["test01",   new Map<string, string>()],
    ]);
    expect(detectMismatches(serverData)).toHaveLength(0);
  });
});
