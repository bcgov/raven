import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { CAPTURE_TIMINGS } from "../capture-script.js";
import { SessionManager, probeSession } from "../session-manager.js";

const TARGET = "https://apps.example.gov.bc.ca/int/confluence";
const PROBE = `${TARGET}/index.action`;
const captureOutput = (cookie: string) =>
  JSON.stringify({ status: "ok", cookies: { SMSESSION: cookie } });

describe("SessionManager", () => {
  let cachePath: string;
  let lockPath: string;
  let savedEnvCookie: string | undefined;

  const seed = (smsession: string, ageSeconds = 0) =>
    writeFile(
      cachePath,
      JSON.stringify({
        smsession,
        cachedAt: Date.now() - ageSeconds * 1000,
        capturedFor: "apps.example.gov.bc.ca",
      })
    );
  const manager = () =>
    new SessionManager({ targetUrl: TARGET, cachePath, lockPath, sessionTtlSeconds: 1500 });

  beforeEach(async () => {
    home.dir = await mkdtemp(join(tmpdir(), "auth-home-"));
    cachePath = join(home.dir, "session.json");
    lockPath = join(home.dir, "browser-profile.lock");
    savedEnvCookie = process.env["SMSESSION"];
    delete process.env["SMSESSION"];
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(async () => {
    if (savedEnvCookie === undefined) delete process.env["SMSESSION"];
    else process.env["SMSESSION"] = savedEnvCookie;
    await rm(home.dir, { recursive: true, force: true });
  });

  describe("authenticate", () => {
    it("rejects a LOGGEDOFF capture instead of caching it as a session", async () => {
      vi.mocked(execFileSync).mockReturnValue(captureOutput("LOGGEDOFF"));

      await expect(manager().authenticate()).rejects.toThrow(/No valid SMSESSION/);
      expect(existsSync(cachePath)).toBe(false);
    });

    it("caches a real capture", async () => {
      vi.mocked(execFileSync).mockReturnValue(captureOutput("real-cookie"));

      await expect(manager().authenticate()).resolves.toBe("real-cookie");
      expect(JSON.parse(await readFile(cachePath, "utf-8")).smsession).toBe("real-cookie");
    });

    it("returns a verified login even when it cannot be cached, and keeps using it in this process", async () => {
      // A failed cache write (full disk, a Windows sharing error) is not a
      // failed login; reporting it as one made every queued caller log in again.
      const blocker = join(home.dir, "not-a-directory");
      await writeFile(blocker, "");
      const sm = new SessionManager({
        targetUrl: TARGET,
        cachePath: join(blocker, "session.json"),
        lockPath,
        sessionTtlSeconds: 1500,
      });
      vi.mocked(execFileSync).mockReturnValue(captureOutput("real-cookie"));

      await expect(sm.authenticate()).resolves.toBe("real-cookie");
      await expect(sm.getSession()).resolves.toBe("real-cookie");
      expect(execFileSync).toHaveBeenCalledTimes(1);
    });

    it("surfaces what the capture child actually wrote to stderr, not the command line that embeds the script", async () => {
      // execFileSync's own message is "Command failed: <node> -e <the whole
      // script>", which is useless to the user and is what a missing Playwright
      // or Chromium looked like.
      vi.mocked(execFileSync).mockImplementation(() => {
        throw Object.assign(new Error("Command failed: /usr/bin/node -e \nconst { chromium } = require('playwright'); SCRIPT-BODY"), {
          stderr: "Error: Cannot find module 'playwright'\n    at Module._resolveFilename",
        });
      });

      const failure = await manager().authenticate().then(
        () => undefined,
        (err: Error) => err
      );

      expect(failure?.message).toMatch(/No valid SMSESSION found\. Browser auth failed: Error: Cannot find module 'playwright'/);
      expect(failure?.message).not.toContain("SCRIPT-BODY");
    });

    it("says so, once, when it has to wait for another login to finish", async () => {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "sibling" }));
      const written: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      try {
        const sibling = new Promise<void>((resolve) =>
          setTimeout(async () => {
            await seed("cookie-from-sibling");
            await unlink(lockPath);
            resolve();
          }, 400)
        );
        await manager().authenticate();
        await sibling;
      } finally {
        spy.mockRestore();
      }

      expect(written.filter((line) => line.includes("Another RAVEN login is in progress"))).toHaveLength(1);
    });

    it("reports a lock timeout in the standard 'No valid SMSESSION found' form the tool instructions key on", async () => {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "sibling" }));
      const sm = new SessionManager({
        targetUrl: TARGET,
        cachePath,
        lockPath,
        sessionTtlSeconds: 1500,
        lockOptions: { waitMs: 100, pollMs: 10 },
      });

      await expect(sm.authenticate()).rejects.toThrow(
        /No valid SMSESSION found\. Browser auth failed: Timed out waiting for another RAVEN process/
      );
      expect(execFileSync).not.toHaveBeenCalled();
    });

    describe("the capture child's process options", () => {
      const saved: Record<string, string | undefined> = {};
      const setEnv = (values: Record<string, string | undefined>) => {
        for (const [key, value] of Object.entries(values)) {
          if (!(key in saved)) saved[key] = process.env[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
      const capture = async () => {
        vi.mocked(execFileSync).mockReturnValue(captureOutput("real-cookie"));
        await manager().authenticate();
        const [, args, options] = vi.mocked(execFileSync).mock.calls[0];
        return { args: args as string[], options: options as { env: Record<string, string | undefined>; stdio: unknown[]; maxBuffer: number } };
      };

      afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });

      it("keeps Playwright's debug variables out of the child's environment", async () => {
        // DEBUG=pw:api makes Playwright log every call's arguments, and that
        // includes the password autofill types.
        setEnv({ DEBUG: "pw:api", PWDEBUG: "1" });
        const { options } = await capture();

        expect(options.env["DEBUG"]).toBeUndefined();
        expect(options.env["PWDEBUG"]).toBeUndefined();
      });

      it("uses the shared capture timings, so the script's own budgets always end before the process is killed", async () => {
        const { args, options } = await capture();
        const timings = CAPTURE_TIMINGS.siteMinder;

        expect((options as unknown as { timeout: number }).timeout).toBe(timings.processTimeoutMs);
        expect(args[1]).toContain(`timeout: ${timings.navTimeoutMs} }`);
        expect(args[1]).toContain(`within ${timings.pollBudgetMs / 1000}s`);
      });

      it("gives the child an output buffer large enough that a chatty browser cannot kill it mid-login", async () => {
        const { options } = await capture();
        expect(options.maxBuffer).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      });

      it("hands autofill credentials to the child only through its environment", async () => {
        setEnv({ IDIR_USERNAME: "jdoe-test-user", IDIR_PASSWORD: "s3cret-test-password", RAVEN_AUTH_AUTOFILL: undefined });
        const { args, options } = await capture();

        expect(options.env["RAVEN_AUTOFILL_USERNAME"]).toBe("jdoe-test-user");
        expect(options.env["RAVEN_AUTOFILL_PASSWORD"]).toBe("s3cret-test-password");
        expect(JSON.stringify(args)).not.toContain("s3cret-test-password");
        expect(JSON.stringify(args)).not.toContain("jdoe-test-user");
      });

      it("passes no autofill credentials when autofill is switched off, in any spelling", async () => {
        setEnv({ IDIR_USERNAME: "jdoe-test-user", IDIR_PASSWORD: "s3cret-test-password", RAVEN_AUTH_AUTOFILL: "FALSE" });
        const { options } = await capture();

        expect(options.env["RAVEN_AUTOFILL_PASSWORD"]).toBeUndefined();
      });

      it("treats RAVEN_AUTH_DEBUG=0 as off: the child's stderr stays piped and the script does not log", async () => {
        setEnv({ RAVEN_AUTH_DEBUG: "0" });
        const { args, options } = await capture();

        expect(options.stdio[2]).toBe("pipe");
        expect(args[1]).toContain("const DEBUG = false");
      });

      it("inherits the child's stderr and logs when RAVEN_AUTH_DEBUG is on", async () => {
        setEnv({ RAVEN_AUTH_DEBUG: "1" });
        const { args, options } = await capture();

        expect(options.stdio[2]).toBe("inherit");
        expect(args[1]).toContain("const DEBUG = true");
      });
    });

    it("adopts the login another process finishes while waiting for the profile lock, without a second browser", async () => {
      // Two servers hit expiry together; Chromium lets one process own the
      // persistent profile. The waiter must reuse the winner's login rather
      // than fail on the profile lock or launch another window.
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "sibling" }));
      const sibling = new Promise<void>((resolve) =>
        setTimeout(async () => {
          await seed("cookie-from-sibling");
          await unlink(lockPath);
          resolve();
        }, 80)
      );

      await expect(manager().authenticate()).resolves.toBe("cookie-from-sibling");
      await sibling;

      expect(execFileSync).not.toHaveBeenCalled();
    });

    it("holds the profile lock only while the capture runs", async () => {
      let heldDuringCapture = false;
      vi.mocked(execFileSync).mockImplementation(() => {
        heldDuringCapture = existsSync(lockPath);
        return captureOutput("real-cookie");
      });

      await manager().authenticate();

      expect(heldDuringCapture).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("releases the profile lock when the capture fails", async () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Chromium crashed");
      });

      await expect(manager().authenticate()).rejects.toThrow(/Browser auth failed/);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("has the capture confirm the cookie against the protected page before accepting it", async () => {
      vi.mocked(execFileSync).mockReturnValue(captureOutput("real-cookie"));

      await manager().authenticate();

      const script = vi.mocked(execFileSync).mock.calls[0][1]?.[1] as string;
      expect(script).toContain(`const verifyUrl = ${JSON.stringify(PROBE)}`);
    });
  });

  describe("getSession", () => {
    it("ignores a LOGGEDOFF SMSESSION env var and captures a real one", async () => {
      process.env["SMSESSION"] = "LOGGEDOFF";
      vi.mocked(execFileSync).mockReturnValue(captureOutput("real-cookie"));

      await expect(manager().getSession()).resolves.toBe("real-cookie");
    });

    it("does not serve a poisoned LOGGEDOFF cache file", async () => {
      await seed("LOGGEDOFF");
      vi.mocked(execFileSync).mockReturnValue(captureOutput("real-cookie"));

      await expect(manager().getSession()).resolves.toBe("real-cookie");
    });

    it("still serves an env-var cookie when the cache cannot be written, instead of failing the first call", async () => {
      const blocker = join(home.dir, "not-a-directory");
      await writeFile(blocker, "");
      process.env["SMSESSION"] = "env-cookie";
      const sm = new SessionManager({
        targetUrl: TARGET,
        cachePath: join(blocker, "session.json"),
        lockPath,
        sessionTtlSeconds: 1500,
      });

      await expect(sm.getSession()).resolves.toBe("env-cookie");
      await expect(sm.getSession()).resolves.toBe("env-cookie");
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe("invalidate", () => {
    it("adopts a fresher cookie another process cached instead of deleting it and re-launching a browser", async () => {
      // Running MCP servers keep their cookie in memory. After the user re-logs in
      // by hand, the next 302 in a stale server used to delete that fresh login
      // and pop another browser.
      await seed("old-cookie");
      const sm = manager();
      expect(await sm.getSession()).toBe("old-cookie");

      await seed("fresh-cookie");
      await sm.invalidate("old-cookie");

      expect(await sm.getSession()).toBe("fresh-cookie");
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it("still removes the cache when it holds the cookie that failed", async () => {
      await seed("dead-cookie");
      const sm = manager();
      await sm.getSession();

      await sm.invalidate("dead-cookie");

      expect(existsSync(cachePath)).toBe(false);
    });

    it("without an argument keeps the old unconditional behaviour", async () => {
      await seed("any-cookie");
      await manager().invalidate();
      expect(existsSync(cachePath)).toBe(false);
    });
  });

  describe("checkCache", () => {
    const answer = (status: number, location?: string) =>
      vi.fn().mockResolvedValue(
        new Response(null, { status, headers: location ? { location } : {} })
      );

    it("reports none when nothing usable is cached", async () => {
      expect(await manager().checkCache(answer(200))).toEqual({ state: "none" });
    });

    it("reports none for a poisoned LOGGEDOFF cache", async () => {
      await seed("LOGGEDOFF");
      expect(await manager().checkCache(answer(200))).toEqual({ state: "none" });
    });

    it("reports live when the server honours the cached cookie", async () => {
      await seed("real-cookie");
      const fetchImpl = answer(302, "/int/confluence/dashboard.action");
      expect(await manager().checkCache(fetchImpl)).toEqual({ state: "live", cookie: "real-cookie" });
      expect(fetchImpl).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ redirect: "manual" })
      );
    });

    it("reports dead when the server bounces the cached cookie to login, even though it is under 25 minutes old", async () => {
      await seed("real-cookie");
      expect(
        await manager().checkCache(answer(302, "https://logon7.gov.bc.ca/clp-cgi/capBceid/logon.cgi"))
      ).toEqual({ state: "dead", cookie: "real-cookie" });
    });

    it("reports unknown when the server cannot be reached", async () => {
      await seed("real-cookie");
      const offline = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
      expect(await manager().checkCache(offline)).toEqual({ state: "unknown", cookie: "real-cookie" });
    });

    describe("choosing the host to log in to", () => {
      const names = ["CONFLUENCE_URL", "ATLASSIAN_BASE_URL"] as const;
      const saved: Record<string, string | undefined> = {};
      const probedUrl = async (env: Partial<Record<(typeof names)[number], string>>) => {
        for (const name of names) {
          saved[name] = process.env[name];
          if (env[name] === undefined) delete process.env[name];
          else process.env[name] = env[name];
        }
        await seed("real-cookie");
        const fetchImpl = answer(302, "/int/confluence/dashboard.action");
        await new SessionManager({ cachePath, lockPath }).checkCache(fetchImpl);
        return fetchImpl.mock.calls[0][0] as string;
      };

      afterEach(() => {
        for (const name of names) {
          if (saved[name] === undefined) delete process.env[name];
          else process.env[name] = saved[name];
        }
      });

      it("maps a BWA CONFLUENCE_URL to the SSO host too, not only ATLASSIAN_BASE_URL", async () => {
        // SMSESSION is only minted on the apps host; a per-product override that
        // points at the BWA gateway used to send the capture to a host that can
        // never issue one.
        expect(await probedUrl({ CONFLUENCE_URL: "https://bwa.example.gov.bc.ca/int/confluence" })).toBe(
          "https://apps.example.gov.bc.ca/int/confluence/index.action"
        );
      });

      it("leaves a CONFLUENCE_URL that is already on the SSO host unchanged", async () => {
        expect(await probedUrl({ CONFLUENCE_URL: "https://apps.example.gov.bc.ca/int/confluence" })).toBe(
          "https://apps.example.gov.bc.ca/int/confluence/index.action"
        );
      });

      it("treats a blank CONFLUENCE_URL as unset, so it falls through to ATLASSIAN_BASE_URL", async () => {
        // A blank value used to win the ?? and produce a probe URL of just "/index.action".
        expect(await probedUrl({ CONFLUENCE_URL: "  ", ATLASSIAN_BASE_URL: "https://bwa.example.gov.bc.ca" })).toBe(
          "https://apps.example.gov.bc.ca/int/confluence/index.action"
        );
      });

      it("falls back to the default host when neither is set", async () => {
        expect(await probedUrl({})).toBe("https://apps.example.gov.bc.ca/int/confluence/index.action");
      });
    });

    it("probes the SSO host when only the BWA API host is configured", async () => {
      // SMSESSION can only be minted and checked on the apps host; the BWA
      // host is an IDIR Basic gateway that never issues one.
      const saved = { CONFLUENCE_URL: process.env["CONFLUENCE_URL"], ATLASSIAN_BASE_URL: process.env["ATLASSIAN_BASE_URL"] };
      delete process.env["CONFLUENCE_URL"];
      process.env["ATLASSIAN_BASE_URL"] = "https://bwa.example.gov.bc.ca";
      try {
        await seed("real-cookie");
        const fetchImpl = answer(302, "/int/confluence/dashboard.action");

        await new SessionManager({ cachePath, lockPath }).checkCache(fetchImpl);

        expect(fetchImpl).toHaveBeenCalledWith(
          "https://apps.example.gov.bc.ca/int/confluence/index.action",
          expect.anything()
        );
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});

describe("probeSession", () => {
  const respond = (status: number, location?: string) =>
    vi.fn().mockResolvedValue(new Response(null, { status, headers: location ? { location } : {} }));

  it("sends the cookie and does not follow redirects", async () => {
    const fetchImpl = respond(200);
    await probeSession("real-cookie", PROBE, fetchImpl);

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Cookie")).toBe("SMSESSION=real-cookie");
    expect(init.redirect).toBe("manual");
  });

  it.each([
    [200, undefined, "live"],
    [302, "/int/confluence/dashboard.action", "live"],
    [302, "https://logon7.gov.bc.ca/logon.cgi", "dead"],
    [302, "https://login.microsoftonline.com/x", "dead"],
    [401, undefined, "dead"],
    [403, undefined, "dead"],
    [502, undefined, "unknown"],
    [503, undefined, "unknown"],
  ] as const)("%i %s -> %s", async (status, location, expected) => {
    expect(await probeSession("c", PROBE, respond(status, location))).toBe(expected);
  });

  it("reports unknown when the request throws", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await probeSession("c", PROBE, boom)).toBe("unknown");
  });

  it("cancels the response body, so a large page is not streamed to completion for a status check", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

    expect(await probeSession("c", PROBE, fetchImpl)).toBe("live");

    expect(cancelled).toBe(true);
  });
});
