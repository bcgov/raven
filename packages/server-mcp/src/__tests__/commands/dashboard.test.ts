import { describe, it, expect } from "vitest";
import { parseDashboardOutput } from "../../commands/dashboard.js";

describe("parseDashboardOutput", () => {
  it("parses VER, ERR, and JVM tagged lines", () => {
    const raw = [
      "VER:RRS|rrs-api|rrs-2.4.1",
      "VER:DMS|dms-document-api|dms-3.0.1",
      "ERR:RRS|rrs-api|47",
      "ERR:DMS|dms-document-api|0",
      "JVM:RRS|rrs-api|512m",
    ].join("\n");

    const result = parseDashboardOutput(raw);
    expect(result.versions.get("RRS|rrs-api")).toBe("rrs-2.4.1");
    expect(result.errors.get("RRS|rrs-api")).toBe(47);
    expect(result.errors.get("DMS|dms-document-api")).toBe(0);
    expect(result.jvm.get("RRS|rrs-api")).toBe("512m");
  });

  it("handles empty output", () => {
    const result = parseDashboardOutput("");
    expect(result.versions.size).toBe(0);
    expect(result.errors.size).toBe(0);
    expect(result.jvm.size).toBe(0);
  });
});
