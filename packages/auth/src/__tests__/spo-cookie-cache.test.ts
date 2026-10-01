import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCachedSpoSession,
  writeCachedSpoSession,
  clearCachedSpoSession,
  clearCachedSpoSessionIf,
} from "../spo-cookie-cache.js";

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spo-cache-"));
  cachePath = join(dir, "spo-session.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("spo cookie cache", () => {
  it("returns null when the cache file does not exist", async () => {
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("round-trips a cookie pair", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const got = await readCachedSpoSession(cachePath);
    expect(got).toEqual({ fedAuth: "fa", rtFa: "rt" });
  });

  it("returns null when the entry is older than the TTL", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    expect(await readCachedSpoSession(cachePath, 0)).toBeNull();
  });

  it("returns null when either cookie is missing from the file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({ fedAuth: "fa", cachedAt: Date.now(), capturedFor: "x" })
    );
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("returns null on corrupt JSON instead of throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cachePath, "not json");
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("returns null when cachedAt is missing (NaN age must not bypass the TTL)", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({ fedAuth: "fa", rtFa: "rt", capturedFor: "x" })
    );
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("returns null when cachedAt is not a finite number", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({ fedAuth: "fa", rtFa: "rt", cachedAt: "garbage", capturedFor: "x" })
    );
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("writes the cache file with mode 0600", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const st = await stat(cachePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("records capturedFor in the file", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const raw = JSON.parse(await readFile(cachePath, "utf-8"));
    expect(raw.capturedFor).toBe("example.sharepoint.com");
  });

  it("clear removes the file and is a no-op when absent", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    await clearCachedSpoSession(cachePath);
    expect(await readCachedSpoSession(cachePath)).toBeNull();
    await clearCachedSpoSession(cachePath); // second call must not throw
  });

  it("replaces the file without leaving temporary files behind", async () => {
    // Shares the atomic helper with the SiteMinder cache, so a sibling process
    // never reads a truncated file while this one is writing.
    await writeCachedSpoSession(cachePath, { fedAuth: "fa1", rtFa: "rt1" }, "example.sharepoint.com");
    await writeCachedSpoSession(cachePath, { fedAuth: "fa2", rtFa: "rt2" }, "example.sharepoint.com");

    expect(await readdir(dir)).toEqual(["spo-session.json"]);
    expect(await readCachedSpoSession(cachePath)).toEqual({ fedAuth: "fa2", rtFa: "rt2" });
  });
});

describe("clearCachedSpoSessionIf", () => {
  const pair = (n: number) => ({ fedAuth: `fa${n}`, rtFa: `rt${n}` });

  it("removes the cache when it still holds the pair that just failed", async () => {
    await writeCachedSpoSession(cachePath, pair(1), "example.sharepoint.com");
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("keeps a fresher pair another process cached in the meantime", async () => {
    await writeCachedSpoSession(cachePath, pair(2), "example.sharepoint.com");
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
    expect(await readCachedSpoSession(cachePath)).toEqual(pair(2));
  });

  it("treats a pair as different when only one cookie matches", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa1", rtFa: "rt-new" }, "example.sharepoint.com");
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
  });

  it("leaves an unparseable file alone", async () => {
    await writeFile(cachePath, '{"fedAuth": "fa');
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
    expect(await readFile(cachePath, "utf-8")).toBe('{"fedAuth": "fa');
  });

  it("does not throw on valid JSON that is not a cache record, and removes it as unusable", async () => {
    await writeFile(cachePath, "null");
    await expect(clearCachedSpoSessionIf(cachePath, pair(1))).resolves.toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("is a no-op when there is no cache file", async () => {
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
  });
});
