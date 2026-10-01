import { describe, expect, it, vi } from "vitest";
import { USAGE, runCli, type CliDeps } from "../cli-run.js";
import type { CacheCheck } from "../session-manager.js";

/** A CLI wired to fakes: no browser, no network, no home directory. */
function harness(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sm = {
    checkCache: vi.fn<() => Promise<CacheCheck>>().mockResolvedValue({ state: "none" }),
    invalidate: vi.fn().mockResolvedValue(true),
    authenticate: vi.fn().mockResolvedValue("real-cookie"),
  };
  const spo = {
    invalidate: vi.fn().mockResolvedValue(true),
    authenticate: vi.fn().mockResolvedValue({ fedAuth: "fa", rtFa: "rt" }),
  };
  const sessionManager = vi.fn(() => sm);
  const spoSessionManager = vi.fn(() => spo);
  const readCachedSpoSession = vi.fn().mockResolvedValue(null);
  const deps: CliDeps = {
    sessionManager,
    spoSessionManager,
    readCachedSpoSession,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    ...overrides,
  };
  return { deps, sm, spo, sessionManager, spoSessionManager, readCachedSpoSession, out: () => out.join("\n"), err: () => err.join("\n") };
}

describe("runCli: SiteMinder login", () => {
  it("reports a cache the server confirms as valid, without logging in", async () => {
    const h = harness();
    h.sm.checkCache.mockResolvedValue({ state: "live", cookie: "c" });

    expect(await runCli([], h.deps)).toBe(0);

    expect(h.out()).toContain("confirmed with the server");
    expect(h.sm.authenticate).not.toHaveBeenCalled();
    expect(h.sm.invalidate).not.toHaveBeenCalled();
  });

  it("exits 2, without logging in, when a cached session cannot be verified, so automation can tell it from a verified one", async () => {
    const h = harness();
    h.sm.checkCache.mockResolvedValue({ state: "unknown", cookie: "c" });

    expect(await runCli([], h.deps)).toBe(2);

    expect(h.out()).toContain("could not be reached to confirm it");
    expect(h.out()).toContain("--force");
    expect(h.sm.authenticate).not.toHaveBeenCalled();
  });

  it("discards a cookie the server rejected, naming it so a newer login is not lost, and logs in again", async () => {
    const h = harness();
    h.sm.checkCache.mockResolvedValue({ state: "dead", cookie: "old-cookie" });

    expect(await runCli([], h.deps)).toBe(0);

    expect(h.sm.invalidate).toHaveBeenCalledWith("old-cookie");
    expect(h.sm.authenticate).toHaveBeenCalledTimes(1);
    expect(h.out()).toContain("rejected by the server");
  });

  it("logs in as an explicit request: a login that just failed elsewhere must not stop it, and an unsaved session is an error", async () => {
    const h = harness();

    await runCli([], h.deps);

    expect(h.sm.authenticate).toHaveBeenCalledWith({ interactive: true });
  });

  it("logs in when nothing usable is cached", async () => {
    const h = harness();

    expect(await runCli([], h.deps)).toBe(0);

    expect(h.sm.authenticate).toHaveBeenCalledTimes(1);
    expect(h.sm.invalidate).not.toHaveBeenCalled();
    expect(h.out()).toContain("Authentication successful");
  });

  it("with --force skips the server check, clears the cache unconditionally and logs in", async () => {
    const h = harness();
    h.sm.checkCache.mockResolvedValue({ state: "live", cookie: "c" });

    expect(await runCli(["--force"], h.deps)).toBe(0);

    expect(h.sm.checkCache).not.toHaveBeenCalled();
    expect(h.sm.invalidate).toHaveBeenCalledWith();
    expect(h.sm.authenticate).toHaveBeenCalledTimes(1);
    expect(h.sm.authenticate).toHaveBeenCalledWith({ interactive: true });
  });

  it("with --force stops, rather than reporting success, when the cached session cannot be removed", async () => {
    // Left in place, the cookie would be adopted again by the login below and
    // the command would print "Authentication successful" without logging in.
    const h = harness();
    h.sm.invalidate.mockResolvedValue(false);

    expect(await runCli(["--force"], h.deps)).toBe(1);

    expect(h.sm.authenticate).not.toHaveBeenCalled();
    expect(h.err()).toContain("Could not remove the cached session");
    expect(h.err()).toContain("~/.workflow-suite/session.json");
    expect(h.out()).not.toContain("Authentication successful");
  });

  it("prints the failure and exits 1 when the login fails", async () => {
    const h = harness();
    h.sm.authenticate.mockRejectedValue(new Error("No valid SMSESSION found. Browser auth failed: window closed"));

    expect(await runCli([], h.deps)).toBe(1);

    expect(h.err()).toContain("Authentication failed");
    expect(h.err()).toContain("window closed");
  });

  it("never touches the SharePoint manager", async () => {
    const h = harness();
    await runCli([], h.deps);
    expect(h.spoSessionManager).not.toHaveBeenCalled();
  });
});

describe("runCli: SharePoint login", () => {
  it("reports a cached pair as valid, without logging in", async () => {
    const h = harness();
    h.readCachedSpoSession.mockResolvedValue({ fedAuth: "fa", rtFa: "rt" });

    expect(await runCli(["--sharepoint"], h.deps)).toBe(0);

    expect(h.out()).toContain("Valid SharePoint session found in cache");
    expect(h.spo.authenticate).not.toHaveBeenCalled();
  });

  it("logs in when nothing is cached", async () => {
    const h = harness();

    expect(await runCli(["--sharepoint"], h.deps)).toBe(0);

    expect(h.spo.authenticate).toHaveBeenCalledTimes(1);
    expect(h.spo.authenticate).toHaveBeenCalledWith({ interactive: true });
    expect(h.out()).toContain("Authentication successful");
  });

  it.each([["--sharepoint", "--force"], ["--force", "--sharepoint"]])(
    "honours --force in either position (%s %s): the cached pair is ignored and replaced",
    async (...argv) => {
      // --force used to be read only by the SiteMinder path, so combining it
      // with --sharepoint was accepted and silently did nothing.
      const h = harness();
      h.readCachedSpoSession.mockResolvedValue({ fedAuth: "fa", rtFa: "rt" });

      expect(await runCli(argv, h.deps)).toBe(0);

      expect(h.readCachedSpoSession).not.toHaveBeenCalled();
      expect(h.spo.invalidate).toHaveBeenCalledWith();
      expect(h.spo.authenticate).toHaveBeenCalledTimes(1);
    }
  );

  it("with --force stops, rather than reporting success, when the cached pair cannot be removed", async () => {
    const h = harness();
    h.spo.invalidate.mockResolvedValue(false);

    expect(await runCli(["--sharepoint", "--force"], h.deps)).toBe(1);

    expect(h.spo.authenticate).not.toHaveBeenCalled();
    expect(h.err()).toContain("Could not remove the cached SharePoint session");
    expect(h.err()).toContain("~/.workflow-suite/spo-session.json");
  });

  it("prints the failure and exits 1 when the login fails", async () => {
    const h = harness();
    h.spo.authenticate.mockRejectedValue(new Error("No valid SharePoint session found."));

    expect(await runCli(["--sharepoint"], h.deps)).toBe(1);

    expect(h.err()).toContain("Authentication failed");
  });

  it("never touches the SiteMinder manager", async () => {
    const h = harness();
    await runCli(["--sharepoint"], h.deps);
    expect(h.sessionManager).not.toHaveBeenCalled();
  });
});

describe("runCli: options", () => {
  it.each([["--help"], ["-h"]])("%s prints the usage and exits 0 without doing anything", async (flag) => {
    const h = harness();

    expect(await runCli([flag], h.deps)).toBe(0);

    expect(h.out()).toContain(USAGE);
    expect(h.sessionManager).not.toHaveBeenCalled();
    expect(h.spoSessionManager).not.toHaveBeenCalled();
  });

  it.each([["--forcee"], ["--share-point"], ["--frce", "--sharepoint"], ["stray"]])(
    "rejects an option it does not know (%s) instead of silently ignoring it",
    async (...argv) => {
      // A mistyped --force used to be dropped, and the login then trusted the cache.
      const h = harness();

      expect(await runCli(argv, h.deps)).toBe(1);

      expect(h.err()).toContain("Unknown option");
      expect(h.err()).toContain(USAGE);
      expect(h.sessionManager).not.toHaveBeenCalled();
      expect(h.spoSessionManager).not.toHaveBeenCalled();
    }
  );

  it("documents every option and exit code in the usage text", () => {
    for (const text of ["--sharepoint", "--force", "--help", "Exit codes", "2"]) {
      expect(USAGE).toContain(text);
    }
  });
});
