import { describe, it, expect, vi } from "vitest";
import {
  BitbucketClient,
  CodeSearchNotAvailableError,
} from "../bitbucket-client.js";

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

const SEARCH_RESPONSE = {
  code: {
    count: 2,
    values: [
      {
        repository: {
          slug: "my-repo",
          name: "My Repo",
          project: { key: "NRS", name: "NRS Project" },
        },
        file: "src/main/java/Handler.java",
        hitContexts: [
          [
            { line: 10, text: "import <em>com.example</em>.Handler;" },
            { line: 11, text: "public class Handler {" },
          ],
        ],
      },
      {
        repository: {
          slug: "other-repo",
          name: "Other Repo",
          project: { key: "NRS", name: "NRS Project" },
        },
        file: "src/test/java/HandlerTest.java",
        hitContexts: [
          [{ line: 5, text: "class <em>Handler</em>Test {" }],
        ],
      },
    ],
    isLastPage: true,
    start: 0,
    nextStart: 0,
  },
};

describe("BitbucketClient searchCode", () => {
  it("sends POST with JSON body to /rest/search/latest/search", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: SEARCH_RESPONSE,
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    const result = await client.searchCode("Handler");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://bb.example.com/rest/search/latest/search");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.query).toBe("Handler");
    expect(body.entities.code.limit).toBe(25);
  });

  it("prefixes query with project:KEY when projectKey given", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: SEARCH_RESPONSE,
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await client.searchCode("Handler", "NRS");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.query).toBe("project:NRS Handler");
  });

  it("prefixes query with repo:KEY/slug when both given", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: SEARCH_RESPONSE,
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await client.searchCode("Handler", "NRS", "my-repo");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.query).toBe("repo:NRS/my-repo Handler");
  });

  it("passes custom limit into entities.code.limit", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: SEARCH_RESPONSE,
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await client.searchCode("Handler", undefined, undefined, 10);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.entities.code.limit).toBe(10);
  });

  it("returns the parsed response structure", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: SEARCH_RESPONSE,
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    const result = await client.searchCode("Handler");

    expect(result.code.count).toBe(2);
    expect(result.code.values).toHaveLength(2);
    expect(result.code.values[0].file).toBe("src/main/java/Handler.java");
    expect(result.code.values[0].repository.slug).toBe("my-repo");
    expect(result.code.values[0].hitContexts[0][0].line).toBe(10);
  });

  it("throws CodeSearchNotAvailableError on 405", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 405,
      text: "Method Not Allowed",
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await expect(client.searchCode("test")).rejects.toThrow(
      CodeSearchNotAvailableError
    );
  });

  it("throws CodeSearchNotAvailableError on 404", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 404,
      text: "Not Found",
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await expect(client.searchCode("test")).rejects.toThrow(
      CodeSearchNotAvailableError
    );
  });

  it("throws descriptive error on other failures", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 400,
      text: JSON.stringify({ errors: [{ message: "Invalid query" }] }),
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await expect(client.searchCode("***")).rejects.toThrow(
      "Code search failed (400): Invalid query"
    );
  });

  it("handles non-JSON error bodies gracefully", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 500,
      text: "Internal Server Error",
    });
    const client = new BitbucketClient(
      mockFetch as any,
      "https://bb.example.com"
    );

    await expect(client.searchCode("test")).rejects.toThrow(
      "Code search failed (500): Internal Server Error"
    );
  });
});
