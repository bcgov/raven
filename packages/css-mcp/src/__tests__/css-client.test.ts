import { afterEach, describe, it, expect, vi } from "vitest";
import {
  CssClient,
  MAX_ROLE_USER_PAGES,
  REQUEST_TIMEOUT_MS,
  ROLE_USERS_PAGE_SIZE,
  assertTrustedHost,
  requireHttpsUrl,
  stripUnsafe,
} from "../css-client.js";

const CONFIG = {
  clientId: "team-api-account",
  clientSecret: "s3cret",
  apiUrl: "https://api.example.test/api/v1/",
  tokenUrl: "https://sso.example.test/token",
  allowAnyHost: true,
};

const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BEL = String.fromCharCode(7);

function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    body: { cancel: vi.fn(async () => undefined) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  };
}

/** Fetch mock that answers the token endpoint, then the queued API responses in order. */
function mockFetch(...apiResponses: ReturnType<typeof jsonResponse>[]) {
  const queue = [...apiResponses];
  return vi.fn(async (url: string) => {
    if (url === CONFIG.tokenUrl) return jsonResponse(200, { access_token: "tok-1", expires_in: 300 });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return next;
  });
}

/** Await a promise that must reject, returning the Error for message assertions. */
const rejection = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: Error) => e,
  );
const apiCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.filter(([u]) => u !== CONFIG.tokenUrl);
const tokenCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.filter(([u]) => u === CONFIG.tokenUrl);
const users = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ username: `u${from + i}@azureidir` }));
const usersPath = (n: number) => `https://api.example.test/api/v1/integrations/1/dev/roles/A/users?page=${n}&max=${ROLE_USERS_PAGE_SIZE}`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CssClient auth", () => {
  it("requests a client-credentials token and sends it as a bearer", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, f as any).listIntegrations();

    const [tokenUrl, tokenOpts] = f.mock.calls[0] as any;
    expect(tokenUrl).toBe(CONFIG.tokenUrl);
    expect(tokenOpts.body).toContain("grant_type=client_credentials");
    expect(tokenOpts.body).toContain("client_id=team-api-account");

    const [, opts] = apiCalls(f)[0] as any;
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
  });

  it("reuses a cached token across calls", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] }));
    const c = new CssClient(CONFIG, f as any);
    await c.listIntegrations();
    await c.listIntegrations();
    expect(tokenCalls(f)).toHaveLength(1);
  });

  it("fetches one token for concurrent cold-cache calls", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] }));
    const c = new CssClient(CONFIG, f as any);
    await Promise.all([c.listIntegrations(), c.listIntegrations(), c.listIntegrations()]);
    expect(tokenCalls(f)).toHaveLength(1);
  });

  it("re-requests a token once the cached one is within the expiry buffer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = mockFetch(jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] }));
    const c = new CssClient(CONFIG, f as any);
    await c.listIntegrations();
    vi.setSystemTime(new Date("2026-01-01T00:04:31Z")); // 300 s lifetime - 30 s buffer + 1 s
    await c.listIntegrations();
    expect(tokenCalls(f)).toHaveLength(2);
  });

  it("keeps a short-lived token for half its life instead of refetching per call", async () => {
    const f = vi.fn(async (url: string) =>
      url === CONFIG.tokenUrl
        ? jsonResponse(200, { access_token: "t", expires_in: 10 })
        : jsonResponse(200, { data: [] }),
    );
    const c = new CssClient(CONFIG, f as any);
    await c.listIntegrations();
    await c.listIntegrations();
    expect(tokenCalls(f as any)).toHaveLength(1);
  });

  it("refreshes the token and retries once on 401, releasing the first response", async () => {
    const first = jsonResponse(401, { message: "expired" });
    const f = mockFetch(first, jsonResponse(200, { data: [{ id: 1, projectName: "x" }] }));
    const rows = await new CssClient(CONFIG, f as any).listIntegrations();
    expect(rows).toHaveLength(1);
    expect(tokenCalls(f)).toHaveLength(2);
    expect(first.body.cancel).toHaveBeenCalled();
  });

  it("gives up after one retry when the API keeps returning 401", async () => {
    const f = mockFetch(jsonResponse(401, { message: "nope" }), jsonResponse(401, { message: "nope" }));
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/CSS API 401/);
    expect(apiCalls(f)).toHaveLength(2);
    expect(tokenCalls(f)).toHaveLength(2);
  });

  it("reports a rejected token request by status only, without the body", async () => {
    const f = vi.fn(async () => ({ ...jsonResponse(401), text: () => Promise.resolve("client_secret=s3cret") }));
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/rejected \(401\)/);
    expect(e.message).toMatch(/CSS_API_CLIENT_ID/);
    expect(e.message).not.toContain("s3cret");
  });

  it("names Keycloak's error code on a rejected grant", async () => {
    const f = vi.fn(async () => jsonResponse(400, { error: "invalid_client", error_description: "secret for team-x is wrong" }));
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toContain("rejected (400 invalid_client)");
    expect(e.message).not.toContain("team-x");
  });

  it("does not present rejected credentials again during the cooldown, and does so once it has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let n = 0;
    const f = vi.fn(async (url: string) =>
      url === CONFIG.tokenUrl
        ? ++n === 1
          ? jsonResponse(401)
          : jsonResponse(200, { access_token: "t2", expires_in: 300 })
        : jsonResponse(200, { data: [] }),
    );
    const c = new CssClient(CONFIG, f as any);
    await expect(c.listIntegrations()).rejects.toThrow(/rejected \(401\)/);
    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    await expect(c.listIntegrations()).rejects.toThrow(/rejected \(401\)/);
    expect(n).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    await expect(c.listIntegrations()).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it("does not blame credentials for a throttled or failing token endpoint", async () => {
    const f = vi.fn(async () => jsonResponse(429, undefined, { "Retry-After": "7" }));
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/unavailable \(429/);
    expect(e.message).toMatch(/retry after 7 s/);
    expect(e.message).not.toMatch(/CSS_API_CLIENT_ID/);
  });

  it("retries the token fetch on the next call after a transient failure", async () => {
    let n = 0;
    const f = vi.fn(async (url: string) =>
      url === CONFIG.tokenUrl
        ? ++n === 1
          ? jsonResponse(503)
          : jsonResponse(200, { access_token: "t2", expires_in: 300 })
        : jsonResponse(200, { data: [] }),
    );
    const c = new CssClient(CONFIG, f as any);
    await expect(c.listIntegrations()).rejects.toThrow(/unavailable \(503/);
    await expect(c.listIntegrations()).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it("does not follow a redirect from the token endpoint", async () => {
    const f = vi.fn(async () => ({ ...jsonResponse(302), ok: false }));
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/token endpoint returned an unexpected redirect/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-JSON token body without echoing it", async () => {
    const f = vi.fn(async () => ({ ...jsonResponse(200), text: () => Promise.resolve("<html>login page</html>") }));
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/not JSON/);
    expect(e.message).not.toContain("login page");
  });

  it("rejects a token body that cannot be read without echoing the cause", async () => {
    const f = vi.fn(async () => ({ ...jsonResponse(200), text: () => Promise.reject(new TypeError("terminated: secret-ish")) }));
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/token response could not be read/);
    expect(e.message).not.toContain("terminated");
  });

  it("rejects a token response without access_token", async () => {
    const f = vi.fn(async () => jsonResponse(200, { expires_in: 300 }));
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/no access_token/);
  });
});

describe("CssClient endpoints", () => {
  it("strips the trailing slash from the API URL and unwraps the data envelope", async () => {
    const f = mockFetch(jsonResponse(200, { data: [{ name: "ARTS_ADMIN", composite: false }] }));
    const roles = await new CssClient(CONFIG, f as any).listRoles(6551, "dev");
    expect(apiCalls(f)[0][0]).toBe("https://api.example.test/api/v1/integrations/6551/dev/roles");
    expect(roles).toEqual([{ name: "ARTS_ADMIN", composite: false }]);
  });

  it("treats a 2xx without a data array as an error, not an empty list", async () => {
    const f = mockFetch(jsonResponse(200, {}));
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/Unexpected response shape on GET \/integrations/);
  });

  it("treats a non-JSON 2xx body as an error, not an empty list", async () => {
    const f = mockFetch({ ...jsonResponse(200, undefined, { "Content-Type": "text/html" }), text: () => Promise.resolve("<html>maintenance</html>") });
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/non-JSON 200 response on GET \/integrations \(content-type: text\/html\)/);
    expect(e.message).not.toContain("maintenance");
  });

  it("treats a 2xx whose body cannot be read as an error, never an empty success", async () => {
    // Headers arrived, then the body read failed (timeout mid-stream, proxy reset): CSS may or may not have created the role.
    const f = mockFetch({ ...jsonResponse(201), text: () => Promise.reject(new TypeError("terminated")) });
    const e = await rejection(new CssClient(CONFIG, f as any).createRole(6551, "dev", "ARTS_ADMIN"));
    expect(e.message).toMatch(/^CSS API 201 response on POST \/integrations\/6551\/dev\/roles could not be read \(TypeError\); whether CSS applied the request is unknown\.$/);
    expect(e.message).not.toContain("terminated");
  });

  it("still reports the status when a non-2xx body cannot be read", async () => {
    const f = mockFetch({ ...jsonResponse(502), text: () => Promise.reject(new TypeError("terminated")) });
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/^CSS API 502 Error on GET \/integrations\.$/);
  });

  it("keeps @ in usernames but encodes other path characters", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, f as any).listUserRoles(1, "dev", "abc123@azureidir");
    expect(apiCalls(f)[0][0]).toBe("https://api.example.test/api/v1/integrations/1/dev/users/abc123@azureidir/roles");

    const g = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, g as any).listRoleUsers(1, "dev", "a b?c");
    expect(apiCalls(g)[0][0]).toBe(
      `https://api.example.test/api/v1/integrations/1/dev/roles/a%20b%3Fc/users?page=1&max=${ROLE_USERS_PAGE_SIZE}`,
    );
  });

  it("percent-encodes slashes inside a role segment", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "../users/x/roles-new");
    expect(apiCalls(f)[0][0]).toContain("/roles/..%2Fusers%2Fx%2Froles-new/users");
  });

  it.each([".", ".."])("refuses dot-segment role name %s without calling the API", async (role) => {
    const f = mockFetch();
    const c = new CssClient(CONFIG, f as any);
    await expect(c.removeUserRole(1, "dev", "abc@azureidir", role)).rejects.toThrow(/Invalid path segment/);
    await expect(c.listRoleUsers(1, "dev", role)).rejects.toThrow(/Invalid path segment/);
    expect(f).not.toHaveBeenCalled();
  });

  it("searches IDIR with only the supplied criteria", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, f as any).searchIdirUsers("prod", { lastName: "Gagan", firstName: undefined });
    expect(apiCalls(f)[0][0]).toBe("https://api.example.test/api/v1/prod/azure-idir/users?lastName=Gagan");
  });

  it("rejects an IDIR search with no criteria without calling the API", async () => {
    const f = mockFetch();
    await expect(new CssClient(CONFIG, f as any).searchIdirUsers("prod", {})).rejects.toThrow(/at least one/);
    expect(f).not.toHaveBeenCalled();
  });

  it("creates a role with a name payload", async () => {
    const f = mockFetch(jsonResponse(201, { name: "FAM_ADMIN", composite: false }));
    const role = await new CssClient(CONFIG, f as any).createRole(7, "dev", "FAM_ADMIN");
    const [url, opts] = apiCalls(f)[0] as any;
    expect(url).toBe("https://api.example.test/api/v1/integrations/7/dev/roles");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "FAM_ADMIN" });
    expect(role.name).toBe("FAM_ADMIN");
  });

  it("falls back to the requested name when CSS returns no usable body on create", async () => {
    const f = mockFetch(jsonResponse(204), jsonResponse(201, { composite: false }));
    const c = new CssClient(CONFIG, f as any);
    expect(await c.createRole(7, "dev", "R")).toEqual({ name: "R" });
    expect(await c.createRole(7, "dev", "S")).toEqual({ name: "S" });
  });

  it("assigns roles through roles-new with an array of names", async () => {
    const f = mockFetch(jsonResponse(204));
    await new CssClient(CONFIG, f as any).assignUserRoles(7, "dev", "abc@azureidir", ["A", "B"]);
    const [url, opts] = apiCalls(f)[0] as any;
    expect(url).toBe("https://api.example.test/api/v1/integrations/7/dev/users/abc@azureidir/roles-new");
    expect(JSON.parse(opts.body)).toEqual([{ name: "A" }, { name: "B" }]);
  });

  it("removes a role with DELETE", async () => {
    const f = mockFetch(jsonResponse(204));
    await new CssClient(CONFIG, f as any).removeUserRole(7, "test", "abc@azureidir", "A");
    const [url, opts] = apiCalls(f)[0] as any;
    expect(url).toBe("https://api.example.test/api/v1/integrations/7/test/users/abc@azureidir/roles/A");
    expect(opts.method).toBe("DELETE");
  });

  it("reports status, route and body on API errors, without query strings", async () => {
    const f = mockFetch(jsonResponse(400, { message: "invalid idp idir" }));
    await expect(
      new CssClient(CONFIG, f as any).searchIdirUsers("prod", { email: "x@gov.bc.ca" }),
    ).rejects.toThrow('CSS API 400 Error on GET /prod/azure-idir/users: {"message":"invalid idp idir"}');
  });

  it("flattens control, format characters and backticks out of echoed error bodies", async () => {
    const body = `<html>\n- **fake**\n\`line\`${BEL}x${RLO}evil${ZWSP}y</html>`;
    const f = mockFetch({ ...jsonResponse(502), text: () => Promise.resolve(body) });
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toContain("CSS API 502 Error on GET /integrations: <html> - **fake** line x evil y</html>");
    for (const ch of ["\n", "`", BEL, RLO, ZWSP]) expect(e.message).not.toContain(ch);
  });

  it("names a CSS rate limit and its Retry-After instead of a generic failure", async () => {
    const f = mockFetch({ ...jsonResponse(429, undefined, { "Retry-After": "12" }), statusText: "Too Many Requests" });
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(
      "CSS API rate limited (429 Too Many Requests) on GET /integrations; retry after 12 s.",
    );
  });

  it.each([
    ["absent", {}],
    ["negative", { "Retry-After": "-1" }],
    ["garbage", { "Retry-After": "soon" }],
  ])("says 'retry later' when Retry-After is %s", async (_label, headers) => {
    const f = mockFetch({ ...jsonResponse(429, undefined, headers), statusText: "Too Many Requests" });
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/; retry later\.$/);
  });

  it("converts an HTTP-date Retry-After into seconds", async () => {
    const date = new Date(Date.now() + 90_000).toUTCString();
    const f = mockFetch({ ...jsonResponse(429, undefined, { "Retry-After": date }), statusText: "Too Many Requests" });
    const e = await rejection(new CssClient(CONFIG, f as any).listIntegrations());
    expect(e.message).toMatch(/retry after (8[5-9]|9[0-1]) s\./);
  });

  it("attributes the shared limiter's synthetic 429 to RAVEN, not CSS", async () => {
    const f = mockFetch({ ...jsonResponse(429), statusText: "Local Throttle" });
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(
      "RAVEN's local rate limiter refused GET /integrations (Local Throttle); wait a few seconds and retry.",
    );
  });

  it("sends default traffic through the shared limiter with no wrapper-level 429 retries", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === CONFIG.tokenUrl
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response("", { status: 429, statusText: "Too Many Requests" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(new CssClient(CONFIG).listIntegrations()).rejects.toThrow(/CSS API rate limited \(429/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // token + exactly one API call
  });
});

describe("CssClient role-user paging", () => {
  it("walks pages until a short page and reports no more", async () => {
    const f = mockFetch(
      jsonResponse(200, { page: 1, data: users(ROLE_USERS_PAGE_SIZE) }),
      jsonResponse(200, { page: 2, data: users(1, ROLE_USERS_PAGE_SIZE) }),
    );
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A");
    expect(apiCalls(f).map(([u]) => u)).toEqual([usersPath(1), usersPath(2)]);
    expect(result.users).toHaveLength(ROLE_USERS_PAGE_SIZE + 1);
    expect(result.more).toBe(false);
  });

  it("makes one call when the first page is short", async () => {
    const f = mockFetch(jsonResponse(200, { page: 1, data: users(3) }));
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A");
    expect(apiCalls(f)).toHaveLength(1);
    expect(result).toEqual({ users: users(3), more: false });
  });

  it("stops at the caller's limit inside a full page and flags that more exist", async () => {
    const f = mockFetch(
      jsonResponse(200, { page: 1, data: users(ROLE_USERS_PAGE_SIZE) }),
      jsonResponse(200, { page: 2, data: users(ROLE_USERS_PAGE_SIZE, ROLE_USERS_PAGE_SIZE) }),
    );
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A", 60);
    expect(apiCalls(f)).toHaveLength(2);
    expect(result.users).toHaveLength(60);
    expect(result.more).toBe(true);
  });

  it("never returns more than limit rows when the walk ends on a short page", async () => {
    const f = mockFetch(jsonResponse(200, { page: 1, data: users(3) }));
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A", 2);
    expect(result.users).toHaveLength(2);
    expect(result.more).toBe(true);

    const g = mockFetch(
      jsonResponse(200, { page: 1, data: users(ROLE_USERS_PAGE_SIZE) }),
      jsonResponse(200, { page: 2, data: users(5, ROLE_USERS_PAGE_SIZE) }),
    );
    const second = await new CssClient(CONFIG, g as any).listRoleUsers(1, "dev", "A", 52);
    expect(second.users).toHaveLength(52);
    expect(second.more).toBe(true);
  });

  it("reports no more when the limit is met exactly on a short final page", async () => {
    const f = mockFetch(
      jsonResponse(200, { page: 1, data: users(ROLE_USERS_PAGE_SIZE) }),
      jsonResponse(200, { page: 2, data: users(2, ROLE_USERS_PAGE_SIZE) }),
    );
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A", ROLE_USERS_PAGE_SIZE + 2);
    expect(result.users).toHaveLength(ROLE_USERS_PAGE_SIZE + 2);
    expect(result.more).toBe(false);
  });

  it("reports that more may exist when exactly limit rows fill a page", async () => {
    const f = mockFetch(jsonResponse(200, { page: 1, data: users(ROLE_USERS_PAGE_SIZE) }));
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A", ROLE_USERS_PAGE_SIZE);
    expect(apiCalls(f)).toHaveLength(1);
    expect(result.users).toHaveLength(ROLE_USERS_PAGE_SIZE);
    expect(result.more).toBe(true);
  });

  it("stops after the page cap when every page is full", async () => {
    const f = vi.fn(async (url: string) =>
      url === CONFIG.tokenUrl
        ? jsonResponse(200, { access_token: "t", expires_in: 300 })
        : jsonResponse(200, { data: users(ROLE_USERS_PAGE_SIZE) }),
    );
    const result = await new CssClient(CONFIG, f as any).listRoleUsers(1, "dev", "A", 5000);
    expect(apiCalls(f as any)).toHaveLength(MAX_ROLE_USER_PAGES);
    expect(result.users).toHaveLength(MAX_ROLE_USER_PAGES * ROLE_USERS_PAGE_SIZE);
    expect(result.more).toBe(true);
  });
});

describe("CssClient transport hardening", () => {
  it("refuses non-HTTPS API or token URLs", () => {
    expect(() => new CssClient({ ...CONFIG, apiUrl: "http://api.example.test/api/v1" })).toThrow(/CSS_API_URL must use HTTPS/);
    expect(() => new CssClient({ ...CONFIG, tokenUrl: "http://sso.example.test/token" })).toThrow(/CSS_TOKEN_URL must use HTTPS/);
    expect(() => requireHttpsUrl("not a url", "X")).toThrow(/valid absolute HTTPS URL/);
  });

  it.each([
    "https://user:pw@api.example.test/api/v1",
    "https://api.example.test/api/v1?x=1",
    "https://api.example.test/api/v1#frag",
  ])("refuses a base URL with credentials, query or fragment: %s", (url) => {
    expect(() => requireHttpsUrl(url, "CSS_API_URL")).toThrow(/must not contain credentials, a query string or a fragment/);
  });

  it("pins both URLs to *.gov.bc.ca unless the caller opts out", () => {
    expect(() => new CssClient({ ...CONFIG, allowAnyHost: false })).toThrow(/CSS_API_URL must point at a \*\.gov\.bc\.ca host \(got api\.example\.test\)/);
    expect(() => new CssClient({ ...CONFIG, allowAnyHost: false, apiUrl: "https://api.loginproxy.gov.bc.ca/api/v1" })).toThrow(/CSS_TOKEN_URL must point at/);
    expect(
      () =>
        new CssClient({
          ...CONFIG,
          allowAnyHost: false,
          apiUrl: "https://api.loginproxy.gov.bc.ca/api/v1",
          tokenUrl: "https://loginproxy.gov.bc.ca/auth/realms/standard/protocol/openid-connect/token",
        }),
    ).not.toThrow();
    expect(() => assertTrustedHost("https://gov.bc.ca/x", "X")).not.toThrow();
    expect(() => assertTrustedHost("https://notgov.bc.ca.evil.com/x", "X")).toThrow(/gov\.bc\.ca/);
    expect(() => assertTrustedHost("https://GOV.BC.CA.evil.com/x", "X")).toThrow(/gov\.bc\.ca/);
  });

  it("sends every request with manual redirects and the 30 s timeout", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const f = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, f as any).listIntegrations();
    for (const [, opts] of f.mock.calls as any[]) {
      expect(opts.redirect).toBe("manual");
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it("does not follow a redirect from the API and releases the response", async () => {
    const redirect = { ...jsonResponse(302), ok: false };
    const f = mockFetch(redirect);
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/unexpected redirect \(302\)/);
    expect(apiCalls(f)).toHaveLength(1);
    expect(redirect.body.cancel).toHaveBeenCalled();
  });

  it("stripUnsafe removes control and format characters and backticks", () => {
    expect(stripUnsafe(`a${RLO}b${ZWSP}c${String.fromCharCode(0xad)}D\n\`e\``)).toBe("a b c D e");
  });
});
