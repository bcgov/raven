import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdoServer } from "../server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function callAdoTool(name: string, args: Record<string, unknown> = {}) {
  const server = createAdoServer();
  const client = new Client({ name: "ado-test", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await client.callTool({ name, arguments: args });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

describe("ADO Cloud and Server configuration", () => {
  it("rejects a PAT without an explicit URL even when a collection is set", async () => {
    vi.stubEnv("ADO_BASE_URL", undefined);
    vi.stubEnv("ADO_DEFAULT_COLLECTION", "my-org");
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAdoTool("list_repos");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("ADO_BASE_URL is not set") },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the configured organization for Cloud projects and repository requests", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://dev.azure.com");
    vi.stubEnv("ADO_DEFAULT_COLLECTION", "my-org");
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ value: [], count: 0 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repos = await callAdoTool("list_repos");
    expect(repos.isError).not.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toEqual(expect.stringContaining(
      "https://dev.azure.com/my-org/MyProject/_apis/git/repositories",
    ));
    const projects = await callAdoTool("list_projects");
    expect(projects.isError).not.toBe(true);
    expect(fetchMock.mock.calls[1][0]).toEqual(expect.stringContaining(
      "https://dev.azure.com/my-org/_apis/projects",
    ));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a per-call organization with the same collection argument", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://dev.azure.com");
    vi.stubEnv("ADO_DEFAULT_COLLECTION", undefined);
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: [], count: 0 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callAdoTool("list_repos", { collection: "my-org" });
    expect(result.isError).not.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toEqual(expect.stringContaining(
      "https://dev.azure.com/my-org/MyProject/_apis/git/repositories",
    ));
  });

  it("retains per-call collection selection for an on-prem Server", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://ado.example.com");
    vi.stubEnv("ADO_DEFAULT_COLLECTION", "DefaultCollection");
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: [], count: 0 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callAdoTool("list_repos", { collection: "OtherCollection" });
    expect(result.isError).not.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toEqual(expect.stringContaining(
      "https://ado.example.com/OtherCollection/MyProject/_apis/git/repositories",
    ));
  });

  it("continues discovering on-prem collections before listing their projects", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://ado.example.com");
    vi.stubEnv("ADO_PAT", "test-pat");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{ name: "DefaultCollection" }], count: 1,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{ name: "MyProject", state: "wellFormed" }], count: 1,
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callAdoTool("list_projects");
    expect(result.isError).not.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toEqual(expect.stringContaining("https://ado.example.com/_apis/projectCollections"));
    expect(fetchMock.mock.calls[1][0]).toEqual(expect.stringContaining("https://ado.example.com/DefaultCollection/_apis/projects"));
  });

  it("requires a configured organization for Cloud project listing", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://dev.azure.com");
    vi.stubEnv("ADO_DEFAULT_COLLECTION", undefined);
    vi.stubEnv("ADO_PAT", "test-pat");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAdoTool("list_projects");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("ADO_DEFAULT_COLLECTION");
    expect(JSON.stringify(result.content)).not.toContain("supply collection");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Cloud classic release listing without making an API call", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://dev.azure.com");
    vi.stubEnv("ADO_DEFAULT_COLLECTION", "my-org");
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAdoTool("list_release_pipelines");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Server only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrubs work item names, descriptions, and comments in tool output", async () => {
    vi.stubEnv("ADO_BASE_URL", "https://ado.example.com");
    vi.stubEnv("ADO_DEFAULT_COLLECTION", "DefaultCollection");
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    vi.stubEnv("RAVEN_SCRUB_PI", "true");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 3,
        fields: {
          "System.Title": "Call jane.smith@example.com",
          "System.AssignedTo": { displayName: "Jane Smith" },
          "System.Description": "Jane Smith is reachable at jane.smith@example.com",
        },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        comments: [{ createdBy: { displayName: "John Doe" }, createdDate: "2026-01-01T00:00:00Z", text: "Contact Jane Smith" }],
      })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callAdoTool("get_work_item", { id: 3 });
    expect(result.isError).not.toBe(true);
    const response = JSON.stringify(result.content);
    expect(response).toContain("Person-1");
    expect(response).toContain("Person-2");
    expect(response).toContain("[EMAIL]");
    expect(response).not.toContain("Jane Smith");
    expect(response).not.toContain("John Doe");
    expect(response).not.toContain("jane.smith@example.com");
  });
});
