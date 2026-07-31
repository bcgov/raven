import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSpoFetch, isSpoSessionExpired } from "../spo-http-client.js";
import { _resetLimiters } from "../rate-limit.js";
import type { SpoSessionManager } from "../spo-session-manager.js";

function fakeSessionManager(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getSession: vi.fn(async () => ({ fedAuth: "fa1", rtFa: "rt1" })),
    invalidate: vi.fn(async () => {}),
    userAgent: "TestUA/1.0",
    targetUrl: "https://example.sharepoint.com",
    ...overrides,
  } as unknown as SpoSessionManager;
}

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}

function expiredResponse(): Response {
  return new Response("", {
    status: 403,
    headers: { "X-Forms_Based_Auth_Required": "https://example.sharepoint.com/_forms/default.aspx" },
  });
}

beforeEach(() => _resetLimiters());
afterEach(() => vi.unstubAllGlobals());

describe("isSpoSessionExpired", () => {
  it("detects the 403 X-Forms_Based_Auth_Required signal", () => {
    expect(isSpoSessionExpired(expiredResponse())).toBe(true);
  });

  it("detects a redirect to the Entra login host", () => {
    const resp = new Response("", {
      status: 302,
      headers: { location: "https://login.microsoftonline.com/common/oauth2/authorize?x=1" },
    });
    expect(isSpoSessionExpired(resp)).toBe(true);
  });

  it("treats a plain 403 (real permission denial) as NOT expired", () => {
    expect(isSpoSessionExpired(new Response("", { status: 403 }))).toBe(false);
  });

  it("treats 200 as not expired", () => {
    expect(isSpoSessionExpired(okResponse())).toBe(false);
  });
});

describe("createSpoFetch", () => {
  it("attaches both cookies and the user agent", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return okResponse();
    }));

    const spoFetch = await createSpoFetch(fakeSessionManager());
    await spoFetch("https://example.sharepoint.com/_api/web");

    const headers = new Headers(seen[0]?.headers);
    expect(headers.get("Cookie")).toContain("FedAuth=fa1");
    expect(headers.get("Cookie")).toContain("rtFa=rt1");
    expect(headers.get("User-Agent")).toBe("TestUA/1.0");
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("invalidates and retries once on session expiry", async () => {
    const sm = fakeSessionManager({
      getSession: vi
        .fn()
        .mockResolvedValueOnce({ fedAuth: "fa1", rtFa: "rt1" }) // eager validation in factory
        .mockResolvedValueOnce({ fedAuth: "fa1", rtFa: "rt1" }) // first request
        .mockResolvedValueOnce({ fedAuth: "fa2", rtFa: "rt2" }), // after invalidate
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const cookie = new Headers(init?.headers).get("Cookie") ?? "";
      calls.push(cookie);
      return calls.length === 1 ? expiredResponse() : okResponse();
    }));

    const spoFetch = await createSpoFetch(sm);
    const resp = await spoFetch("https://example.sharepoint.com/_api/web");

    expect(resp.status).toBe(200);
    expect(sm.invalidate).toHaveBeenCalledTimes(1);
    expect(calls[1]).toContain("FedAuth=fa2");
  });

  it("throws when the retry also comes back expired", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => expiredResponse()));
    const spoFetch = await createSpoFetch(fakeSessionManager());
    await expect(
      spoFetch("https://example.sharepoint.com/_api/web")
    ).rejects.toThrow(/re-authentication failed/i);
  });
});
