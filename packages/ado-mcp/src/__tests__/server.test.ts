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
  it("requires an organization for the default Cloud URL", async () => {
    vi.stubEnv("ADO_BASE_URL", undefined);
    vi.stubEnv("ADO_DEFAULT_COLLECTION", undefined);
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");

    const result = await callAdoTool("list_repos");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("ADO_DEFAULT_COLLECTION") },
    ]);
  });

  it("uses the configured organization for Cloud projects and repository requests", async () => {
    vi.stubEnv("ADO_BASE_URL", undefined);
    vi.stubEnv("ADO_DEFAULT_COLLECTION", "my-org");
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ value: [], count: 0 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const repos = await callAdoTool("list_repos");
    expect(repos.isError).not.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://dev.azure.com/my-org/MyProject/_apis/git/repositories",
    );
    const projects = await callAdoTool("list_projects");
    expect(projects.isError).not.toBe(true);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "https://dev.azure.com/my-org/_apis/projects",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a per-call organization with the same collection argument", async () => {
    vi.stubEnv("ADO_BASE_URL", undefined);
    vi.stubEnv("ADO_DEFAULT_COLLECTION", undefined);
    vi.stubEnv("ADO_PAT", "test-pat");
    vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ value: [], count: 0 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callAdoTool("list_repos", { collection: "my-org" });
    expect(result.isError).not.toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://dev.azure.com/my-org/MyProject/_apis/git/repositories",
    );
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
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://ado.example.com/OtherCollection/MyProject/_apis/git/repositories",
    );
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
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://ado.example.com/_apis/projectCollections");
    expect(String(fetchMock.mock.calls[1][0])).toContain("https://ado.example.com/DefaultCollection/_apis/projects");
  });
});
