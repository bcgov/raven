import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_USER_AGENT } from "../browser-ua.js";
import { CAPTURE_TIMINGS, authProfileDir, buildCaptureScript } from "../capture-script.js";
import { SpoSessionManager } from "../spo-session-manager.js";

const home = vi.hoisted(() => ({ dir: "" }));

// authenticate() creates the browser-profile directory under the home
// directory; point it at this test's temp directory so the real
// ~/.workflow-suite is never touched.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

// The real builder, wrapped so a test can read the options the manager gave it
// instead of searching the generated script for them.
vi.mock("../capture-script.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture-script.js")>();
  return { ...actual, buildCaptureScript: vi.fn(actual.buildCaptureScript) };
});

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
  vi.mocked(buildCaptureScript).mockClear();
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

  it("ignores an env pair whose values are blank, instead of caching and sending it", async () => {
    process.env["SPO_FEDAUTH"] = "  ";
    process.env["SPO_RTFA"] = "\t";
    const sm = new SpoSessionManager({ cachePath, lockPath: join(dir, "browser-profile.lock") });

    // No usable env pair and no cache: it goes on to the (stubbed, failing) browser login.
    await expect(sm.getSession()).rejects.toThrow(/No valid SharePoint session found/);
    expect(existsSync(cachePath)).toBe(false);
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

  describe("what invalidate reports", () => {
    // Will the pair that just failed be handed out again? Removing it and a newer
    // login replacing it both mean no.
    const cannotForceDeleteFailure = process.platform === "win32" || process.getuid?.() === 0;
    const failed = { fedAuth: "fa1", rtFa: "rt1" };

    it("true when it removed the pair", async () => {
      await writeCachedSpoSession(cachePath, failed, "example.sharepoint.com");
      await expect(new SpoSessionManager({ cachePath }).invalidate(failed)).resolves.toBe(true);
    });

    it("true when a newer pair replaced it, which is kept", async () => {
      await writeCachedSpoSession(cachePath, { fedAuth: "fa2", rtFa: "rt2" }, "example.sharepoint.com");
      await expect(new SpoSessionManager({ cachePath }).invalidate(failed)).resolves.toBe(true);
      expect(await readCachedSpoSession(cachePath)).toEqual({ fedAuth: "fa2", rtFa: "rt2" });
    });

    it.skipIf(cannotForceDeleteFailure)("false when the cache holds the failed pair and cannot be removed", async () => {
      await writeCachedSpoSession(cachePath, failed, "example.sharepoint.com");
      await chmod(dir, 0o500);
      try {
        await expect(new SpoSessionManager({ cachePath }).invalidate(failed)).resolves.toBe(false);
      } finally {
        await chmod(dir, 0o700);
      }
      expect(await readCachedSpoSession(cachePath)).toEqual(failed);
    });
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

    // The target is pinned: left to the environment, a SHAREPOINT_URL exported on the
    // machine running the tests would change what they expect.
    const TARGET = "https://example.sharepoint.com";
    const manager = () =>
      new SpoSessionManager({ cachePath, lockPath: join(dir, "browser-profile.lock"), targetUrl: TARGET });

    it("asks the capture for both SharePoint cookies, only from sharepoint.com, and does not probe", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(captured);
      await manager().authenticate();

      const built = vi.mocked(buildCaptureScript).mock.calls[0][0];
      expect(built.cookieNames).toEqual(["FedAuth", "rtFa"]);
      expect(built.cookieDomainFilter).toBe("sharepoint.com");
      expect(built.verifyUrl).toBeUndefined();
    });

    it("opens the configured tenant, on the shared persistent profile, with the browser identity the HTTP clients use", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(captured);
      await manager().authenticate();

      const built = vi.mocked(buildCaptureScript).mock.calls[0][0];
      expect(built.targetUrl).toBe(TARGET);
      expect(built.profileDir).toBe(authProfileDir());
      expect(built.profileDir).toBe(join(dir, ".workflow-suite", "browser-profile"));
      expect(built.userAgent).toBe(BROWSER_USER_AGENT);
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
      ["a cookie is blank", { status: "ok", cookies: { FedAuth: "  ", rtFa: "rt" } }],
      ["a cookie is not a string", { status: "ok", cookies: { FedAuth: 123, rtFa: "rt" } }],
    ])("rejects a capture result where %s, and caches nothing", async (_name, result) => {
      vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(result));

      await expect(manager().authenticate()).rejects.toThrow(/No valid SharePoint session found/);
      expect(existsSync(cachePath)).toBe(false);
    });

    it("fails an interactive login that cannot be cached: the command exists to leave a session for the other tools", async () => {
      const blocker = join(dir, "not-a-directory");
      await writeFile(blocker, "");
      const sm = new SpoSessionManager({
        cachePath: join(blocker, "spo-session.json"),
        lockPath: join(dir, "browser-profile.lock"),
      });
      vi.mocked(execFileSync).mockReturnValueOnce(captured);

      await expect(sm.authenticate({ interactive: true })).rejects.toThrow(
        /No valid SharePoint session found\. Browser auth failed: The login succeeded but the session could not be saved/
      );
    });

    it("tells the person how to install the browser when it is missing, which Playwright's one-line summary does not", async () => {
      vi.mocked(execFileSync).mockReturnValueOnce(
        JSON.stringify({
          status: "error",
          message: "Capture failed: browserType.launchPersistentContext: Executable doesn't exist at /x/chromium/chrome",
        })
      );

      await expect(manager().authenticate()).rejects.toThrow(/Executable doesn't exist[\s\S]*run "npx playwright install chromium"/);
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

        const second = manager().authenticate();

        await expect(second).rejects.toThrow(
          /No valid SharePoint session found\. Browser auth failed: A browser login just failed .*window closed/
        );
        await expect(second).rejects.toThrow(/The login command below ignores this wait/);
        expect(execFileSync).toHaveBeenCalledTimes(1);
      });

      it("tells the user, in the standard fix list, that --force re-logs in even when the cache looks fresh", async () => {
        failCapture();

        await expect(manager().authenticate()).rejects.toThrow(
          /--sharepoint \(opens browser for IDIR\/Entra login\)\n\s+add --force to re-login even if the cached session looks fresh/
        );
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

      it("does not stop an interactive login: the person running the command is the retry", async () => {
        failCapture();
        await expect(manager().authenticate()).rejects.toThrow(/window closed/);
        vi.mocked(execFileSync).mockReset();
        vi.mocked(execFileSync).mockReturnValue(captured);

        await expect(manager().authenticate({ interactive: true })).resolves.toEqual({ fedAuth: "fa", rtFa: "rt" });

        expect(execFileSync).toHaveBeenCalledTimes(1);
        expect(existsSync(memoFile())).toBe(false);
      });

      it("is left alone by invalidate(): that is about the cached session, not about a failed login", async () => {
        failCapture();
        await expect(manager().authenticate()).rejects.toThrow();

        await manager().invalidate();
        await manager().invalidate({ fedAuth: "x", rtFa: "y" });

        expect(existsSync(memoFile())).toBe(true);
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

      const [, , options] = vi.mocked(execFileSync).mock.calls[0];
      const built = vi.mocked(buildCaptureScript).mock.calls[0][0];
      const timings = CAPTURE_TIMINGS.sharePoint;
      expect((options as unknown as { timeout: number }).timeout).toBe(timings.processTimeoutMs);
      expect(built.navTimeoutMs).toBe(timings.navTimeoutMs);
      expect(built.pollBudgetMs).toBe(timings.pollBudgetMs);
    });

    it("surfaces what the capture child actually wrote to stderr, not the command line that embeds the script", async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("Command failed: /usr/bin/node -e \nSCRIPT-BODY"), {
          stderr: "node:internal/modules/cjs/loader:1478\n  throw err;\n  ^\n\nError: Cannot find module 'playwright'\n    at x",
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

  describe("the capture child's login settings", () => {
    const captured = JSON.stringify({ status: "ok", cookies: { FedAuth: "fa", rtFa: "rt" } });
    const saved: Record<string, string | undefined> = {};
    const setEnv = (values: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in saved)) saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    const capture = async () => {
      // A login that follows another in the same test must not adopt the first one's cache.
      await rm(cachePath, { force: true });
      vi.mocked(execFileSync).mockReturnValueOnce(captured);
      await new SpoSessionManager({
        cachePath,
        lockPath: join(dir, "browser-profile.lock"),
        targetUrl: "https://example.sharepoint.com",
      }).authenticate();
      const [, args, options] = vi.mocked(execFileSync).mock.calls[0];
      return {
        args: args as string[],
        built: vi.mocked(buildCaptureScript).mock.calls[0][0],
        options: options as { env: Record<string, string | undefined>; stdio: unknown[] },
      };
    };

    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("hands autofill credentials to the child only through its environment", async () => {
      setEnv({ IDIR_USERNAME: "jdoe-test-user", IDIR_PASSWORD: "s3cret-test-password", RAVEN_AUTH_AUTOFILL: undefined });
      const { args, built, options } = await capture();

      expect(built.autofill).toBe(true);
      expect(options.env["RAVEN_AUTOFILL_USERNAME"]).toBe("jdoe-test-user");
      expect(options.env["RAVEN_AUTOFILL_PASSWORD"]).toBe("s3cret-test-password");
      expect(JSON.stringify(args)).not.toContain("s3cret-test-password");
    });

    it("types nothing when RAVEN_AUTH_AUTOFILL is off, or when there are no credentials", async () => {
      setEnv({ IDIR_USERNAME: "jdoe-test-user", IDIR_PASSWORD: "s3cret-test-password", RAVEN_AUTH_AUTOFILL: "off" });
      const off = await capture();
      expect(off.built.autofill).toBe(false);
      expect(off.options.env["RAVEN_AUTOFILL_PASSWORD"]).toBeUndefined();

      vi.mocked(buildCaptureScript).mockClear();
      vi.mocked(execFileSync).mockClear();
      setEnv({ IDIR_USERNAME: undefined, IDIR_PASSWORD: undefined, ATLASSIAN_EMAIL: undefined, ATLASSIAN_PASSWORD: undefined, RAVEN_AUTH_AUTOFILL: undefined });
      expect((await capture()).built.autofill).toBe(false);
    });

    it("treats RAVEN_AUTH_DEBUG=0 as off and any other value as on, as the SiteMinder login does", async () => {
      setEnv({ RAVEN_AUTH_DEBUG: "0" });
      const off = await capture();
      expect(off.options.stdio[2]).toBe("pipe");
      expect(off.built.debug).toBe(false);

      vi.mocked(buildCaptureScript).mockClear();
      vi.mocked(execFileSync).mockClear();
      setEnv({ RAVEN_AUTH_DEBUG: "1" });
      const on = await capture();
      expect(on.options.stdio[2]).toBe("inherit");
      expect(on.built.debug).toBe(true);
    });
  });

  it("says so, once, when it has to wait for another login to finish", async () => {
    const lockPath = join(dir, "browser-profile.lock");
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "sibling" }));
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const sibling = new Promise<void>((resolve) =>
        setTimeout(async () => {
          await writeCachedSpoSession(cachePath, { fedAuth: "sibling-fa", rtFa: "sibling-rt" }, "example.sharepoint.com");
          await unlink(lockPath);
          resolve();
        }, 400)
      );
      await new SpoSessionManager({ cachePath, lockPath }).authenticate();
      await sibling;
    } finally {
      spy.mockRestore();
    }

    expect(written.filter((line) => line.includes("Another RAVEN login is in progress"))).toHaveLength(1);
  });

  it("exposes targetUrl and a browser user agent", () => {
    const sm = new SpoSessionManager({ cachePath, targetUrl: "https://example.sharepoint.com" });
    expect(sm.targetUrl).toBe("https://example.sharepoint.com");
    expect(sm.userAgent).toContain("Mozilla/5.0");
  });
});
