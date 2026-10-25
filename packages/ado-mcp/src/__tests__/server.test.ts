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

});

describe("ADO work item history and comments", () => {
    function configure() {
      vi.stubEnv("ADO_BASE_URL", "https://dev.azure.com");
      vi.stubEnv("ADO_DEFAULT_COLLECTION", "my-org");
      vi.stubEnv("ADO_PAT", "test-pat");
      vi.stubEnv("ADO_DEFAULT_PROJECT", "MyProject");
    }

    it("returns paged changes with revised identity and scrubbed multilingual text", async () => {
      configure();
      vi.stubEnv("RAVEN_SCRUB_PI", "true");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        count: 1,
        value: [{
          id: 2,
          rev: 2,
          revisedBy: { displayName: "Jane Smith" },
          revisedDate: "2026-10-01T12:00:00Z",
          fields: {
            "System.Title": { oldValue: "Old", newValue: "<p>ᐊᓂ  e\u0313 Jane Smith jane.smith@example.com</p>" },
            "System.State": { oldValue: "New", newValue: "Active" },
          },
          relations: { added: [{ rel: "System.LinkTypes.Related", url: "https://example.com/42" }] },
        }],
      })));
      vi.stubGlobal("fetch", fetchMock);

      const result = await callAdoTool("get_work_item_history", { id: 42, top: 5, skip: 1 });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("Revision 2");
      expect(text).toContain("System.State");
      expect(text).toContain("New");
      expect(text).toContain("Active");
      expect(text).toContain("System.LinkTypes.Related");
      expect(text).toContain("ᐊᓂ");
      expect(text).toContain("e\u0313");
      expect(text).toContain("Person-1");
      expect(text).toContain("[EMAIL]");
      expect(text).not.toContain("Jane Smith");
      expect(text).not.toContain("jane.smith@example.com");
      expect(text).not.toContain("<p>");
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe("/my-org/MyProject/_apis/wit/workitems/42/updates");
      expect(url.searchParams.get("$top")).toBe("5");
      expect(url.searchParams.get("$skip")).toBe("1");
    });

    it("reports upstream history errors instead of an empty history", async () => {
      configure();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Not Found", { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAdoTool("get_work_item_history", { id: 42 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("ADO API error 404");
    });

    it("returns a genuine empty history page without a false total", async () => {
      configure();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ count: 0, value: [] })));
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAdoTool("get_work_item_history", { id: 42, skip: 100 });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("No updates in this page.");
    });

    it("scrubs PI before truncating values and preserves Unicode graphemes", async () => {
      configure();
      vi.stubEnv("RAVEN_SCRUB_PI", "true");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        count: 1,
        value: [{
          id: 3,
          rev: 3,
          revisedBy: { displayName: "Jane Smith" },
          revisedDate: "2026-10-01T12:00:00Z",
          fields: {
            "System.Description": { newValue: `${"x".repeat(475)} Jane Smith jane.smith@example.com` },
            "System.Title": { newValue: `${"y".repeat(499)}e\u0313 end` },
            "System.Tags": { newValue: `${"z".repeat(499)}😀 end` },
          },
        }],
      })));
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAdoTool("get_work_item_history", { id: 42 });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("Person-1");
      expect(text).toContain("[EMAIL]");
      expect(text).not.toContain("jane.smith@");
      expect(text).not.toContain("Jane Smi");
      expect(text).toContain("e\u0313… (truncated)");
      expect(text).toContain("😀… (truncated)");
    });

    it("registers later revision authors and field identities before truncating earlier values", async () => {
      configure();
      vi.stubEnv("RAVEN_SCRUB_PI", "true");
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        count: 2,
        value: [
          {
            id: 1,
            rev: 1,
            revisedBy: { displayName: "First Editor" },
            revisedDate: "2026-10-01T12:00:00Z",
            fields: {
              "System.Description": { newValue: `${"x".repeat(495)} Amara Boundary` },
              "System.Title": { newValue: `${"y".repeat(495)} Nora Westfall` },
              "System.Tags": { newValue: `${"z".repeat(495)} Elena Cedarwood` },
            },
          },
          {
            id: 2,
            rev: 2,
            revisedBy: { displayName: "Amara Boundary" },
            revisedDate: "2026-10-02T12:00:00Z",
            fields: {
              "System.AssignedTo": {
                oldValue: { displayName: "Nora Westfall" },
                newValue: { displayName: "Elena Cedarwood" },
              },
            },
          },
        ],
      })));
      vi.stubGlobal("fetch", fetchMock);

      const result = await callAdoTool("get_work_item_history", { id: 42 });
      expect(result.isError).not.toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).not.toContain(" Amar…");
      expect(text).not.toContain(" Nora…");
      expect(text).not.toContain(" Elen…");
      expect(text).not.toContain("Amara Boundary");
      expect(text).not.toContain("Nora Westfall");
      expect(text).not.toContain("Elena Cedarwood");
      expect(text).toMatch(/System\.AssignedTo: Person-\d+ → Person-\d+/);
      expect(text).toContain("Revision 2");
    });

    it("posts the comment unchanged and reports success only after ADO accepts it", async () => {
      configure();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 7, text: "ᐊᓂ e\u0313" })));
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAdoTool("add_work_item_comment", { id: 42, text: "ᐊᓂ e\u0313" });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("Comment added to work item #42");
      const [rawUrl, options] = fetchMock.mock.calls[0];
      const url = new URL(String(rawUrl));
      expect(url.pathname).toBe("/my-org/MyProject/_apis/wit/workitems/42/comments");
      expect(url.searchParams.get("api-version")).toBe("7.0-preview.3");
      expect(options?.method).toBe("POST");
      expect(options?.body).toBe(JSON.stringify({ text: "ᐊᓂ e\u0313" }));
    });

    it("rejects an empty comment before posting", async () => {
      configure();
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAdoTool("add_work_item_comment", { id: 42, text: " \n " });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports comment write failures", async () => {
      configure();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Forbidden", { status: 403 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await callAdoTool("add_work_item_comment", { id: 42, text: "hello" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("ADO API error 403");
    });
});

describe("ADO Cloud and Server configuration", () => {
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
    expect(response).toMatch(/Comments:.*Person-\d+/s);
    expect(response).toContain("[EMAIL]");
    expect(response).not.toContain("Jane Smith");
    expect(response).not.toContain("John Doe");
    expect(response).not.toContain("jane.smith@example.com");
  });
});
