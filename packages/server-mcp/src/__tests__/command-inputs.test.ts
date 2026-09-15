import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerMonitoringServer } from "../server.js";

const { sshExec } = vi.hoisted(() => ({ sshExec: vi.fn() }));

vi.mock("../ssh-client.js", () => ({ sshExec }));
vi.mock("@nrs/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@nrs/auth")>(),
  getServerNames: () => ["one", "two"],
  getServerDescription: () => "Synthetic command-validation servers",
  getServerConfig: () => ["one", "two"].map((name) => ({
    name, host: `${name}.example.invalid`, sshUser: "TEST_A", sudoUser: "tomcat",
    role: "TEST", description: "Synthetic", appsBase: "/apps", logsBase: "/logs",
  })),
}));

beforeEach(() => {
  sshExec.mockReset();
  sshExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

async function callTool(name: string, args: Record<string, unknown>) {
  const server = createServerMonitoringServer();
  const client = new Client({ name: "command-validation-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await client.callTool({ name, arguments: args });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

describe.each([
  { name: "diff_server_config", args: { servers: "one,two", file: "server.xml" } },
  { name: "jvm_heap", args: { server: "one" } },
])("$name direct MCP command boundary", ({ name, args }) => {
  it.each([
    { app: "$(printf CANARY)", component: "api" },
    { app: "APP", component: "api; printf CANARY" },
    { app: "../APP", component: "api" },
    { app: "APP", component: "api/*" },
  ])("rejects unsafe path identifiers before SSH: %j", async (identifiers) => {
    const result = await callTool(name, { ...args, ...identifiers });
    expect(result.isError).toBe(true);
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("preserves ordinary app and component names", async () => {
    sshExec.mockResolvedValue({
      stdout: name === "diff_server_config"
        ? "___BEGIN___\n<config/>\n___END___"
        : "HDATA:123|128m|1024 1024 128 128 2048 256 4096 1024 1024 128 256 32 1 0.1 0 0 0.1",
      stderr: "", exitCode: 0,
    });
    const result = await callTool(name, { ...args, app: "APP-1", component: "api_2.3" });
    expect(result.isError).not.toBe(true);
    expect(sshExec).toHaveBeenCalledTimes(name === "diff_server_config" ? 2 : 1);
  });
});
