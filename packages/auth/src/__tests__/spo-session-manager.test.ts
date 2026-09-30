import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpoSessionManager } from "../spo-session-manager.js";

// A wrong implementation must fail the test, not open a real browser.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("a browser capture must not be launched in this test");
  }),
}));
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

  it("adopts the login another process finishes while waiting for the shared profile lock", async () => {
    // SharePoint and SiteMinder captures share one Chromium profile, so they
    // share one lock too; the waiter reuses the winner's cookies.
    const lockPath = join(dir, "browser-profile.lock");
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "sibling" }));
    const sibling = new Promise<void>((resolve) =>
      setTimeout(async () => {
        await writeCachedSpoSession(cachePath, { fedAuth: "sibling-fa", rtFa: "sibling-rt" }, "example.sharepoint.com");
        await unlink(lockPath);
        resolve();
      }, 80)
    );

    const sm = new SpoSessionManager({ cachePath, lockPath });
    await expect(sm.authenticate()).resolves.toEqual({ fedAuth: "sibling-fa", rtFa: "sibling-rt" });
    await sibling;

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("exposes targetUrl and a browser user agent", () => {
    const sm = new SpoSessionManager({ cachePath, targetUrl: "https://example.sharepoint.com" });
    expect(sm.targetUrl).toBe("https://example.sharepoint.com");
    expect(sm.userAgent).toContain("Mozilla/5.0");
  });
});
