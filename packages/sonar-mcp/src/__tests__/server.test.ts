import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSonarServer } from "../server.js";

describe("Sonar MCP project listing", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const server = createSonarServer();
  const client = new Client({ name: "sonar-test", version: "0.0.0" }, { capabilities: {} });

  beforeAll(async () => {
    vi.stubEnv("SONARQUBE_URL", "https://sonar.example.com");
    vi.stubEnv("SONARQUBE_TOKEN", "test-token");
    vi.stubGlobal("fetch", fetchMock);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await Promise.all([client.close(), server.close()]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("advertises a read-only tool returning every project as structured JSON", async () => {
    const tools = await client.listTools();
    expect(tools.tools.find(({ name }) => name === "sonar_list_projects")?.annotations?.readOnlyHint).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      paging: { pageIndex: 1, pageSize: 100, total: 2 },
      components: [
        { key: "RAVEN", name: "Raven", visibility: "private" },
        { key: "crow", name: "Crow", visibility: "public" },
      ],
    })));

    const result = await client.callTool({ name: "sonar_list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    if (!Array.isArray(result.content) || result.content[0]?.type !== "text") {
      throw new Error("Expected text response");
    }
    expect(JSON.parse(result.content[0].text)).toEqual({
      total: 2,
      projects: [
        { key: "RAVEN", name: "Raven", visibility: "private" },
        { key: "crow", name: "Crow", visibility: "public" },
      ],
    });
  });

  it("surfaces an upstream authorization error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const result = await client.callTool({ name: "sonar_list_projects", arguments: {} });
    expect(result.isError).toBe(true);
  });
});
