import { describe, it, expect, vi } from "vitest";
import { JiraClient } from "../jira-client.js";

const BASE = "https://jira.example.com";
const META = {
  id: "42",
  filename: "shot.png",
  author: { displayName: "Jane" },
  created: "2026-01-01T00:00:00Z",
  size: 3,
  mimeType: "image/png",
  content: `${BASE}/secure/attachment/42/shot.png`,
};

function jsonResp(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") };
}
function binResp(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    text: () => Promise.resolve(""),
  };
}

describe("JiraClient.downloadAttachment", () => {
  it("fetches metadata then content bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce(binResp(bytes));
    const client = new JiraClient(fetchMock as any, BASE);

    const { meta, bytes: out } = await client.downloadAttachment("42");

    expect(meta.filename).toBe("shot.png");
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/api/2/attachment/42");
    expect(fetchMock.mock.calls[1][0]).toBe(META.content);
  });

  it("rewrites the content URL to the client's configured host before downloading", async () => {
    const meta = { ...META, content: "https://public.example.com/secure/attachment/42/shot.png" };
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(meta))
      .mockResolvedValueOnce(binResp(bytes));
    const client = new JiraClient(fetchMock as any, BASE);

    await client.downloadAttachment("42");

    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/secure/attachment/42/shot.png`);
  });

  it("follows a single non-login redirect on the content URL", async () => {
    const bytes = new Uint8Array([9]);
    const redirect = {
      ok: false,
      status: 302,
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? `${BASE}/blob/xyz` : null) },
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(binResp(bytes));
    const client = new JiraClient(fetchMock as any, BASE);

    const { bytes: out } = await client.downloadAttachment("42");
    expect(Array.from(out)).toEqual([9]);
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE}/blob/xyz`);
  });

  it("refuses to follow a cross-origin redirect (credential leak guard)", async () => {
    const crossOrigin = {
      ok: false,
      status: 302,
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? "https://evil.example.com/blob" : null) },
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce(crossOrigin);
    const client = new JiraClient(fetchMock as any, BASE);
    await expect(client.downloadAttachment("42")).rejects.toThrow("cross-origin");
    // must NOT have made a third fetch call to the evil host
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws with status on failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve("gone") });
    const client = new JiraClient(fetchMock as any, BASE);
    await expect(client.downloadAttachment("42")).rejects.toThrow("Failed to download attachment 42 (404)");
  });

  it("refuses a same-host protocol-downgrade redirect (https -> http)", async () => {
    const downgrade = {
      ok: false, status: 302,
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? "http://jira.example.com/blob" : null) },
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResp(META)).mockResolvedValueOnce(downgrade);
    const client = new JiraClient(fetchMock as any, BASE);
    await expect(client.downloadAttachment("42")).rejects.toThrow("cross-origin");
    expect(fetchMock).toHaveBeenCalledTimes(2); // no third fetch to the http host
  });

  it("downloadAttachmentContent fetches only the content (no metadata call) and host-rewrites", async () => {
    const meta = { ...META, content: "https://public.example.com/int/jira/secure/attachment/42/shot.png" };
    const bytes = new Uint8Array([7, 8, 9]);
    const fetchMock = vi.fn().mockResolvedValueOnce(binResp(bytes));
    const client = new JiraClient(fetchMock as any, BASE);
    const out = await client.downloadAttachmentContent(meta);
    expect(Array.from(out)).toEqual([7, 8, 9]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://jira.example.com/int/jira/secure/attachment/42/shot.png");
  });
});
