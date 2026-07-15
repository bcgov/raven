import { describe, expect, it, vi } from "vitest";
import { ArtifactoryClient, encodeArtifactoryPath, normalizeArtifactoryBaseUrl } from "../artifactory-client.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("Artifactory URL safety", () => {
  it("normalizes an HTTPS base URL with a context path", () => {
    expect(normalizeArtifactoryBaseUrl("https://bwa.example.ca/int/artifactory///"))
      .toBe("https://bwa.example.ca/int/artifactory");
  });

  it("rejects HTTP, credentials, query strings, and fragments", () => {
    expect(() => normalizeArtifactoryBaseUrl("http://example.ca/artifactory")).toThrow("HTTPS");
    expect(() => normalizeArtifactoryBaseUrl("https://user:pass@example.ca/artifactory")).toThrow("credentials");
    expect(() => normalizeArtifactoryBaseUrl("https://example.ca/artifactory?x=1")).toThrow("query");
    expect(() => normalizeArtifactoryBaseUrl("https://example.ca/artifactory#x")).toThrow("fragment");
  });

  it("encodes valid item paths and rejects traversal", () => {
    expect(encodeArtifactoryPath("com/example/app 1.0.jar")).toBe("com/example/app%201.0.jar");
    expect(encodeArtifactoryPath("///com/example/app.jar///")).toBe("com/example/app.jar");
    expect(() => encodeArtifactoryPath("../secrets.txt")).toThrow("traversal");
    expect(() => encodeArtifactoryPath("folder\\file.txt")).toThrow("backslashes");
  });
});

describe("ArtifactoryClient read operations", () => {
  it("uses compatible Artifactory 6 endpoints and disables redirects", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("OK", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ version: "6.23.7" }))
      .mockResolvedValueOnce(jsonResponse([{ key: "libs-release-local", type: "LOCAL" }]))
      .mockResolvedValueOnce(jsonResponse({ repo: "libs-release-local", path: "/a.jar" }));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    await expect(client.ping()).resolves.toBe("OK");
    await client.getVersion();
    await client.listRepositories({ type: "local", packageType: "maven" });
    await client.getItemInfo("libs-release-local", "com/example/a.jar");

    expect(fetch.mock.calls[0][0]).toBe("https://example.ca/artifactory/api/system/ping");
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
    expect(fetch.mock.calls[2][0]).toBe("https://example.ca/artifactory/api/repositories?type=local&packageType=maven");
    expect(fetch.mock.calls[3][0]).toBe("https://example.ca/artifactory/api/storage/libs-release-local/com/example/a.jar");
  });

  it("constructs bounded item AQL instead of accepting arbitrary AQL", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ results: [], range: { total: 0 } }));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    await client.searchItems({
      repository: "libs-release-local",
      pathPattern: "com/example/*",
      namePattern: "*.war",
      type: "file",
      properties: { status: "release*" },
      limit: 25,
      offset: 5,
    });

    expect(fetch.mock.calls[0][0]).toBe("https://example.ca/artifactory/api/search/aql");
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(fetch.mock.calls[0][1].headers.get("Content-Type")).toBe("text/plain");
    expect(fetch.mock.calls[0][1].body).toContain('items.find({"repo":"libs-release-local"');
    expect(fetch.mock.calls[0][1].body).toContain('"@status":{"$match":"release*"}');
    expect(fetch.mock.calls[0][1].body).toContain(".offset(5).limit(25)");
  });

  it("does not include a response body that could echo a credential in errors", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("password=must-not-escape", {
      status: 500,
      statusText: "Internal Server Error",
    }));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");
    const rejection = client.getVersion();
    await expect(rejection).rejects.toThrow("500 Internal Server Error");
    await expect(rejection).rejects.not.toThrow("must-not-escape");
  });

  it("normalizes the Artifactory 6 no-properties 404 response", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(jsonResponse({ repo: "libs", path: "/a.jar" }));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    await expect(client.getItemProperties("libs", "a.jar")).resolves.toEqual({ properties: {} });
    expect(fetch.mock.calls[1][0]).toBe("https://example.ca/artifactory/api/storage/libs/a.jar");
  });
});

describe("ArtifactoryClient mutations", () => {
  it("follows allowlisted HTTPS storage redirects without Artifactory credentials", async () => {
    const authenticatedFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://storage.example.ca/signed/artifact" },
    }));
    const storageFetch = vi.fn().mockResolvedValue(new Response("redirected-artifact", {
      headers: { "Content-Length": "19" },
    }));
    const client = new ArtifactoryClient(authenticatedFetch, "https://example.ca/artifactory", {
      allowedDownloadRedirectHosts: ["storage.example.ca"],
      unauthenticatedFetch: storageFetch,
    });

    const download = await client.downloadArtifact("source", "a.jar", 100);

    await expect(new Response(download.body).text()).resolves.toBe("redirected-artifact");
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(storageFetch).toHaveBeenCalledTimes(1);
    expect(storageFetch.mock.calls[0][0]).toBe("https://storage.example.ca/signed/artifact");
    const redirectHeaders = new Headers(storageFetch.mock.calls[0][1].headers);
    expect(redirectHeaders.get("Authorization")).toBeNull();
    expect(redirectHeaders.get("Cookie")).toBeNull();
    expect(storageFetch.mock.calls[0][1].redirect).toBe("manual");
  });

  it("rejects authentication redirects instead of treating them as storage downloads", async () => {
    const authenticatedFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://logon.example.gov.bc.ca/clp-cgi/dirSelect.cgi" },
    }));
    const storageFetch = vi.fn();
    const client = new ArtifactoryClient(authenticatedFetch, "https://example.ca/artifactory", {
      allowedDownloadRedirectHosts: ["logon.example.gov.bc.ca"],
      unauthenticatedFetch: storageFetch,
    });

    await expect(client.downloadArtifact("source", "a.jar", 100)).rejects.toThrow("authentication redirect");
    expect(storageFetch).not.toHaveBeenCalled();
  });

  it("rejects external download redirects that are not explicitly allowlisted", async () => {
    const authenticatedFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://storage.example.ca/signed/artifact" },
    }));
    const storageFetch = vi.fn();
    const client = new ArtifactoryClient(authenticatedFetch, "https://example.ca/artifactory", {
      unauthenticatedFetch: storageFetch,
    });

    await expect(client.downloadArtifact("source", "a.jar", 100)).rejects.toThrow("unapproved host");
    expect(storageFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["http://storage.example.ca/signed/artifact", "HTTPS"],
    ["https://user:password@storage.example.ca/signed/artifact", "embedded credentials"],
  ])("rejects unsafe allowlisted download redirect %s", async (location, message) => {
    const authenticatedFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: location },
    }));
    const storageFetch = vi.fn();
    const client = new ArtifactoryClient(authenticatedFetch, "https://example.ca/artifactory", {
      allowedDownloadRedirectHosts: ["storage.example.ca"],
      unauthenticatedFetch: storageFetch,
    });

    await expect(client.downloadArtifact("source", "a.jar", 100)).rejects.toThrow(message);
    expect(storageFetch).not.toHaveBeenCalled();
  });

  it("returns a bounded download stream without buffering the response", async () => {
    const response = new Response("streamed-artifact", {
      headers: { "Content-Length": "17" },
    });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    const download = await client.downloadArtifact("source", "a.jar", 100);
    const text = await new Response(download.body).text();

    expect(text).toBe("streamed-artifact");
    expect(download.contentLength).toBe(17);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("uses the configured transfer timeout while streaming downloads", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn().mockResolvedValue(new Response("streamed-artifact"));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory", {
      downloadTimeoutMs: 120_000,
    });

    const download = await client.downloadArtifact("source", "a.jar", 100);
    await new Response(download.body).text();

    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("rejects invalid download timeout options", () => {
    expect(() => new ArtifactoryClient(vi.fn(), "https://example.ca/artifactory", {
      downloadTimeoutMs: 0,
    })).toThrow("download timeout");
    expect(() => new ArtifactoryClient(vi.fn(), "https://example.ca/artifactory", {
      downloadTimeoutMs: 86_400_001,
    })).toThrow("download timeout");
  });

  it("rejects a declared download size above the transfer limit before streaming", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("small body", {
      headers: { "Content-Length": "101" },
    }));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    await expect(client.downloadArtifact("source", "a.jar", 100)).rejects.toThrow("transfer limit");
  });

  it("uses dry-run copy and move requests by default", async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ messages: [] }));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    await client.copyItem("source-local", "a.jar", "target-local", "b.jar", true);
    await client.moveItem("source-local", "a.jar", "target-local", "b.jar", true);

    expect(fetch.mock.calls[0][0]).toContain("/api/copy/source-local/a.jar?");
    expect(fetch.mock.calls[0][0]).toContain("dry=1");
    expect(fetch.mock.calls[0][0]).toContain("to=%2Ftarget-local%2Fb.jar");
    expect(fetch.mock.calls[1][0]).toContain("/api/move/source-local/a.jar?");
  });

  it("sends checksums with artifact uploads", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ repo: "target", path: "/a.jar" }, 201));
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    const artifact = new Blob(["artifact"]);
    await client.uploadArtifact("target", "a.jar", artifact, {
      sha1: "sha-one",
      sha256: "sha-two-five-six",
    });

    const options = fetch.mock.calls[0][1];
    expect(options.method).toBe("PUT");
    expect(options.headers.get("X-Checksum-Sha1")).toBe("sha-one");
    expect(options.headers.get("X-Checksum-Sha256")).toBe("sha-two-five-six");
    expect(options.body).toBe(artifact);
  });

  it("validates property values inside the client", async () => {
    const fetch = vi.fn();
    const client = new ArtifactoryClient(fetch, "https://example.ca/artifactory");

    await expect(client.setItemProperties("target", "a.jar", { status: ["release|delete=all"] }))
      .rejects.toThrow("unsupported reserved character");
    expect(fetch).not.toHaveBeenCalled();
  });
});
