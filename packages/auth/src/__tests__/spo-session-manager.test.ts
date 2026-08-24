import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpoSessionManager } from "../spo-session-manager.js";
import { writeCachedSpoSession, readCachedSpoSession } from "../spo-cookie-cache.js";

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spo-sm-"));
  cachePath = join(dir, "spo-session.json");
  delete process.env["SPO_FEDAUTH"];
  delete process.env["SPO_RTFA"];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env["SPO_FEDAUTH"];
  delete process.env["SPO_RTFA"];
});

describe("SpoSessionManager", () => {
  it("uses the disk cache when present", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const sm = new SpoSessionManager({ cachePath });
    expect(await sm.getSession()).toEqual({ fedAuth: "fa", rtFa: "rt" });
  });

  it("uses SPO_FEDAUTH/SPO_RTFA env vars and writes them through to the cache", async () => {
    process.env["SPO_FEDAUTH"] = "env-fa";
    process.env["SPO_RTFA"] = "env-rt";
    const sm = new SpoSessionManager({ cachePath });
    expect(await sm.getSession()).toEqual({ fedAuth: "env-fa", rtFa: "env-rt" });
    expect(await readCachedSpoSession(cachePath)).toEqual({ fedAuth: "env-fa", rtFa: "env-rt" });
  });

  it("ignores an incomplete env pair (only SPO_FEDAUTH set)", async () => {
    process.env["SPO_FEDAUTH"] = "env-fa";
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const sm = new SpoSessionManager({ cachePath });
    // Disk cache is checked before env vars; the incomplete env pair must
    // not shadow it (and would be skipped even without a cache).
    expect(await sm.getSession()).toEqual({ fedAuth: "fa", rtFa: "rt" });
  });

  it("returns the in-memory pair on repeat calls without re-reading disk", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const sm = new SpoSessionManager({ cachePath });
    await sm.getSession();
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(cachePath);
    expect(await sm.getSession()).toEqual({ fedAuth: "fa", rtFa: "rt" });
  });

  it("invalidate clears memory and disk", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const sm = new SpoSessionManager({ cachePath });
    await sm.getSession();
    await sm.invalidate();
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("exposes targetUrl and a browser user agent", () => {
    const sm = new SpoSessionManager({ cachePath, targetUrl: "https://example.sharepoint.com" });
    expect(sm.targetUrl).toBe("https://example.sharepoint.com");
    expect(sm.userAgent).toContain("Mozilla/5.0");
  });
});
