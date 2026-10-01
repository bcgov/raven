import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi, afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";
import { SpoSessionManager } from "../spo-session-manager.js";

const home = vi.hoisted(() => ({ dir: "" }));

// authenticate() creates the browser-profile directory under the home
// directory. Point it at a throwaway one so this test never creates or
// re-tightens the real ~/.workflow-suite/browser-profile.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

beforeAll(async () => {
  home.dir = await mkdtemp(join(tmpdir(), "bundled-runtime-home-"));
});

afterAll(async () => {
  await rm(home.dir, { recursive: true, force: true });
});

describe("browser authentication subprocess runtime", () => {
  it("uses the current executable for SiteMinder authentication", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ status: "ok", cookies: { SMSESSION: "test-session" } }),
    );
    const manager = new SessionManager({
      cachePath: join(tmpdir(), `raven-auth-${randomUUID()}.json`),
      // Never contend with a real login holding the user's profile lock.
      lockPath: join(tmpdir(), `raven-auth-${randomUUID()}.lock`),
    });

    await manager.authenticate();

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("uses the current executable for SharePoint authentication", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        status: "ok",
        cookies: { FedAuth: "test-fed-auth", rtFa: "test-rt-fa" },
      }),
    );
    const manager = new SpoSessionManager({
      cachePath: join(tmpdir(), `raven-spo-auth-${randomUUID()}.json`),
      lockPath: join(tmpdir(), `raven-spo-auth-${randomUUID()}.lock`),
    });

    await manager.authenticate();

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.any(Object),
    );
  });
});
