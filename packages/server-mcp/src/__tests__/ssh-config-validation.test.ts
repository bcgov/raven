import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "ssh2";
import type { ServerEntry } from "@nrs/auth";
import { sshExec, sshExecStream } from "../ssh-client.js";

const { loadEnvVar } = vi.hoisted(() => ({ loadEnvVar: vi.fn() }));

vi.mock("@nrs/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@nrs/auth")>(),
  loadEnvVar,
  // This suite exercises transport validation without queuing or retaining
  // circuit-breaker state between deliberately invalid configurations.
  wrapSshExecWithLimits: (fn: unknown) => fn,
}));
vi.mock("ssh2", () => ({ Client: vi.fn() }));

const entry: ServerEntry = {
  name: "synthetic", host: "synthetic.example.invalid", sshUser: "TEST_A",
  sudoUser: "", role: "TEST", description: "Configuration validation fixture",
  appsBase: "/apps_ux", logsBase: "/apps_ux/logs",
};

beforeEach(() => {
  vi.clearAllMocks();
  // No credentials are available in this fixture, so positive controls also
  // stop before connecting. Never consult the operator's environment.
  loadEnvVar.mockReturnValue(undefined);
});

describe.each(["appsBase", "logsBase"] as const)("SSH configuration: %s", (field) => {
  it.each([
    "/tmp; printf CANARY",
    "/tmp/$(printf CANARY)",
    "/tmp\nCANARY",
    "/tmp/*",
  ])("rejects %s before credential access in both transports", async (value) => {
    const invalid = { ...entry, [field]: value };

    const result = await sshExec(invalid, "printf SAFE");
    expect(result).toMatchObject({ stdout: "", exitCode: 1 });
    expect(result.stderr).toContain(field);
    await expect(sshExecStream(invalid, "printf SAFE")).rejects.toThrow(field);

    expect(loadEnvVar).not.toHaveBeenCalled();
    expect(Client).not.toHaveBeenCalled();
  });
});

it.each([
  { appsBase: "/apps_ux", logsBase: "/apps_ux/logs" },
  { appsBase: "/sw_ux/httpd01", logsBase: "/sw_ux/httpd01/logs/" },
  { appsBase: "/", logsBase: "/opt/app-1.2/logs" },
])("preserves supported base paths: %j", async (paths) => {
  const valid = { ...entry, ...paths };
  const result = await sshExec(valid, "printf SAFE");
  expect(result.stderr).toContain("SERVER_A_PASSWORD not set");
  await expect(sshExecStream(valid, "printf SAFE"))
    .rejects.toThrow("SERVER_A_PASSWORD not set");
  expect(loadEnvVar).toHaveBeenCalledWith("SERVER_A_PASSWORD");
  expect(Client).not.toHaveBeenCalled();
});
