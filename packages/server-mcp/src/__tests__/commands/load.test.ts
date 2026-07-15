import { describe, it, expect } from "vitest";
import { parseLoadOutput } from "../../commands/load.js";

const SAMPLE_OUTPUT = [
  "UPTIME: 5 days, 12:34",
  "LOAD: 0.42 0.58 0.61",
  "MEM: 16384 12288 (75.0%)",
  "DISK: /dev/sda1 | 100G | 60G | 40G | 60% | /",
  "DISK: /dev/sdb1 | 500G | 100G | 400G | 20% | /apps_ux",
].join("\n");

describe("parseLoadOutput", () => {
  it("parses a well-formed sample", () => {
    const data = parseLoadOutput(SAMPLE_OUTPUT);
    expect(data).not.toBeNull();
    expect(data!.uptime).toBe("5 days, 12:34");
    expect(data!.load1).toBe(0.42);
    expect(data!.load5).toBe(0.58);
    expect(data!.load15).toBe(0.61);
    expect(data!.memTotalMb).toBe(16384);
    expect(data!.memUsedMb).toBe(12288);
    expect(data!.memPercent).toBe(75);
    expect(data!.disks).toHaveLength(2);
    expect(data!.disks[0]).toEqual({
      filesystem: "/dev/sda1",
      size: "100G",
      used: "60G",
      available: "40G",
      usePercent: "60%",
      mountpoint: "/",
    });
    expect(data!.disks[1]!.mountpoint).toBe("/apps_ux");
  });

  it("returns null when UPTIME is absent", () => {
    expect(parseLoadOutput("LOAD: 0.1 0.2 0.3")).toBeNull();
    expect(parseLoadOutput("")).toBeNull();
  });

  it("defaults LOAD and MEM to 0 when their lines are missing", () => {
    const data = parseLoadOutput("UPTIME: 1 day, 0:01");
    expect(data!.load1).toBe(0);
    expect(data!.memTotalMb).toBe(0);
    expect(data!.memPercent).toBe(0);
    expect(data!.disks).toEqual([]);
  });

  it("skips malformed DISK lines (too few fields)", () => {
    const data = parseLoadOutput([
      "UPTIME: 1 day",
      "DISK: /dev/sda1 | 100G | 60G",       // only 3 fields
      "DISK: /dev/sdb1 | 200G | 100G | 100G | 50% | /data", // valid
    ].join("\n"));
    expect(data!.disks).toHaveLength(1);
    expect(data!.disks[0]!.mountpoint).toBe("/data");
  });

  it("skips DISK lines with empty fields", () => {
    const data = parseLoadOutput([
      "UPTIME: 1 day",
      "DISK: /dev/sda1 |  | 60G | 40G | 60% | /",  // empty size
    ].join("\n"));
    expect(data!.disks).toEqual([]);
  });

  it("handles pathological whitespace input without backtracking blowup", () => {
    // The old regex form was O(n²) on inputs like this. This test would have
    // timed out under the previous implementation for n in the millions; for
    // n=200k it should complete in well under a second now.
    const pathological = "UPTIME: " + " ".repeat(200_000) + "\nDISK: " + " ".repeat(200_000);
    const start = Date.now();
    const data = parseLoadOutput(pathological);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(data).not.toBeNull();
    expect(data!.disks).toEqual([]);
  });
});
