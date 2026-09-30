import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { SessionManager, probeSession } from "../session-manager.js";

const TARGET = "https://apps.example.gov.bc.ca/int/confluence";
const PROBE = `${TARGET}/index.action`;
const captureOutput = (cookie: string) =>
  JSON.stringify({ status: "ok", cookies: { SMSESSION: cookie } });

describe("SessionManager", () => {
  let cachePath: string;
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
    new SessionManager({ targetUrl: TARGET, cachePath, sessionTtlSeconds: 1500 });

  beforeEach(async () => {
    home.dir = await mkdtemp(join(tmpdir(), "auth-home-"));
    cachePath = join(home.dir, "session.json");
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
});
