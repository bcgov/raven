import { describe, it, expect } from "vitest";
import { shouldLog } from "../src/lib/logger.js";

describe("shouldLog — LOG_LEVEL filter", () => {
  // Threshold ordering: DEBUG < INFO < WARN < ERROR
  // shouldLog(level, threshold) returns true iff severity(level) >= severity(threshold).

  it("at DEBUG threshold: all levels write", () => {
    expect(shouldLog("DEBUG", "DEBUG")).toBe(true);
    expect(shouldLog("INFO", "DEBUG")).toBe(true);
    expect(shouldLog("WARN", "DEBUG")).toBe(true);
    expect(shouldLog("ERROR", "DEBUG")).toBe(true);
  });

  it("at INFO threshold (default): DEBUG is filtered, others write", () => {
    expect(shouldLog("DEBUG", "INFO")).toBe(false);
    expect(shouldLog("INFO", "INFO")).toBe(true);
    expect(shouldLog("WARN", "INFO")).toBe(true);
    expect(shouldLog("ERROR", "INFO")).toBe(true);
  });

  it("at WARN threshold: only WARN and ERROR write", () => {
    expect(shouldLog("DEBUG", "WARN")).toBe(false);
    expect(shouldLog("INFO", "WARN")).toBe(false);
    expect(shouldLog("WARN", "WARN")).toBe(true);
    expect(shouldLog("ERROR", "WARN")).toBe(true);
  });

  it("at ERROR threshold: only ERROR writes", () => {
    expect(shouldLog("DEBUG", "ERROR")).toBe(false);
    expect(shouldLog("INFO", "ERROR")).toBe(false);
    expect(shouldLog("WARN", "ERROR")).toBe(false);
    expect(shouldLog("ERROR", "ERROR")).toBe(true);
  });

  it("ERROR is never filtered out at any threshold (transparency invariant)", () => {
    // Operationally, ERROR-level logs must always reach stderr regardless of
    // LOG_LEVEL — this is enforced separately in log() itself, but we confirm
    // here that even at the strictest threshold, shouldLog returns true.
    expect(shouldLog("ERROR", "ERROR")).toBe(true);
  });
});
