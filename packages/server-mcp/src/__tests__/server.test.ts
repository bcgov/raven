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

vi.mock("../commands/log-search.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../commands/log-search.js")>(),
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

describe.each([
  { name: "search_server_logs", args: { app: "APP", component: "api" }, search: searchLogs },
  { name: "search_httpd_logs", args: { domain: "example.invalid" }, search: searchHttpdLogs },
])("$name MCP date validation", ({ name, args, search }) => {
  it.each([
    { label: "LF", suffix: "\n" },
    { label: "CR", suffix: "\r" },
    { label: "CRLF", suffix: "\r\n" },
    { label: "LINE SEPARATOR", suffix: "\u2028" },
    { label: "PARAGRAPH SEPARATOR", suffix: "\u2029" },
    { label: "NUL", suffix: "\0" },
  ])("rejects a trailing $label before invoking the search", async ({ suffix }) => {
    const server = createServerMonitoringServer();
    const client = new Client({ name: "date-validation-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      for (const prefix of ["2026-09-15", "today"]) {
        const result = await client.callTool({
          name, arguments: { server: "testserver", pattern: "ERROR", ...args, date: `${prefix}${suffix}` },
        });
        expect(result.isError).toBe(true);
      }
      expect(search).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01"])("rejects impossible date %s before invoking the search", async date => {
    const server = createServerMonitoringServer();
    const client = new Client({ name: "date-validation-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name, arguments: { server: "testserver", pattern: "ERROR", ...args, date } });
      expect(result.isError).toBe(true);
      expect(search).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it.each(["2026-09-15", "2024-02-29", "today"])("accepts the complete date value %s", async (date) => {
    vi.mocked(search).mockResolvedValue({ output: "No matches", exitCode: 0 });
    const server = createServerMonitoringServer();
    const client = new Client({ name: "date-validation-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name, arguments: { server: "testserver", pattern: "ERROR", ...args, date } });
      expect(result.isError).not.toBe(true);
      expect(search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ date }));
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
