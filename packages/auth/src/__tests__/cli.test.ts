import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cli.ts runs on import, so each test loads it afresh against stubs: no
// keychain, no browser, no real session managers.
const stubs = vi.hoisted(() => ({
  loadEnv: vi.fn(),
  cached: vi.fn(),
}));

vi.mock("../load-env.js", () => ({ loadEnv: stubs.loadEnv }));
vi.mock("../session-manager.js", () => ({ SessionManager: vi.fn() }));
vi.mock("../spo-session-manager.js", () => ({ SpoSessionManager: vi.fn() }));
vi.mock("../spo-cookie-cache.js", () => ({ readCachedSpoSession: stubs.cached }));

/** Run the CLI entry point with these arguments; resolves with its output and exit code. */
async function runEntryPoint(...args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => void out.push(parts.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => void err.push(parts.join(" ")));
  process.argv = ["node", "cli.js", ...args];
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import("../cli.js");
    // The entry point settles the exit code asynchronously.
    await vi.waitFor(() => expect(process.exitCode).toBeDefined());
    return { out: out.join("\n"), err: err.join("\n"), exitCode: process.exitCode as number | undefined };
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
    log.mockRestore();
    error.mockRestore();
  }
}

describe("raven-auth entry point", () => {
  beforeEach(() => {
    stubs.loadEnv.mockReset();
    stubs.cached.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([["--help"], ["-h"], ["--forcee"], ["stray"]])(
    "does not load the credentials (a keychain or DPAPI read) just to answer %s",
    async (arg) => {
      await runEntryPoint(arg);

      expect(stubs.loadEnv).not.toHaveBeenCalled();
    }
  );

  it("prints the usage for --help and exits 0", async () => {
    const { out, exitCode } = await runEntryPoint("--help");

    expect(out).toContain("Usage: raven-auth");
    expect(exitCode).toBe(0);
  });

  it("rejects an unknown option with exit code 1", async () => {
    const { err, exitCode } = await runEntryPoint("--forcee");

    expect(err).toContain("Unknown option: --forcee");
    expect(exitCode).toBe(1);
  });

  it("loads the credentials, once, before it builds a session manager or reads the cache", async () => {
    // The manager reads CONFLUENCE_URL and friends at construction, and the
    // SharePoint cache TTL comes from SHAREPOINT_SESSION_TTL, so the
    // environment has to be loaded first.
    const order: string[] = [];
    stubs.loadEnv.mockImplementation(() => void order.push("loadEnv"));
    stubs.cached.mockImplementation(async () => {
      order.push("readCachedSpoSession");
      return { fedAuth: "fa", rtFa: "rt" };
    });
    const { SpoSessionManager } = await import("../spo-session-manager.js");
    // A plain function: it is called with `new`, which an arrow function cannot be.
    vi.mocked(SpoSessionManager).mockImplementation(function () {
      order.push("new SpoSessionManager");
      return {};
    } as never);

    const { out, err, exitCode } = await runEntryPoint("--sharepoint");

    expect(out, err).toContain("Valid SharePoint session found in cache");
    expect(exitCode).toBe(0);
    expect(order).toEqual(["loadEnv", "new SpoSessionManager", "readCachedSpoSession"]);
  });
});
