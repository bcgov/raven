import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchLogs, searchHttpdLogs } from "../commands/log-search.js";
import { createServerMonitoringServer } from "../server.js";

vi.mock("@nrs/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@nrs/auth")>(),
  getServerNames: () => ["testserver"],
  getServerDescription: () => "Synthetic test server",
  getServerConfig: () => [{
    name: "testserver", host: "testserver.example.invalid", sshUser: "review",
    sudoUser: "tomcat", role: "test", description: "Synthetic test server",
    appsBase: "/apps", logsBase: "/logs",
  }],
}));

vi.mock("../commands/log-search.js", () => ({
  searchLogs: vi.fn(),
  searchHttpdLogs: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("log-search MCP privacy boundary", () => {
  it.each([
    { name: "search_server_logs", args: { app: "APP", component: "api" }, search: searchLogs },
    { name: "search_httpd_logs", args: { domain: "example.invalid" }, search: searchHttpdLogs },
  ])("scrubs successful $name responses before returning them to the client", async ({ name, args, search }) => {
    vi.stubEnv("RAVEN_SCRUB_PI", "true");
    vi.mocked(search).mockResolvedValue({
      output: "ERROR contact person@example.invalid password=SyntheticSecret22", exitCode: 0,
    });
    const server = createServerMonitoringServer();
    const client = new Client({ name: "privacy-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name, arguments: { server: "testserver", pattern: "ERROR", ...args } });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "ERROR contact [EMAIL] [CREDENTIAL]" }]);
      expect(search).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
