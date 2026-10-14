import { describe, it, expect, vi } from "vitest";
import { CssClient } from "../css-client.js";

const CONFIG = {
  clientId: "team-api-account",
  clientSecret: "s3cret",
  apiUrl: "https://api.example.test/api/v1/",
  tokenUrl: "https://sso.example.test/token",
};

function jsonResponse(status: number, body?: unknown) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
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

const apiCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.filter(([u]) => u !== CONFIG.tokenUrl);

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
    expect(f.mock.calls.filter(([u]) => u === CONFIG.tokenUrl)).toHaveLength(1);
  });

  it("refreshes the token and retries once on 401", async () => {
    const f = mockFetch(jsonResponse(401, { message: "expired" }), jsonResponse(200, { data: [{ id: 1, projectName: "x" }] }));
    const rows = await new CssClient(CONFIG, f as any).listIntegrations();
    expect(rows).toHaveLength(1);
    expect(f.mock.calls.filter(([u]) => u === CONFIG.tokenUrl)).toHaveLength(2);
  });

  it("does not echo the token endpoint body on failure", async () => {
    const f = vi.fn(async () => ({ ...jsonResponse(401), text: () => Promise.resolve("client_secret=s3cret") }));
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.toThrow(/token request failed: 401/);
    await expect(new CssClient(CONFIG, f as any).listIntegrations()).rejects.not.toThrow(/s3cret/);
  });
});

describe("CssClient endpoints", () => {
  it("strips the trailing slash from the API URL and unwraps the data envelope", async () => {
    const f = mockFetch(jsonResponse(200, { data: [{ name: "ARTS_ADMIN", composite: false }] }));
    const roles = await new CssClient(CONFIG, f as any).listRoles(6551, "dev");
    expect(apiCalls(f)[0][0]).toBe("https://api.example.test/api/v1/integrations/6551/dev/roles");
    expect(roles).toEqual([{ name: "ARTS_ADMIN", composite: false }]);
  });

  it("treats a missing data envelope as empty", async () => {
    const f = mockFetch(jsonResponse(200, {}));
    expect(await new CssClient(CONFIG, f as any).listIntegrations()).toEqual([]);
  });

  it("keeps @ in usernames but encodes other path characters", async () => {
    const f = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, f as any).listUserRoles(1, "dev", "abc123@azureidir");
    expect(apiCalls(f)[0][0]).toBe("https://api.example.test/api/v1/integrations/1/dev/users/abc123@azureidir/roles");

    const g = mockFetch(jsonResponse(200, { data: [] }));
    await new CssClient(CONFIG, g as any).listRoleUsers(1, "dev", "a b?c");
    expect(apiCalls(g)[0][0]).toBe("https://api.example.test/api/v1/integrations/1/dev/roles/a%20b%3Fc/users");
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
    ).rejects.toThrow("CSS API 400 Error on GET /prod/azure-idir/users: {\"message\":\"invalid idp idir\"}");
  });
});
