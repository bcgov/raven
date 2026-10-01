import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_TIMINGS } from "../capture-script.js";
import { SpoSessionManager } from "../spo-session-manager.js";

const home = vi.hoisted(() => ({ dir: "" }));

// authenticate() creates the browser-profile directory under the home
// directory; point it at this test's temp directory so the real
// ~/.workflow-suite is never touched.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

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
  home.dir = dir;
  cachePath = join(dir, "spo-session.json");
  delete process.env["SPO_FEDAUTH"];
  delete process.env["SPO_RTFA"];
  vi.mocked(execFileSync).mockClear();
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

  it("invalidate(failedPair) keeps a fresher pair another process cached, and getSession then adopts it without a browser", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa1", rtFa: "rt1" }, "example.sharepoint.com");
    const sm = new SpoSessionManager({ cachePath });
    expect(await sm.getSession()).toEqual({ fedAuth: "fa1", rtFa: "rt1" });
    await writeCachedSpoSession(cachePath, { fedAuth: "fa2", rtFa: "rt2" }, "example.sharepoint.com");

    await sm.invalidate({ fedAuth: "fa1", rtFa: "rt1" });

    expect(await sm.getSession()).toEqual({ fedAuth: "fa2", rtFa: "rt2" });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("invalidate(failedPair) still removes the cache when it holds the pair that failed", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa1", rtFa: "rt1" }, "example.sharepoint.com");
    const sm = new SpoSessionManager({ cachePath });
    await sm.getSession();

    await sm.invalidate({ fedAuth: "fa1", rtFa: "rt1" });

    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  describe("authenticate", () => {
    const captured = JSON.stringify({ status: "ok", cookies: { FedAuth: "fa", rtFa: "rt" } });

    it("returns a verified capture even when it cannot be cached, and keeps using it in this process", async () => {
      const blocker = join(dir, "not-a-directory");
      await writeFile(blocker, "");
      const sm = new SpoSessionManager({
        cachePath: join(blocker, "spo-session.json"),
        lockPath: join(dir, "browser-profile.lock"),
      });
      vi.mocked(execFileSync).mockReturnValueOnce(captured);

      await expect(sm.authenticate()).resolves.toEqual({ fedAuth: "fa", rtFa: "rt" });
      await expect(sm.getSession()).resolves.toEqual({ fedAuth: "fa", rtFa: "rt" });
      expect(execFileSync).toHaveBeenCalledTimes(1);
    });

    const manager = () => new SpoSessionManager({ cachePath, lockPath: join(dir, "browser-profile.lock") });

    it("asks the capture for both SharePoint cookies, only from sharepoint.com, and does not probe", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(captured);
      await manager().authenticate();

      const script = (vi.mocked(execFileSync).mock.calls[0][1] as string[])[1];
      expect(script).toContain(`const wanted = ${JSON.stringify(["FedAuth", "rtFa"])}`);
      expect(script).toContain(`const domainFilter = ${JSON.stringify("sharepoint.com")}`);
      expect(script).toContain("const verifyUrl = null");
    });

    it("caches a successful capture with the tenant host, so later calls and sibling servers reuse it", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(captured);
      await manager().authenticate();

      expect(await readCachedSpoSession(cachePath)).toEqual({ fedAuth: "fa", rtFa: "rt" });
      expect(JSON.parse(await readFile(cachePath, "utf-8")).capturedFor).toBe("example.sharepoint.com");
    });

    it.each([
      ["FedAuth is missing", { status: "ok", cookies: { rtFa: "rt" } }],
      ["rtFa is missing", { status: "ok", cookies: { FedAuth: "fa" } }],
      ["a cookie is empty", { status: "ok", cookies: { FedAuth: "fa", rtFa: "" } }],
    ])("rejects a capture result where %s, and caches nothing", async (_name, result) => {
      vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(result));

      await expect(manager().authenticate()).rejects.toThrow(/No valid SharePoint session found/);
      expect(existsSync(cachePath)).toBe(false);
    });

    it("passes the capture script's own error message through", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        JSON.stringify({ status: "error", message: "Cookies not captured within 180s: FedAuth, rtFa" })
      );

      await expect(manager().authenticate()).rejects.toThrow(/Browser auth failed: Cookies not captured within 180s: FedAuth, rtFa/);
    });

    describe("after a failed browser login", () => {
      const lockPath = () => join(dir, "browser-profile.lock");
      const memoFile = () => `${lockPath()}.sharepoint-failed`;
      const failCapture = () =>
        vi.mocked(execFileSync).mockImplementation(() => JSON.stringify({ status: "error", message: "window closed" }));

      it("makes the next caller fail fast with the earlier reason instead of opening another login", async () => {
        failCapture();
        await expect(manager().authenticate()).rejects.toThrow(/window closed/);

        await expect(manager().authenticate()).rejects.toThrow(
          /No valid SharePoint session found\. Browser auth failed: A browser login just failed .*window closed/
        );
        expect(execFileSync).toHaveBeenCalledTimes(1);
      });

      it("lets one of N concurrent callers open the login and fails the rest fast", async () => {
        failCapture();
        const outcomes = await Promise.allSettled([1, 2, 3].map(() => manager().authenticate()));

        expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
        expect(execFileSync).toHaveBeenCalledTimes(1);
      });

      it("forgets the failure after a successful login, and tries again once the cooldown has passed", async () => {
        await writeFile(memoFile(), JSON.stringify({ at: Date.now() - 120_000, message: "old failure" }));
        vi.mocked(execFileSync).mockReturnValueOnce(captured);

        await manager().authenticate();

        expect(existsSync(memoFile())).toBe(false);
      });

      it("is cleared by invalidate() with no argument but not by invalidate(pair)", async () => {
        failCapture();
        await expect(manager().authenticate()).rejects.toThrow();

        await manager().invalidate({ fedAuth: "x", rtFa: "y" });
        expect(existsSync(memoFile())).toBe(true);

        await manager().invalidate();
        expect(existsSync(memoFile())).toBe(false);
      });

      it("does not let a failed SiteMinder login block a SharePoint one", async () => {
        await writeFile(`${lockPath()}.siteminder-failed`, JSON.stringify({ at: Date.now(), message: "siteminder failed" }));
        vi.mocked(execFileSync).mockReturnValueOnce(captured);

        await expect(manager().authenticate()).resolves.toEqual({ fedAuth: "fa", rtFa: "rt" });
      });
    });

    it("takes the same shared browser-profile lock by default as the SiteMinder capture", async () => {
      const lockFile = join(dir, ".workflow-suite", "browser-profile.lock");
      let heldDuringCapture = false;
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        heldDuringCapture = existsSync(lockFile);
        return captured;
      });

      await new SpoSessionManager({ cachePath }).authenticate();

      expect(heldDuringCapture).toBe(true);
      expect(existsSync(lockFile)).toBe(false);
    });

    it("uses the shared capture timings, so the script's own budgets always end before the process is killed", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(captured);
      await new SpoSessionManager({ cachePath, lockPath: join(dir, "browser-profile.lock") }).authenticate();

      const [, args, options] = vi.mocked(execFileSync).mock.calls[0];
      const timings = CAPTURE_TIMINGS.sharePoint;
      expect((options as unknown as { timeout: number }).timeout).toBe(timings.processTimeoutMs);
      expect((args as string[])[1]).toContain(`timeout: ${timings.navTimeoutMs} }`);
      expect((args as string[])[1]).toContain(`within ${timings.pollBudgetMs / 1000}s`);
    });

    it("surfaces what the capture child actually wrote to stderr, not the command line that embeds the script", async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: /usr/bin/node -e \nSCRIPT-BODY"), {
          stderr: "Error: Cannot find module 'playwright'\n    at x",
        });
      });

      const failure = await new SpoSessionManager({ cachePath, lockPath: join(dir, "browser-profile.lock") })
        .authenticate()
        .then(
          () => undefined,
          (err: Error) => err
        );

      expect(failure?.message).toMatch(/No valid SharePoint session found\. Browser auth failed: Error: Cannot find module 'playwright'/);
      expect(failure?.message).not.toContain("SCRIPT-BODY");
    });

    it("reports a lock timeout in the standard 'No valid SharePoint session found' form", async () => {
      const lockPath = join(dir, "browser-profile.lock");
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "sibling" }));
      const sm = new SpoSessionManager({ cachePath, lockPath, lockOptions: { waitMs: 100, pollMs: 10 } });

      await expect(sm.authenticate()).rejects.toThrow(
        /No valid SharePoint session found\. Browser auth failed: Timed out waiting for another RAVEN process/
      );
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it("keeps Playwright's debug variables out of the capture child's environment", async () => {
      // DEBUG=pw:api makes Playwright log every call's arguments, including a typed password.
      const saved = { DEBUG: process.env["DEBUG"], PWDEBUG: process.env["PWDEBUG"] };
      process.env["DEBUG"] = "pw:api";
      process.env["PWDEBUG"] = "1";
      try {
        vi.mocked(execFileSync).mockReturnValueOnce(captured);
        await new SpoSessionManager({ cachePath, lockPath: join(dir, "browser-profile.lock") }).authenticate();

        const options = vi.mocked(execFileSync).mock.calls[0][2] as { env: Record<string, string | undefined>; maxBuffer: number };
        expect(options.env["DEBUG"]).toBeUndefined();
        expect(options.env["PWDEBUG"]).toBeUndefined();
        expect(options.maxBuffer).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  it("exposes targetUrl and a browser user agent", () => {
    const sm = new SpoSessionManager({ cachePath, targetUrl: "https://example.sharepoint.com" });
    expect(sm.targetUrl).toBe("https://example.sharepoint.com");
    expect(sm.userAgent).toContain("Mozilla/5.0");
  });
});
