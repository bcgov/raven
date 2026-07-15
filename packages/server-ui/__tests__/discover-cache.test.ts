import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCache,
  writeCache,
  upsertServer,
  type CachedServer,
} from "../src/lib/discover-cache.js";

let tempDir: string;
let cacheFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "raven-cache-"));
  cacheFile = join(tempDir, "discover.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("readCache", () => {
  it("returns empty array when the file does not exist", () => {
    expect(readCache(cacheFile)).toEqual([]);
  });

  it("returns empty array when the file is corrupt JSON", () => {
    writeFileSync(cacheFile, "{not valid json", "utf-8");
    expect(readCache(cacheFile)).toEqual([]);
  });

  it("returns empty array when the file contains a non-array (defensive)", () => {
    writeFileSync(cacheFile, JSON.stringify({ servers: [] }), "utf-8");
    expect(readCache(cacheFile)).toEqual([]);
  });

  it("returns the parsed array when the file is valid", () => {
    const data: CachedServer[] = [
      {
        server: "int01",
        apps: [{ app: "RRS", component: "rrs-api", version: "1.2.3", port: "8080" }],
        discoveredAt: "2026-05-04T20:00:00.000Z",
      },
    ];
    writeFileSync(cacheFile, JSON.stringify(data), "utf-8");
    expect(readCache(cacheFile)).toEqual(data);
  });
});

describe("writeCache", () => {
  it("creates the parent directory if it doesn't exist", () => {
    const nestedFile = join(tempDir, "nested", "deep", "discover.json");
    writeCache([], nestedFile);
    expect(readCache(nestedFile)).toEqual([]);
  });

  it("round-trips data through readCache", () => {
    const data: CachedServer[] = [
      {
        server: "test01",
        apps: [{ app: "RRS", component: "rrs-api", version: "2.0.0", port: "8080" }],
        discoveredAt: "2026-05-04T20:00:00.000Z",
      },
    ];
    writeCache(data, cacheFile);
    expect(readCache(cacheFile)).toEqual(data);
  });

  it("overwrites previous content", () => {
    writeCache(
      [{ server: "old", apps: [], discoveredAt: "2020-01-01T00:00:00.000Z" }],
      cacheFile,
    );
    writeCache(
      [{ server: "new", apps: [], discoveredAt: "2026-05-04T20:00:00.000Z" }],
      cacheFile,
    );
    const result = readCache(cacheFile);
    expect(result).toHaveLength(1);
    expect(result[0].server).toBe("new");
  });

  it("writes atomically — leaves no temp file behind on success", () => {
    writeCache(
      [{ server: "int01", apps: [], discoveredAt: "2026-05-04T20:00:00.000Z" }],
      cacheFile,
    );
    expect(existsSync(cacheFile)).toBe(true);
    // No .tmp.* siblings should remain after a successful write.
    const siblings = readdirSync(tempDir).filter((f) => f.startsWith("discover.json.tmp."));
    expect(siblings).toEqual([]);
  });

  it("preserves the previous cache when the new write fails (atomicity)", () => {
    // Seed a valid cache.
    writeCache(
      [{ server: "test01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" }],
      cacheFile,
    );
    // Force a write failure by passing a path inside a non-existent file
    // (mkdirSync is recursive, so use a path under an actual file to trigger ENOTDIR).
    const blockingFile = join(tempDir, "blocker");
    writeFileSync(blockingFile, "not a directory", "utf-8");
    const badPath = join(blockingFile, "deeper", "discover.json");
    expect(() => writeCache([{ server: "junk", apps: [], discoveredAt: "x" }], badPath)).toThrow();
    // Original cache is intact.
    expect(readCache(cacheFile)).toEqual([
      { server: "test01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("upsertServer", () => {
  const APP_ENTRY = { app: "RRS", component: "rrs-api", version: "1.0.0", port: "8080" };

  it("adds a new server when the cache is empty", () => {
    const result = upsertServer([], "int01", [APP_ENTRY], "2026-05-04T20:00:00.000Z");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      server: "int01",
      apps: [APP_ENTRY],
      discoveredAt: "2026-05-04T20:00:00.000Z",
    });
  });

  it("replaces an existing server entry, keeping others intact", () => {
    const initial: CachedServer[] = [
      { server: "test01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" },
      { server: "int01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" },
    ];
    const result = upsertServer(initial, "int01", [APP_ENTRY], "2026-05-04T20:00:00.000Z");
    expect(result).toHaveLength(2);
    const int01 = result.find((s) => s.server === "int01");
    expect(int01?.apps).toEqual([APP_ENTRY]);
    expect(int01?.discoveredAt).toBe("2026-05-04T20:00:00.000Z");
    // Test01 preserved
    expect(result.find((s) => s.server === "test01")?.discoveredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns the cache sorted by server name", () => {
    const initial: CachedServer[] = [
      { server: "prod01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" },
      { server: "test01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" },
    ];
    const result = upsertServer(initial, "int01", [], "2026-05-04T20:00:00.000Z");
    expect(result.map((s) => s.server)).toEqual(["int01", "prod01", "test01"]);
  });

  it("does not mutate the input array", () => {
    const initial: CachedServer[] = [
      { server: "test01", apps: [], discoveredAt: "2026-01-01T00:00:00.000Z" },
    ];
    upsertServer(initial, "int01", [], "2026-05-04T20:00:00.000Z");
    expect(initial).toHaveLength(1);
    expect(initial[0].server).toBe("test01");
  });
});
