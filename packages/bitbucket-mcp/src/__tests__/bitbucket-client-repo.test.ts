import { describe, it, expect, vi } from "vitest";
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

const BASE = "https://bb.example.com";

describe("BitbucketClient.createRepo", () => {
  it("POSTs name and scmId git to the project repos endpoint", async () => {
    const repo = {
      slug: "my-new-repo",
      name: "My New Repo",
      project: { key: "NRS", name: "NRS" },
      state: "AVAILABLE",
      forkable: true,
      links: { clone: [{ href: `${BASE}/scm/nrs/my-new-repo.git`, name: "http" }] },
    };
    const mockFetch = createMockFetch({ ok: true, status: 201, body: repo });
    const client = new BitbucketClient(mockFetch as any, BASE);

    const result = await client.createRepo("NRS", "My New Repo", {
      description: "A test repo",
    });

    expect(result).toEqual(repo);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/1.0/projects/NRS/repos`);
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({
      name: "My New Repo",
      scmId: "git",
      forkable: true,
      description: "A test repo",
    });
  });

  it("omits description when not given and honours forkable false", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 201, body: {} });
    const client = new BitbucketClient(mockFetch as any, BASE);
    await client.createRepo("NRS", "r", { forkable: false });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ name: "r", scmId: "git", forkable: false });
  });

  it("throws with status and body on conflict (409 name taken)", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 409,
      text: "This repository URL is already taken",
    });
    const client = new BitbucketClient(mockFetch as any, BASE);
    await expect(client.createRepo("NRS", "taken")).rejects.toThrow(
      /create repository "taken" in NRS \(409\).*already taken/
    );
  });
});

describe("BitbucketClient.fileType", () => {
  it("requests browse?type=true and returns FILE", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { type: "FILE" } });
    const client = new BitbucketClient(mockFetch as any, BASE);
    const result = await client.fileType("NRS", "repo", "docs/read me.md", "refs/heads/main");
    expect(result).toBe("FILE");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `${BASE}/rest/api/1.0/projects/NRS/repos/repo/browse/docs/read%20me.md?type=true&at=refs%2Fheads%2Fmain`
    );
  });

  it("returns null on 404 and DIRECTORY for a directory", async () => {
    const notFound = createMockFetch({ ok: false, status: 404, text: "nope" });
    expect(
      await new BitbucketClient(notFound as any, BASE).fileType("NRS", "repo", "missing.txt")
    ).toBeNull();

    const dir = createMockFetch({ ok: true, status: 200, body: { type: "DIRECTORY" } });
    expect(await new BitbucketClient(dir as any, BASE).fileType("NRS", "repo", "docs")).toBe(
      "DIRECTORY"
    );
  });

  it("returns null when only the path is missing at an existing ref", async () => {
    const notFound = createMockFetch({
      ok: false,
      status: 404,
      text: JSON.stringify({
        errors: [
          {
            context: null,
            message: 'The path "missing.txt" does not exist at revision "refs/heads/main"',
            exceptionName: "com.atlassian.bitbucket.content.NoSuchPathException",
          },
        ],
      }),
    });
    expect(
      await new BitbucketClient(notFound as any, BASE).fileType("NRS", "repo", "missing.txt", "refs/heads/main")
    ).toBeNull();
  });

  it("returns REF_MISSING when the ref itself does not resolve (the same 404 status)", async () => {
    // Body shape observed from a real Bitbucket Data Center instance.
    const notFound = createMockFetch({
      ok: false,
      status: 404,
      text: JSON.stringify({
        errors: [
          {
            context: null,
            message: 'Object "refs/heads/does-not-exist" does not exist in repository \'repo\'',
            exceptionName: "com.atlassian.bitbucket.NoSuchObjectException",
          },
        ],
      }),
    });
    expect(
      await new BitbucketClient(notFound as any, BASE).fileType("NRS", "repo", "a.txt", "refs/heads/does-not-exist")
    ).toBe("REF_MISSING");
  });

  it("throws when the repository or project does not exist", async () => {
    const notFound = createMockFetch({
      ok: false,
      status: 404,
      text: JSON.stringify({
        errors: [
          {
            message: "Repository NRS/nope does not exist.",
            exceptionName: "com.atlassian.bitbucket.repository.NoSuchRepositoryException",
          },
        ],
      }),
    });
    await expect(
      new BitbucketClient(notFound as any, BASE).fileType("NRS", "nope", "a.txt", "refs/heads/main")
    ).rejects.toThrow(/Repository NRS\/nope does not exist \(404\)/);
  });

  it("throws on non-404 errors", async () => {
    const mockFetch = createMockFetch({ ok: false, status: 500, text: "boom" });
    const client = new BitbucketClient(mockFetch as any, BASE);
    await expect(client.fileType("NRS", "repo", "x")).rejects.toThrow(/\(500\)/);
  });
});

describe("repository path validation", () => {
  it("rejects dot and empty path segments before any request is sent", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new BitbucketClient(mockFetch as any, BASE);
    for (const p of ["../secret.txt", "a/../../b", "a//b", "./a", "a/.", "/abs.txt"]) {
      await expect(client.fileType("NRS", "repo", p)).rejects.toThrow(/path segment/);
      await expect(
        client.commitFile("NRS", "repo", p, { branch: "main", content: "x", message: "m" })
      ).rejects.toThrow(/path segment/);
      await expect(client.readFile("NRS", "repo", p)).rejects.toThrow(/path segment/);
      await expect(client.browseFiles("NRS", "repo", p)).rejects.toThrow(/path segment/);
      await expect(client.blameFile("NRS", "repo", p)).rejects.toThrow(/path segment/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("BitbucketClient.commitFile", () => {
  const commit = {
    id: "a".repeat(40),
    displayId: "aaaaaaaaaaa",
    author: { name: "j", emailAddress: "j@example.com" },
    authorTimestamp: 1,
    message: "Add config",
    parents: [],
  };

  it("PUTs multipart form fields to the browse endpoint", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: commit });
    const client = new BitbucketClient(mockFetch as any, BASE);

    const result = await client.commitFile("NRS", "repo", "conf/app.yaml", {
      branch: "feature/x",
      content: "a: 1\n",
      message: "Add config",
      sourceCommitId: "b".repeat(40),
    });

    expect(result).toEqual(commit);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/api/1.0/projects/NRS/repos/repo/browse/conf/app.yaml`);
    expect(opts.method).toBe("PUT");
    expect(opts.body).toBeInstanceOf(FormData);
    const form = opts.body as FormData;
    expect(form.get("branch")).toBe("feature/x");
    expect(form.get("content")).toBe("a: 1\n");
    expect(form.get("message")).toBe("Add config");
    expect(form.get("sourceCommitId")).toBe("b".repeat(40));
    // fetch must set the multipart boundary itself
    expect(opts.headers?.["Content-Type"]).toBeUndefined();
  });

  it("omits sourceCommitId when creating a new file", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: commit });
    const client = new BitbucketClient(mockFetch as any, BASE);
    await client.commitFile("NRS", "repo", "new.txt", {
      branch: "main",
      content: "hi",
      message: "Add new.txt",
    });
    const form = mockFetch.mock.calls[0][1].body as FormData;
    expect(form.get("sourceCommitId")).toBeNull();
  });

  it("throws with status and body on a stale sourceCommitId (409)", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 409,
      text: "The file has changed since sourceCommitId",
    });
    const client = new BitbucketClient(mockFetch as any, BASE);
    await expect(
      client.commitFile("NRS", "repo", "conf/app.yaml", {
        branch: "main",
        content: "x",
        message: "m",
        sourceCommitId: "c".repeat(40),
      })
    ).rejects.toThrow(/\(409\).*changed since/);
  });
});
