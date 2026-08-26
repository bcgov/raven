import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthenticatedFetch, createBasicAuthFetch } from "../http-client.js";
import type { SessionManager } from "../session-manager.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticated session fetch", () => {
  it("uses a platform-neutral Node command to make the CLI executable", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: { build: string } };

    expect(packageJson.scripts.build).toContain("chmodSync");
    expect(packageJson.scripts.build).not.toMatch(/&&\s*chmod\b/);
  });

  it("preserves Jenkins servlet cookies while attaching SMSESSION", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const sessionManager = {
      getSession: vi.fn().mockResolvedValue("siteminder-session"),
      invalidate: vi.fn(),
      userAgent: "raven-test",
    } as unknown as SessionManager;
    const authenticatedFetch = await createAuthenticatedFetch(sessionManager);

    await authenticatedFetch("https://jenkins.example.gov.bc.ca/jenkins/crumbIssuer/api/json", {
      headers: { Cookie: "JSESSIONID=jenkins-session" },
    });

    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get("Cookie")).toBe("JSESSIONID=jenkins-session; SMSESSION=siteminder-session");
  });

  it("preserves Jenkins servlet cookies when refreshing an expired SMSESSION", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://logon.example.gov.bc.ca/clp-cgi/logon" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const sessionManager = {
      getSession: vi.fn()
        .mockResolvedValueOnce("initial-session")
        .mockResolvedValueOnce("initial-session")
        .mockResolvedValueOnce("refreshed-session"),
      invalidate: vi.fn(),
      userAgent: "raven-test",
    } as unknown as SessionManager;
    const authenticatedFetch = await createAuthenticatedFetch(sessionManager);

    await authenticatedFetch("https://jenkins.example.gov.bc.ca/jenkins/crumbIssuer/api/json", {
      headers: { Cookie: "JSESSIONID=jenkins-session" },
    });

    const retryHeaders = new Headers(fetch.mock.calls[1][1]?.headers);
    expect(retryHeaders.get("Cookie")).toBe("JSESSIONID=jenkins-session; SMSESSION=refreshed-session");
    expect(sessionManager.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("basic auth fetch", () => {
  it("attaches the Basic Authorization header and forwards through globalThis.fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const basicAuthFetch = createBasicAuthFetch("Jane.Smith@gov.bc.ca", "s3cret");

    const response = await basicAuthFetch("https://apps.example.gov.bc.ca/int/jira/rest/api/2/myself");

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetch.mock.calls[0];
    expect(calledUrl).toBe("https://apps.example.gov.bc.ca/int/jira/rest/api/2/myself");
    const headers = new Headers(calledInit?.headers);
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("Jane.Smith@gov.bc.ca:s3cret")}`);
  });

  it("preserves caller-supplied headers while adding Basic Auth", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const basicAuthFetch = createBasicAuthFetch("Jane.Smith@gov.bc.ca", "s3cret");

    await basicAuthFetch("https://apps.example.gov.bc.ca/int/jira/rest/api/2/myself", {
      headers: { Accept: "application/json" },
    });

    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("Jane.Smith@gov.bc.ca:s3cret")}`);
  });
});
