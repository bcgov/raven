import { describe, it, expect, vi } from "vitest";
import { AdoClient } from "../ado-client.js";

// ---------------------------------------------------------------------------
// Mock fetch factory — same pattern used across other MCP packages
// ---------------------------------------------------------------------------

function createMockFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: unknown;
  text?: string;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? (response.ok ? "OK" : "Error"),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? JSON.stringify(response.body ?? {})),
  });
}

// ---------------------------------------------------------------------------
// Constructor — URL normalisation & auth header
// ---------------------------------------------------------------------------

describe("AdoClient constructor", () => {
  it("strips trailing slashes from baseUrl", () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { value: [] } });
    const client = new AdoClient("https://ado.example.com///", "pat123", "7.1", mockFetch as any);

    // Trigger a request so we can inspect the URL built
    client.listCollections();
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/ado\.example\.com\//);
    expect(url).not.toMatch(/\/\/\//);
  });

  it("encodes PAT as Base64 Basic auth with empty username", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { value: [] } });
    const client = new AdoClient("https://ado.example.com", "my-secret-pat", "7.1", mockFetch as any);

    await client.listCollections();
    const opts = mockFetch.mock.calls[0][1];
    const expected = `Basic ${Buffer.from(":my-secret-pat").toString("base64")}`;
    expect(opts.headers.Authorization).toBe(expected);
  });

  it("uses default api-version 7.1 when not specified", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { value: [] } });
    const client = new AdoClient("https://ado.example.com", "pat", undefined, mockFetch as any);

    await client.listCollections();
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("api-version=7.1");
  });

  it("accepts a custom api-version", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { value: [] } });
    const client = new AdoClient("https://ado.example.com", "pat", "5.1", mockFetch as any);

    await client.listCollections();
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("api-version=5.1");
  });
});

// ---------------------------------------------------------------------------
// projectPrefix — collection-scoped URL building
// ---------------------------------------------------------------------------

describe("URL path building with collection", () => {
  it("builds project-only path when no collection given", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { value: [], count: 0 },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.listRepositories("MyProject");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/MyProject/_apis/git/repositories");
    expect(url).not.toContain("ECON");
  });

  it("builds collection/project path when collection is given", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { value: [], count: 0 },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.listRepositories("MyProject", "ECON");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/ECON/MyProject/_apis/git/repositories");
  });

  it("encodes special characters in project and collection names", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { value: [], count: 0 },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.listRepositories("My Project", "LBR Projects Collection");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("LBR%20Projects%20Collection");
    expect(url).toContain("My%20Project");
  });

  it("propagates collection through to WIQL queries", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { workItems: [], columns: [], queryType: "flat", asOf: "" },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.queryWiql("SELECT [System.Id] FROM WorkItems", "Proj", 10, "ECON");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/ECON/Proj/_apis/wit/wiql");
  });

  it("propagates collection through to browseFiles", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { value: [], count: 0 },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.browseFiles("Proj", "my-repo", "/", "main", "ECON");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/ECON/Proj/_apis/git/repositories/my-repo/items");
  });

  it("propagates collection through to listPipelines", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { value: [], count: 0 },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.listPipelines("Proj", "ECON");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/ECON/Proj/_apis/pipelines");
  });
});

// ---------------------------------------------------------------------------
// readFile — custom request path (not via this.request)
// ---------------------------------------------------------------------------

describe("readFile", () => {
  it("builds correct URL with collection and branch", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      text: "file content here",
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    const content = await client.readFile("Proj", "repo", "/src/App.cs", "develop", "ECON");
    expect(content).toBe("file content here");

    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/ECON/Proj/_apis/git/repositories/repo/items");
    expect(url).toContain("path=%2Fsrc%2FApp.cs");
    expect(url).toContain("versionDescriptor=develop");
    expect(url).toContain("versionType=branch");
  });

  it("requests text/plain Accept header", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      text: "hello",
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.readFile("Proj", "repo", "/f.txt");
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers.Accept).toBe("text/plain");
  });
});

// ---------------------------------------------------------------------------
// Error handling — truncation and formatting
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("throws with status code and truncated body on request failure", async () => {
    const longBody = "x".repeat(1000);
    const mockFetch = createMockFetch({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: longBody,
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await expect(client.listRepositories("Proj")).rejects.toThrow("ADO API error 404 Not Found");
    try {
      await client.listRepositories("Proj");
    } catch (err: any) {
      // Body should be truncated to 500 chars
      expect(err.message.length).toBeLessThanOrEqual(500 + 100); // some overhead for prefix
    }
  });

  it("throws with status code on readFile failure", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: '{"message":"file not found"}',
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await expect(client.readFile("Proj", "repo", "/missing.txt")).rejects.toThrow(
      "ADO file read error 404"
    );
  });

  it("handles 204 No Content as empty object", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 204, body: {} });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    // addWorkItemComment returns void via 204 path
    await expect(client.addWorkItemComment(1, "Proj", "hello")).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listProjects — uses custom URL construction (not this.request)
// ---------------------------------------------------------------------------

describe("listProjects", () => {
  it("builds URL with collection prefix and $top param", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { value: [{ name: "P1", state: "wellFormed" }], count: 1 },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    await client.listProjects("ECON");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("/ECON/_apis/projects");
    expect(url).toContain("$top=200");
    expect(url).toContain("api-version=7.1");
  });
});

// ---------------------------------------------------------------------------
// getWorkItems — batching
// ---------------------------------------------------------------------------

describe("getWorkItems", () => {
  it("returns empty array for empty id list", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    const items = await client.getWorkItems([], "Proj");
    expect(items).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("passes ids as comma-separated query param", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: {
        value: [
          { id: 1, rev: 1, fields: {}, url: "" },
          { id: 2, rev: 1, fields: {}, url: "" },
        ],
      },
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    const items = await client.getWorkItems([1, 2], "Proj");
    expect(items).toHaveLength(2);
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("ids=1%2C2");
  });
});

// ---------------------------------------------------------------------------
// createPullRequest
// ---------------------------------------------------------------------------

describe("createPullRequest", () => {
  it("sends POST with correct body and collection prefix", async () => {
    const prResponse = {
      pullRequestId: 10,
      title: "My PR",
      status: "active",
      sourceRefName: "refs/heads/feature/x",
      targetRefName: "refs/heads/main",
      createdBy: { displayName: "User" },
      reviewers: [],
    };
    const mockFetch = createMockFetch({
      ok: true,
      status: 201,
      body: prResponse,
    });
    const client = new AdoClient("https://ado.example.com", "pat", "7.1", mockFetch as any);

    const result = await client.createPullRequest("Proj", "repo", {
      title: "My PR",
      sourceRefName: "refs/heads/feature/x",
      targetRefName: "refs/heads/main",
    }, "ECON");

    expect(result.pullRequestId).toBe(10);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/ECON/Proj/_apis/git/repositories/repo/pullrequests");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.title).toBe("My PR");
    expect(body.sourceRefName).toBe("refs/heads/feature/x");
  });
});
