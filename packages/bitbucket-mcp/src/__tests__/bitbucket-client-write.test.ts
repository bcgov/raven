import { describe, it, expect, vi, beforeEach } from "vitest";
import { BitbucketClient } from "../bitbucket-client.js";

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

describe("BitbucketClient write methods", () => {
  describe("createPullRequest", () => {
    it("sends POST with correct URL and body", async () => {
      const prResponse = {
        id: 42,
        title: "Add feature X",
        state: "OPEN",
        fromRef: { displayId: "feature/x" },
        toRef: { displayId: "main" },
        links: { self: [{ href: "https://bb.example.com/pr/42" }] },
      };
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: prResponse,
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      const result = await client.createPullRequest("NRS", "my-repo", {
        title: "Add feature X",
        fromBranch: "feature/x",
      });

      expect(result).toEqual(prResponse);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://bb.example.com/rest/api/1.0/projects/NRS/repos/my-repo/pull-requests"
      );
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(opts.body);
      expect(body.title).toBe("Add feature X");
      expect(body.fromRef.id).toBe("refs/heads/feature/x");
      expect(body.toRef.id).toBe("refs/heads/main");
      expect(body.reviewers).toEqual([]);
    });

    it("includes reviewers when provided", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: 1, title: "Test" },
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await client.createPullRequest("PROJ", "repo", {
        title: "Test",
        fromBranch: "dev",
        toBranch: "release/1.0",
        reviewers: ["alice", "bob"],
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.toRef.id).toBe("refs/heads/release/1.0");
      expect(body.reviewers).toEqual([
        { user: { name: "alice" } },
        { user: { name: "bob" } },
      ]);
    });

    it("includes description when provided", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: 1 },
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await client.createPullRequest("PROJ", "repo", {
        title: "Test",
        description: "Some description",
        fromBranch: "dev",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.description).toBe("Some description");
    });

    it("throws on conflict (409)", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 409,
        text: "PR already exists",
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await expect(
        client.createPullRequest("NRS", "repo", {
          title: "Duplicate",
          fromBranch: "feature/dup",
        })
      ).rejects.toThrow("Failed to create PR (409): PR already exists");
    });

    it("URL-encodes project key and repo slug", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: 1 },
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await client.createPullRequest("MY PROJ", "my repo", {
        title: "Test",
        fromBranch: "dev",
      });

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("/projects/MY%20PROJ/repos/my%20repo/");
    });
  });

  describe("createBranch", () => {
    it("sends POST with correct URL and body", async () => {
      const branchResponse = {
        id: "refs/heads/feature/new",
        displayId: "feature/new",
        type: "BRANCH",
        latestCommit: "abc123def456",
        isDefault: false,
      };
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: branchResponse,
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      const result = await client.createBranch(
        "NRS",
        "my-repo",
        "feature/new",
        "develop"
      );

      expect(result).toEqual(branchResponse);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://bb.example.com/rest/api/1.0/projects/NRS/repos/my-repo/branches"
      );
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(opts.body);
      expect(body.name).toBe("feature/new");
      expect(body.startPoint).toBe("develop");
    });

    it("uses 'main' as default startPoint", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { displayId: "hotfix/1", latestCommit: "aaa" },
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await client.createBranch("PROJ", "repo", "hotfix/1");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.startPoint).toBe("main");
    });

    it("throws on error (400 bad request)", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 400,
        text: "Invalid start point",
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await expect(
        client.createBranch("NRS", "repo", "bad-branch", "nonexistent")
      ).rejects.toThrow(
        "Failed to create branch 'bad-branch' (400): Invalid start point"
      );
    });

    it("throws on conflict (409 branch already exists)", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 409,
        text: "Branch already exists",
      });
      const client = new BitbucketClient(
        mockFetch as any,
        "https://bb.example.com"
      );

      await expect(
        client.createBranch("NRS", "repo", "main")
      ).rejects.toThrow(
        "Failed to create branch 'main' (409): Branch already exists"
      );
    });
  });

  // ---- PR review surface ----

  describe("getPullRequestDiff", () => {
    it("requests text/plain diff with contextLines param", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 200, text: "diff --git a/x b/x" });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.getPullRequestDiff("NRS", "repo", 42, 5);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/pull-requests/42/diff?");
      expect(url).toContain("contextLines=5");
      expect(opts.headers.Accept).toBe("text/plain");
    });
  });

  describe("addPullRequestComment", () => {
    it("posts a general comment when no anchor", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: 1, version: 0, text: "ok", author: { displayName: "X" }, createdDate: 0, updatedDate: 0 },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.addPullRequestComment("NRS", "repo", 42, "hello");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/pull-requests/42/comments");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.text).toBe("hello");
      expect(body.anchor).toBeUndefined();
    });

    it("includes anchor for inline comments", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: 1, version: 0, text: "ok", author: { displayName: "X" }, createdDate: 0, updatedDate: 0 },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.addPullRequestComment("NRS", "repo", 42, "nit", {
        path: "src/x.ts",
        line: 10,
        lineType: "ADDED",
        fileType: "TO",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.anchor).toEqual({ path: "src/x.ts", line: 10, lineType: "ADDED", fileType: "TO" });
    });
  });

  describe("setPullRequestStatus", () => {
    it("PUTs to participants/me with the status", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.setPullRequestStatus("NRS", "repo", 42, "APPROVED");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/pull-requests/42/participants/me");
      expect(opts.method).toBe("PUT");
      expect(JSON.parse(opts.body)).toEqual({ status: "APPROVED" });
    });
  });

  describe("mergePullRequest", () => {
    it("POSTs with the optimistic-locking version in the query string", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: {
          id: 42,
          state: "MERGED",
          title: "x",
          fromRef: { displayId: "f", repository: { slug: "r" } },
          toRef: { displayId: "main" },
          author: { user: { displayName: "x" } },
          reviewers: [],
          createdDate: 0,
          updatedDate: 0,
          links: {},
        },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.mergePullRequest("NRS", "repo", 42, 7);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/pull-requests/42/merge?");
      expect(url).toContain("version=7");
      expect(opts.method).toBe("POST");
    });
  });

  describe("declinePullRequest", () => {
    it("POSTs decline with version", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: {
          id: 42,
          state: "DECLINED",
          title: "x",
          fromRef: { displayId: "f", repository: { slug: "r" } },
          toRef: { displayId: "main" },
          author: { user: { displayName: "x" } },
          reviewers: [],
          createdDate: 0,
          updatedDate: 0,
          links: {},
        },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.declinePullRequest("NRS", "repo", 42, 7);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/pull-requests/42/decline?version=7");
      expect(opts.method).toBe("POST");
    });
  });

  describe("getPullRequestActivities pagination", () => {
    it("walks pages until isLastPage", async () => {
      const responses = [
        {
          ok: true,
          status: 200,
          body: {
            values: [{ action: "OPENED", id: 1, createdDate: 0, user: { displayName: "X" } }],
            isLastPage: false,
            size: 1,
            limit: 100,
            start: 0,
            nextPageStart: 1,
          },
        },
        {
          ok: true,
          status: 200,
          body: {
            values: [{ action: "COMMENTED", id: 2, createdDate: 0, user: { displayName: "X" } }],
            isLastPage: true,
            size: 1,
            limit: 100,
            start: 1,
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
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      const result = await client.getPullRequestActivities("NRS", "repo", 42);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(result[1]!.action).toBe("COMMENTED");
    });
  });

  // ---- Commits / blame / tags / build status (history surface) ----

  describe("listCommits", () => {
    it("threads optional filters into the query string", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { values: [], size: 0, limit: 25, start: 0, isLastPage: true },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.listCommits("NRS", "repo", {
        until: "release/3.2",
        since: "main",
        path: "src/app.ts",
        merges: "exclude",
        limit: 50,
        start: 25,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/projects/NRS/repos/repo/commits?");
      expect(url).toContain("limit=50");
      expect(url).toContain("start=25");
      expect(url).toContain("until=release%2F3.2");
      expect(url).toContain("since=main");
      expect(url).toContain("path=src%2Fapp.ts");
      expect(url).toContain("merges=exclude");
    });

    it("uses sensible defaults when no options provided", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { values: [], size: 0, limit: 25, start: 0, isLastPage: true },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.listCommits("NRS", "repo");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("limit=25");
      expect(url).toContain("start=0");
      expect(url).not.toContain("until=");
      expect(url).not.toContain("path=");
    });
  });

  describe("getCommit", () => {
    it("URL-encodes the commit SHA", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "abc", displayId: "abc", author: { name: "X", emailAddress: "x@x" }, authorTimestamp: 0, message: "m", parents: [] },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.getCommit("NRS", "repo", "abc/def");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/commits/abc%2Fdef");
    });
  });

  describe("blameFile", () => {
    it("plumbs startLine into the API as a 0-based start offset", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { lines: [{ text: "x" }], blame: [], start: 99, size: 1, isLastPage: true },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      const result = await client.blameFile("NRS", "repo", "src/x.ts", { startLine: 100 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/browse/src/x.ts?");
      expect(url).toContain("start=99"); // 1-based 100 → 0-based 99
      expect(result.start).toBe(99);
    });

    it("defaults to start=0 when startLine omitted", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { lines: [], blame: [], start: 0, size: 0, isLastPage: true },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.blameFile("NRS", "repo", "src/x.ts");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("start=0");
    });
  });

  describe("listTags", () => {
    it("respects filterText + orderBy + pagination", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { values: [], size: 0, limit: 25, start: 0, isLastPage: true },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.listTags("NRS", "repo", {
        filterText: "release/",
        orderBy: "MODIFICATION",
        limit: 10,
        start: 30,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("filterText=release%2F");
      expect(url).toContain("orderBy=MODIFICATION");
      expect(url).toContain("limit=10");
      expect(url).toContain("start=30");
    });
  });

  describe("createTag", () => {
    it("includes message for annotated tags", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "refs/tags/v3.2", displayId: "v3.2", type: "TAG", latestCommit: "abc", latestChangeset: "abc", hash: null },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.createTag("NRS", "repo", "v3.2", "main", "Release 3.2");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ name: "v3.2", startPoint: "main", message: "Release 3.2" });
    });

    it("omits message for lightweight tags", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "refs/tags/light", displayId: "light", type: "TAG", latestCommit: "abc", latestChangeset: "abc", hash: null },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.createTag("NRS", "repo", "light", "main");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message).toBeUndefined();
    });

    it("preserves an empty-string message as annotated (not truthy check)", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "refs/tags/empty", displayId: "empty", type: "TAG", latestCommit: "abc", latestChangeset: "abc", hash: null },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.createTag("NRS", "repo", "empty", "main", "");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Empty string is "given" per the tool contract — should be in the body.
      expect(body.message).toBe("");
    });
  });

  describe("getTag", () => {
    it("URL-encodes the tag name", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "refs/tags/release/3.2.1", displayId: "release/3.2.1", type: "TAG", latestCommit: "abc", latestChangeset: "abc", hash: null },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.getTag("NRS", "repo", "release/3.2.1");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/tags/release%2F3.2.1");
    });
  });

  describe("getBuildStatus pagination", () => {
    it("threads start + limit into the query string", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { values: [], size: 0, limit: 25, start: 0, isLastPage: true },
      });
      const client = new BitbucketClient(mockFetch as any, "https://bb.example.com");

      await client.getBuildStatus("abcdef", 50, 100);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/build-status/1.0/commits/abcdef?");
      expect(url).toContain("limit=50");
      expect(url).toContain("start=100");
    });
  });
});
