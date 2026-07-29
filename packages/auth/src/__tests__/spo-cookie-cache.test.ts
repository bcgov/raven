import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCachedSpoSession,
  writeCachedSpoSession,
  clearCachedSpoSession,
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

  it("writes the cache file with mode 0600", async () => {
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
});
