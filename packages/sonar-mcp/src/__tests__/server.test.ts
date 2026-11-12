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

  it("advertises a read-only tool returning user-visible projects as structured JSON", async () => {
    const tools = await client.listTools();
    expect(tools.tools.find(({ name }) => name === "sonar_list_projects")?.annotations?.readOnlyHint).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      paging: { pageIndex: 1, pageSize: 100, total: 2 },
      components: [
        { key: "RAVEN", name: "Raven", visibility: "private" },
        { key: "crow", name: "Crow", visibility: "public" },
      ],
    })));

    const result = await client.callTool({ name: "sonar_list_projects", arguments: { organization: "ignored" } });
    expect(result.isError).not.toBe(true);
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    if (typeof url !== "string") throw new Error("Expected string URL");
    const requestUrl = new URL(url);
    expect(requestUrl.origin).toBe("https://sonar.example.com");
    expect(requestUrl.pathname).toBe("/api/components/search");
    expect(requestUrl.searchParams.get("qualifiers")).toBe("TRK");
    expect(requestUrl.searchParams.has("organization")).toBe(false);
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("test-token:").toString("base64")}`,
    );
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

  it("sonar_list_issues omits assignee filters by default and scrubs assignees when filtering", async () => {
    const body = {
      total: 2, p: 1, ps: 200,
      issues: [
        { key: "K1", severity: "MAJOR", type: "BUG", component: "a.cs", line: 1, message: "m", rule: "r", assignee: "jane.doe@gov.bc.ca" },
        { key: "K2", severity: "MAJOR", type: "BUG", component: "b.cs", message: "m", rule: "r" },
      ],
    };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(body)));

    const base = { projectKey: "P", branch: "dev", scope: "overall" };
    const dflt = await client.callTool({ name: "sonar_list_issues", arguments: base });
    const defaultUrl = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(defaultUrl.searchParams.has("assignees")).toBe(false);
    expect(defaultUrl.searchParams.has("assigned")).toBe(false);
    const text = (dflt.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("assignee: unassigned");
    expect(text).not.toContain("jane.doe@gov.bc.ca");

    await client.callTool({ name: "sonar_list_issues", arguments: { ...base, assignees: ["jane.doe"] } });
    const filtered = new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
    expect(filtered.searchParams.get("assignees")).toBe("jane.doe");
  });

  it("surfaces an upstream authorization error", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const result = await client.callTool({ name: "sonar_list_projects", arguments: {} });
    expect(result.isError).toBe(true);
  });
});
