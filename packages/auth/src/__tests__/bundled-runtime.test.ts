import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi, describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";
import { SpoSessionManager } from "../spo-session-manager.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

describe("browser authentication subprocess runtime", () => {
  it("uses the current executable for SiteMinder authentication", async () => {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ status: "ok", smsession: "test-session" }),
    );
    const manager = new SessionManager({
      cachePath: join(tmpdir(), `raven-auth-${randomUUID()}.json`),
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
        fedAuth: "test-fed-auth",
        rtFa: "test-rt-fa",
      }),
    );
    const manager = new SpoSessionManager({
      cachePath: join(tmpdir(), `raven-spo-auth-${randomUUID()}.json`),
    });

    await manager.authenticate();

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.any(Object),
    );
  });
});
