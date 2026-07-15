import { describe, it, expect, vi } from "vitest";
import { ConfluenceClient } from "../confluence-client.js";

function createMockFetch(response: {
  ok: boolean;
  status: number;
  body?: unknown;
  text?: string;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? ""),
  });
}

/** Mock fetch that returns a different response per call, in order. */
function createSequencedMockFetch(
  responses: Array<{ ok: boolean; status: number; body?: unknown; text?: string }>
) {
  const fn = vi.fn();
  // Default impl throws so an unexpected extra fetch surfaces loudly instead of
  // resolving to `undefined` and failing somewhere downstream. The
  // `mockResolvedValueOnce` queue below takes precedence until it is drained.
  fn.mockImplementation(() => {
    throw new Error(
      "createSequencedMockFetch: unexpected fetch call beyond the provided sequence"
    );
  });
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(r.text ?? ""),
    });
  }
  return fn;
}

const BASE = "https://confluence.example.com";

const PAGE_RESPONSE = {
  id: "12345",
  title: "Test Page",
  type: "page",
  version: { number: 1 },
  _links: { webui: "/display/DEMO/Test+Page", self: "..." },
};

describe("ConfluenceClient.createPage", () => {
  it("sends POST with correct URL and body", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: PAGE_RESPONSE });
    const client = new ConfluenceClient(mockFetch, BASE);

    const result = await client.createPage("DEMO", "Test Page", "<p>Hello</p>");

    expect(result.id).toBe("12345");
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/content`);
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.type).toBe("page");
    expect(body.title).toBe("Test Page");
    expect(body.space.key).toBe("DEMO");
    expect(body.body.storage.value).toBe("<p>Hello</p>");
    expect(body.body.storage.representation).toBe("storage");
    expect(body.ancestors).toBeUndefined();
  });

  it("includes ancestors when parentId is provided", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: PAGE_RESPONSE });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.createPage("DEMO", "Child", "<p>x</p>", "123456789");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.ancestors).toEqual([{ id: "123456789" }]);
  });

  it("throws on error response", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 400,
      text: "Duplicate title",
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await expect(
      client.createPage("DEMO", "Dup", "<p>x</p>")
    ).rejects.toThrow("Failed to create page (400)");
  });
});

describe("ConfluenceClient.updatePage", () => {
  it("sends PUT with correct URL, body, and version", async () => {
    const updated = { ...PAGE_RESPONSE, version: { number: 2 } };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: updated });
    const client = new ConfluenceClient(mockFetch, BASE);

    const result = await client.updatePage("12345", "Updated", "<p>New</p>", 2);

    expect(result.version.number).toBe(2);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/content/12345`);
    expect(opts.method).toBe("PUT");

    const body = JSON.parse(opts.body);
    expect(body.title).toBe("Updated");
    expect(body.body.storage.value).toBe("<p>New</p>");
    expect(body.version.number).toBe(2);
  });

  it("throws on 409 version conflict", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 409,
      text: "Version conflict",
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await expect(
      client.updatePage("12345", "X", "<p>x</p>", 1)
    ).rejects.toThrow("Failed to update page 12345 (409)");
  });
});

describe("ConfluenceClient.search pagination", () => {
  it("threads start + limit into the CQL search query string", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { results: [], totalSize: 0, start: 0, limit: 10 },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.search('text ~ "foo"', 25, 50);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/rest/api/search?");
    expect(url).toContain("limit=25");
    expect(url).toContain("start=50");
  });
});

describe("ConfluenceClient.getPageChildren", () => {
  it("requests the child/page endpoint with limit + start + expand", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { results: [], size: 0, start: 0, limit: 25 },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.getPageChildren("12345", 25, 50);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`${BASE}/rest/api/content/12345/child/page?`);
    expect(url).toContain("limit=25");
    expect(url).toContain("start=50");
    expect(url).toContain("expand=history.lastUpdated");
  });

  it("URL-encodes the page ID", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { results: [], size: 0, start: 0, limit: 25 },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.getPageChildren("weird/id");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("weird%2Fid");
  });
});

describe("ConfluenceClient.getPageAncestors", () => {
  it("requests the content endpoint with expand=ancestors,space", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { id: "12345", title: "X", type: "page", ancestors: [] },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.getPageAncestors("12345");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`${BASE}/rest/api/content/12345?`);
    expect(url).toMatch(/expand=ancestors(%2C|,)space/);
  });
});

// ---- Attachments ----

describe("ConfluenceClient.getAttachments", () => {
  it("requests the child/attachment endpoint with limit + start + expand", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { results: [], size: 0, start: 0, limit: 25 },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.getAttachments("12345", 50, 25);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`${BASE}/rest/api/content/12345/child/attachment?`);
    expect(url).toContain("limit=50");
    expect(url).toContain("start=25");
    expect(url).toMatch(/expand=version(%2C|,)metadata\.mediaType(%2C|,)extensions/);
  });
});

describe("ConfluenceClient.uploadAttachment", () => {
  const emptyPage = { results: [], start: 0, limit: 200, size: 0 };

  it("POSTs multipart to the create endpoint when no same-named attachment exists", async () => {
    const mockFetch = createSequencedMockFetch([
      // preflight attachment lookup — no match
      { ok: true, status: 200, body: emptyPage },
      // create response (already paged)
      { ok: true, status: 200, body: { results: [{ id: "att1", title: "x.png", type: "attachment" }], start: 0, limit: 1, size: 1 } },
    ]);
    const client = new ConfluenceClient(mockFetch, BASE);

    const result = await client.uploadAttachment("12345", "x.png", new Uint8Array([1, 2, 3]), {
      mimeType: "image/png",
      comment: "v2",
    });

    // calls[0] is the preflight GET; calls[1] is the upload POST.
    const [getUrl] = mockFetch.mock.calls[0];
    expect(getUrl).toContain(`${BASE}/rest/api/content/12345/child/attachment?`);

    const [postUrl, opts] = mockFetch.mock.calls[1];
    expect(postUrl).toBe(`${BASE}/rest/api/content/12345/child/attachment`);
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Atlassian-Token"]).toBe("no-check");
    expect(opts.body).toBeInstanceOf(FormData);
    const fd = opts.body as FormData;
    expect(fd.get("comment")).toBe("v2");
    expect((fd.get("file") as File).name).toBe("x.png");

    expect(result.results[0]!.id).toBe("att1");
  });

  it("versions the existing attachment and normalizes the single-object response", async () => {
    const mockFetch = createSequencedMockFetch([
      { ok: true, status: 200, body: { results: [{ id: "att9", title: "x.png", type: "attachment" }], start: 0, limit: 200, size: 1 } },
      // version endpoint returns a single attachment object, not a paged wrapper
      { ok: true, status: 200, body: { id: "att9", title: "x.png", type: "attachment", version: { number: 2 } } },
    ]);
    const client = new ConfluenceClient(mockFetch, BASE);

    const result = await client.uploadAttachment("12345", "x.png", new Uint8Array([1, 2, 3]));

    const [postUrl, opts] = mockFetch.mock.calls[1];
    expect(postUrl).toBe(`${BASE}/rest/api/content/12345/child/attachment/att9/data`);
    expect(opts.method).toBe("POST");

    // single object normalized to the paged shape callers expect
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe("att9");
    expect(result.size).toBe(1);
  });

  it("walks attachment pages so a duplicate beyond the first page is still versioned", async () => {
    const firstPage = {
      results: Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, title: `other${i}.png`, type: "attachment" })),
      start: 0,
      limit: 200,
      size: 200,
    };
    const secondPage = {
      results: [{ id: "att-target", title: "x.png", type: "attachment" }],
      start: 200,
      limit: 200,
      size: 1,
    };
    const mockFetch = createSequencedMockFetch([
      { ok: true, status: 200, body: firstPage },
      { ok: true, status: 200, body: secondPage },
      { ok: true, status: 200, body: { id: "att-target", title: "x.png", type: "attachment", version: { number: 2 } } },
    ]);
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.uploadAttachment("12345", "x.png", new Uint8Array([1]));

    // two preflight GETs (page 1 full, page 2 short), then the version POST
    expect(mockFetch.mock.calls[0][0]).toContain("start=0");
    expect(mockFetch.mock.calls[1][0]).toContain("start=200");
    expect(mockFetch.mock.calls[2][0]).toBe(`${BASE}/rest/api/content/12345/child/attachment/att-target/data`);
  });

  it("keeps paging when the server caps limit below the requested page size", async () => {
    // Requested 200 but the server caps to 50: a short first page that equals
    // the response limit must NOT be mistaken for EOF.
    const firstPage = {
      results: Array.from({ length: 50 }, (_, i) => ({ id: `a${i}`, title: `other${i}.png`, type: "attachment" })),
      start: 0,
      limit: 50,
      size: 50,
    };
    const secondPage = {
      results: [{ id: "att-target", title: "x.png", type: "attachment" }],
      start: 50,
      limit: 50,
      size: 1,
    };
    const mockFetch = createSequencedMockFetch([
      { ok: true, status: 200, body: firstPage },
      { ok: true, status: 200, body: secondPage },
      { ok: true, status: 200, body: { id: "att-target", title: "x.png", type: "attachment", version: { number: 2 } } },
    ]);
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.uploadAttachment("12345", "x.png", new Uint8Array([1]));

    expect(mockFetch.mock.calls[1][0]).toContain("start=50");
    expect(mockFetch.mock.calls[2][0]).toBe(`${BASE}/rest/api/content/12345/child/attachment/att-target/data`);
  });

  it("stops scanning at the cap when pagination never terminates", async () => {
    // Pathological server: every lookup returns a full page that never matches
    // and never shorts out. The maxScan cap (5000 / 200 = 25 pages) must stop
    // the loop, then fall through to the create endpoint instead of hanging.
    const fullPage = {
      results: Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, title: `other${i}.png`, type: "attachment" })),
      start: 0,
      limit: 200,
      size: 200,
    };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: fullPage });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.uploadAttachment("12345", "x.png", new Uint8Array([1]));

    // 25 bounded preflight GETs + 1 create POST — not an unbounded loop.
    expect(mockFetch).toHaveBeenCalledTimes(26);
    const [lastUrl, lastOpts] = mockFetch.mock.calls[25];
    expect(lastUrl).toBe(`${BASE}/rest/api/content/12345/child/attachment`);
    expect(lastOpts.method).toBe("POST");
  });

  it("throws when the upload request fails", async () => {
    const mockFetch = createSequencedMockFetch([
      { ok: true, status: 200, body: emptyPage },
      { ok: false, status: 400, text: "Cannot add a new attachment with same file name" },
    ]);
    const client = new ConfluenceClient(mockFetch, BASE);

    await expect(
      client.uploadAttachment("12345", "x.png", new Uint8Array([1]))
    ).rejects.toThrow("Failed to upload attachment to 12345 (400)");
  });
});

// ---- Labels ----

describe("ConfluenceClient.getLabels", () => {
  it("GETs the /label endpoint with pagination params and URL-encodes the pageId", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { results: [{ prefix: "global", name: "policy" }], start: 0, limit: 50, size: 1 },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    const result = await client.getLabels("weird/id");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`${BASE}/rest/api/content/weird%2Fid/label?`);
    expect(url).toContain("limit=50");
    expect(url).toContain("start=0");
    expect(result.labels).toHaveLength(1);
    expect(result.labels[0]!.name).toBe("policy");
    expect(result.count).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("walks pages until a short page indicates the end", async () => {
    const responses = [
      {
        ok: true,
        status: 200,
        body: {
          results: Array.from({ length: 50 }, (_, i) => ({ prefix: "global", name: `l${i}` })),
          start: 0,
          limit: 50,
          size: 50,
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          results: Array.from({ length: 10 }, (_, i) => ({ prefix: "global", name: `l${50 + i}` })),
          start: 50,
          limit: 50,
          size: 10,
        },
      },
    ];
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      const r = responses[call++]!;
      return Promise.resolve({
        ok: r.ok,
        status: r.status,
        json: () => Promise.resolve(r.body),
        text: () => Promise.resolve(""),
      });
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    const result = await client.getLabels("12345");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.labels).toHaveLength(60);
    expect(result.count).toBe(60);
    expect(result.truncated).toBe(false);
  });
});

describe("ConfluenceClient.addLabels", () => {
  it("POSTs an array of {prefix: 'global', name} objects", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { results: [] } });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.addLabels("12345", ["policy", "review"]);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/content/12345/label`);
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual([
      { prefix: "global", name: "policy" },
      { prefix: "global", name: "review" },
    ]);
  });
});

describe("ConfluenceClient.removeLabel", () => {
  it("DELETEs with name query param", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 204 });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.removeLabel("12345", "policy");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain(`${BASE}/rest/api/content/12345/label?`);
    expect(url).toContain("name=policy");
    expect(opts.method).toBe("DELETE");
  });
});

// ---- Comments ----

describe("ConfluenceClient.getPageComments", () => {
  it("requests child/comment with depth=all and storage expand", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { results: [], size: 0, start: 0, limit: 25 },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.getPageComments("12345");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`${BASE}/rest/api/content/12345/child/comment?`);
    expect(url).toContain("depth=all");
    expect(url).toContain("body.storage");
  });
});

describe("ConfluenceClient.addPageComment", () => {
  it("POSTs type=comment with container reference to the page", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { id: "c1", type: "comment" },
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.addPageComment("12345", "<p>hi</p>");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/content`);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.type).toBe("comment");
    expect(body.container).toEqual({ id: "12345", type: "page" });
    expect(body.body.storage.value).toBe("<p>hi</p>");
  });
});

// ---- Page lifecycle ----

describe("ConfluenceClient.deletePage", () => {
  it("DELETEs the content endpoint", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 204 });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.deletePage("12345");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/content/12345`);
    expect(opts.method).toBe("DELETE");
  });
});

describe("ConfluenceClient.movePage", () => {
  it("reads current state and PUTs with new ancestors + bumped version", async () => {
    const current = {
      id: "12345",
      title: "Existing",
      type: "page",
      body: { storage: { value: "<p>body</p>" } },
      version: { number: 3 },
    };
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(current),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ id: "12345", title: "Existing", type: "page", version: { number: 4 }, _links: { webui: "/x", self: "" } }),
        text: () => Promise.resolve(""),
      });
    });
    const client = new ConfluenceClient(mockFetch, BASE);

    await client.movePage("12345", "99999");

    const [, putOpts] = mockFetch.mock.calls[1]!;
    const body = JSON.parse(putOpts.body);
    expect(body.title).toBe("Existing");
    expect(body.body.storage.value).toBe("<p>body</p>");
    expect(body.version.number).toBe(4);
    expect(body.ancestors).toEqual([{ id: "99999" }]);
  });
});

