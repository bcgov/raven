import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "@nrs/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CssClient } from "../css-client.js";
import { assertWriteAllowed, auditDetail, createCssServer, type CssAuditRecord, type CssServerOptions } from "../server.js";

const GUID_USER = "0123456789abcdef0123456789abcdef@azureidir";
const OTHER_USER = "fedcba9876543210fedcba9876543210@azureidir";
const ASSIGN_OK = `assign:7/dev/${GUID_USER}/A`;
const REMOVE_OK = `remove:7/test/${GUID_USER}/A`;
const RLO = String.fromCharCode(0x202e);

async function connected(clientOverride?: CssClient, opts: CssServerOptions = { audit: null }) {
  const server = createCssServer(clientOverride, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "css-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push({ client, server });
  return client;
}

const open: Array<{ client: Client; server: ReturnType<typeof createCssServer> }> = [];
const tempDirs: string[] = [];

beforeEach(() => {
  // These tests must not depend on whatever CSS_* the developer's shell happens to carry.
  for (const name of ["CSS_API_URL", "CSS_TOKEN_URL", "CSS_ALLOW_ANY_HOST", "CSS_ALLOW_PROD_WRITES", "RAVEN_SCRUB_PI"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  await Promise.all(open.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A CssClient whose fetch throws, so any method a test forgets to override fails fast instead of reaching the network. */
function fakeClient(overrides: Partial<Record<keyof CssClient, unknown>> = {}) {
  const c = new CssClient(
    { clientId: "x", clientSecret: "y", apiUrl: "https://x", tokenUrl: "https://x", allowAnyHost: true },
    (async () => {
      throw new Error("fakeClient: unmocked CssClient method reached fetch");
    }) as any,
  );
  for (const [name, impl] of Object.entries(overrides)) {
    vi.spyOn(c as any, name).mockImplementation(impl as any);
  }
  return c;
}

/** listUserRoles mock answering the before-state then the after-state. */
const beforeAfter = (before: string[], after: string[]) =>
  vi
    .fn()
    .mockResolvedValueOnce(before.map((name) => ({ name })))
    .mockResolvedValueOnce(after.map((name) => ({ name })));

const textOf = (r: any) => r.content.map((b: any) => b.text).join("\n");

describe("CSS MCP server", () => {
  it("registers the read and write tools with matching hints", async () => {
    const client = await connected(fakeClient());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    for (const name of ["list_integrations", "list_roles", "list_role_users", "list_user_roles", "search_idir_users"]) {
      expect(byName[name]?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ["create_role", "assign_user_roles", "remove_user_role"]) {
      expect(byName[name]?.annotations?.readOnlyHint).toBe(false);
      expect((byName[name]?.inputSchema as any)?.properties?.confirm).toBeDefined();
    }
    // Grants and revocations both change live access; hosts must not treat a grant as a harmless additive update.
    expect(byName.assign_user_roles.annotations?.destructiveHint).toBe(true);
    expect(byName.remove_user_role.annotations?.destructiveHint).toBe(true);
    expect(byName.create_role.annotations?.destructiveHint).toBe(false);
  });

  it("fails fast when a fake client method is not overridden", async () => {
    const client = await connected(fakeClient());
    const r: any = await client.callTool({ name: "list_roles", arguments: { integrationId: 1, environment: "dev" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/unmocked CssClient method/);
  });

  it("explains missing credentials instead of throwing", async () => {
    vi.stubEnv("CSS_API_CLIENT_ID", "");
    vi.stubEnv("CSS_API_CLIENT_SECRET", "");
    const client = await connected();
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/CSS_API_CLIENT_ID/);
  });

  it("does not expose the client secret in any tool output or error", async () => {
    vi.stubEnv("CSS_API_CLIENT_ID", "id-123");
    vi.stubEnv("CSS_API_CLIENT_SECRET", "super-secret-value");
    vi.stubEnv("CSS_TOKEN_URL", "http://insecure.example.test/token");
    const client = await connected();
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/HTTPS/);
    expect(textOf(r)).not.toContain("super-secret-value");
  });

  it("refuses to send the team secret to a host outside gov.bc.ca unless opted out", async () => {
    vi.stubEnv("CSS_API_CLIENT_ID", "id-123");
    vi.stubEnv("CSS_API_CLIENT_SECRET", "super-secret-value");
    vi.stubEnv("CSS_API_URL", "https://api.evil.example.com/api/v1");
    const client = await connected();
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/must point at a \*\.gov\.bc\.ca host \(got api\.evil\.example\.com\)/);
    expect(textOf(r)).not.toContain("super-secret-value");
  });
});

describe("read tools", () => {
  it("formats integrations and neutralises control, bidi and backtick characters from CSS", async () => {
    const client = await connected(
      fakeClient({
        listIntegrations: async () => [
          { id: 6551, projectName: "arts-po-c", authType: "oidc", environments: ["dev"], status: "applied" },
          { id: 2, projectName: `evil\`\n- **fake** — id \`9\`${RLO}`, authType: "oidc", environments: ["dev"], status: "applied" },
        ],
      }),
    );
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    const text = textOf(r);
    expect(text).toContain("**arts-po-c** — id `6551` — oidc — envs: dev — applied");
    expect(text).toContain("**evil - **fake** — id 9** — id `2`");
    expect(text).not.toContain("\n- **fake**");
    expect(text).not.toContain(RLO);
    expect(text).not.toContain("Prod writes are ENABLED");
  });

  it("shows a banner when prod writes are enabled", async () => {
    vi.stubEnv("CSS_ALLOW_PROD_WRITES", "true");
    const client = await connected(fakeClient({ listIntegrations: async () => [] }));
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    expect(textOf(r)).toContain("Prod writes are ENABLED");
  });

  it("lists roles, passes integration/env through, and sanitises role names", async () => {
    const spy = vi.fn(async () => [{ name: "ARTS_ADMIN", composite: true }, { name: "bad`name\nX" }]);
    const client = await connected(fakeClient({ listRoles: spy }));
    const r: any = await client.callTool({ name: "list_roles", arguments: { integrationId: 6551, environment: "test" } });
    expect(spy).toHaveBeenCalledWith(6551, "test");
    expect(textOf(r)).toContain("- `ARTS_ADMIN` (composite)");
    expect(textOf(r)).toContain("- `bad name X`");
  });

  it.each([
    ["list_integrations", {}, "listIntegrations", [], "No integrations are owned"],
    ["list_roles", { integrationId: 1, environment: "dev" }, "listRoles", [], "No roles on integration 1 (dev)"],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "A" }, "listRoleUsers", { users: [], more: false }, "No users hold `A`"],
    ["list_user_roles", { integrationId: 1, environment: "dev", username: GUID_USER }, "listUserRoles", [], "holds no roles"],
    ["search_idir_users", { lastName: "Nobody" }, "searchIdirUsers", [], "No matching IDIR users"],
  ])("reports an empty result for %s without an error", async (name, args, method, value, expected) => {
    const client = await connected(fakeClient({ [method]: async () => value }));
    const r: any = await client.callTool({ name, arguments: args as any });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(expected);
  });

  it("passes limit to the client and says when more holders may exist", async () => {
    const spy = vi.fn(async () => ({ users: [{ username: GUID_USER }, { username: OTHER_USER }], more: true }));
    const client = await connected(fakeClient({ listRoleUsers: spy }));
    const r: any = await client.callTool({
      name: "list_role_users",
      arguments: { integrationId: 1, environment: "dev", roleName: "A", limit: 2 },
    });
    expect(spy).toHaveBeenCalledWith(1, "dev", "A", 2);
    expect(textOf(r)).toContain("**2 user(s) (more may exist)** hold `A`");
    expect(textOf(r)).toContain("more holders may exist");
  });

  it("uses the default limit and reports an exact count when the walk finished", async () => {
    const spy = vi.fn(async () => ({ users: [{ username: GUID_USER }], more: false }));
    const client = await connected(fakeClient({ listRoleUsers: spy }));
    const r: any = await client.callTool({
      name: "list_role_users",
      arguments: { integrationId: 1, environment: "dev", roleName: "A" },
    });
    expect(spy).toHaveBeenCalledWith(1, "dev", "A", 50);
    expect(textOf(r)).toContain("**1 user(s)** hold `A`");
    expect(textOf(r)).not.toContain("may exist");
  });

  it("formats name, login and email when scrubbing is off", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "false");
    const client = await connected(
      fakeClient({
        listRoleUsers: async () => ({
          users: [
            { username: "g1@azureidir", firstName: "Jane", lastName: "Smith", email: "jane@gov.bc.ca", attributes: { idir_username: ["JSMITH"] } },
            { username: "g2@azureidir", attributes: { displayName: "Doe, John" } },
            { username: "g3@azureidir" },
          ],
          more: false,
        }),
      }),
    );
    const r: any = await client.callTool({ name: "list_role_users", arguments: { integrationId: 1, environment: "dev", roleName: "A" } });
    const text = textOf(r);
    expect(text).toContain("- **Jane Smith** (JSMITH) — jane@gov.bc.ca — `g1@azureidir`");
    expect(text).toContain("- **Doe, John** — `g2@azureidir`");
    expect(text).toContain("- **(no name)** — `g3@azureidir`");
  });

  it("scrubs names and omits login and email, keeping the federated username", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "true");
    const client = await connected(
      fakeClient({
        searchIdirUsers: async () => [
          {
            username: GUID_USER,
            firstName: "Jane",
            lastName: "Smith",
            email: "jane.smith@gov.bc.ca",
            attributes: { display_name: ["Smith, Jane CITZ:EX"], idir_username: ["JSMITH"] },
          },
        ],
      }),
    );
    const r: any = await client.callTool({ name: "search_idir_users", arguments: { lastName: "Smith" } });
    const text = textOf(r);
    expect(text).toMatch(/\*\*Person-\d+\*\*/);
    expect(text).toContain(`\`${GUID_USER}\``);
    expect(text).not.toContain("jane.smith@gov.bc.ca");
    expect(text).not.toContain("Smith, Jane");
    expect(text).not.toContain("JSMITH");
    expect(text).not.toContain("[EMAIL]");
  });

  it("tells the caller to narrow by email or guid when scrubbing hides the difference between matches", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "true");
    const two = [
      { username: GUID_USER, firstName: "A", lastName: "Smith" },
      { username: OTHER_USER, firstName: "B", lastName: "Smith" },
    ];
    const spy = vi.fn(async () => two);
    const client = await connected(fakeClient({ searchIdirUsers: spy }));
    const r: any = await client.callTool({ name: "search_idir_users", arguments: { lastName: "Smith" } });
    expect((spy.mock.calls[0] as unknown[])[0]).toBe("prod");
    expect(textOf(r)).toContain("Re-run with the person's `email` or `guid`");

    spy.mockResolvedValueOnce([two[0]]);
    const single: any = await client.callTool({ name: "search_idir_users", arguments: { email: "a@gov.bc.ca" } });
    expect(textOf(single)).not.toContain("Re-run");
  });

  it("caps search results at 25 by default and honours a smaller limit", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "false");
    const rows = Array.from({ length: 30 }, (_, i) => ({ username: `u${i}@azureidir` }));
    const client = await connected(fakeClient({ searchIdirUsers: async () => rows }));
    const r: any = await client.callTool({ name: "search_idir_users", arguments: { lastName: "Smith" } });
    expect(textOf(r)).toContain("Showing 25 of 30");
    const r5: any = await client.callTool({ name: "search_idir_users", arguments: { lastName: "Smith", limit: 5 } });
    expect(textOf(r5)).toContain("Showing 5 of 30");
  });

  it("scrubs PI out of upstream error messages", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "true");
    const client = await connected(
      fakeClient({
        listUserRoles: async () => {
          throw new Error("CSS API 404 Not Found on GET /x: user jane.smith@gov.bc.ca not found");
        },
      }),
    );
    const r: any = await client.callTool({ name: "list_user_roles", arguments: { integrationId: 1, environment: "dev", username: GUID_USER } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("[EMAIL]");
    expect(textOf(r)).not.toContain("jane.smith@gov.bc.ca");
  });
});

describe("input validation", () => {
  const many = Array.from({ length: 21 }, (_, i) => `R${i}`);
  it.each([
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "../users/x/roles-new" }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: ".." }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "evil`name" }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "two\nlines" }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "a,b" }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "A".repeat(101) }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "A", limit: 0 }],
    ["list_role_users", { integrationId: 1, environment: "dev", roleName: "A", limit: 501 }],
    ["list_roles", { integrationId: 0, environment: "dev" }],
    ["list_roles", { integrationId: 1.5, environment: "dev" }],
    ["list_user_roles", { integrationId: 1, environment: "dev", username: "JSMITH" }],
    ["list_user_roles", { integrationId: 1, environment: "dev", username: "abc@azureidir" }],
    ["assign_user_roles", { integrationId: 1, environment: "dev", username: GUID_USER, roleNames: [], confirm: `assign:1/dev/${GUID_USER}/` }],
    // The confirm is correct for all 21 roles, so only the schema bound can stop this one.
    ["assign_user_roles", { integrationId: 1, environment: "dev", username: GUID_USER, roleNames: many, confirm: `assign:1/dev/${GUID_USER}/${many.join(",")}` }],
    ["search_idir_users", { guid: "not-a-guid" }],
    ["search_idir_users", { firstName: "J" }],
    ["search_idir_users", { email: "ab" }],
    ["search_idir_users", { lastName: "Smith", limit: 101 }],
  ])("rejects out-of-range input for %s %j before calling CSS", async (name, args) => {
    const spy = vi.fn(async () => []);
    const client = await connected(fakeClient({ listRoleUsers: spy, listRoles: spy, listUserRoles: spy, assignUserRoles: spy, searchIdirUsers: spy }));
    const r: any = await client.callTool({ name, arguments: args as any });
    expect(r.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts dashed UUID usernames", async () => {
    const spy = vi.fn(async () => []);
    const client = await connected(fakeClient({ listUserRoles: spy }));
    const r: any = await client.callTool({
      name: "list_user_roles",
      arguments: { integrationId: 1, environment: "dev", username: "01234567-89ab-cdef-0123-456789abcdef@bceidbusiness" },
    });
    expect(r.isError).toBeFalsy();
    expect(spy).toHaveBeenCalled();
  });
});

describe("write tools", () => {
  it("refuses create_role without confirm=true and never calls CSS", async () => {
    const create = vi.fn();
    const client = await connected(fakeClient({ createRole: create }));
    const r: any = await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "FAM_ADMIN" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/requires explicit confirmation/);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a role when confirmed", async () => {
    const create = vi.fn(async () => ({ name: "FAM_ADMIN" }));
    const client = await connected(fakeClient({ createRole: create }));
    const r: any = await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "FAM_ADMIN", confirm: true } });
    expect(create).toHaveBeenCalledWith(7, "dev", "FAM_ADMIN");
    expect(textOf(r)).toContain("Created role `FAM_ADMIN` on integration 7 (dev).");
  });

  it("returns API errors as tool errors", async () => {
    const client = await connected(
      fakeClient({
        createRole: async () => {
          throw new Error("CSS API 409 Conflict on POST /integrations/7/dev/roles: exists");
        },
      }),
    );
    const r: any = await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "FAM_ADMIN", confirm: true } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("409 Conflict");
  });

  it("refuses prod writes unless CSS_ALLOW_PROD_WRITES=true", async () => {
    const remove = vi.fn();
    const client = await connected(fakeClient({ removeUserRole: remove }));
    const r: any = await client.callTool({
      name: "remove_user_role",
      arguments: { integrationId: 7, environment: "prod", username: GUID_USER, roleName: "A", confirm: `remove:7/prod/${GUID_USER}/A` },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/prod environment are disabled/);
    expect(remove).not.toHaveBeenCalled();

    expect(() => assertWriteAllowed("prod", { CSS_ALLOW_PROD_WRITES: "true" })).not.toThrow();
    expect(() => assertWriteAllowed("prod", { CSS_ALLOW_PROD_WRITES: "TRUE" })).toThrow();
    expect(() => assertWriteAllowed("test", {})).not.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["boolean-style", "true"],
    ["without the verb", `7/dev/${GUID_USER}/A`],
    ["the remove verb", `remove:7/dev/${GUID_USER}/A`],
    ["target without roles", `assign:7/dev/${GUID_USER}`],
    ["wrong integration", `assign:8/dev/${GUID_USER}/A`],
    ["wrong environment", `assign:7/test/${GUID_USER}/A`],
    ["wrong user", `assign:7/dev/${OTHER_USER}/A`],
    ["wrong role", `assign:7/dev/${GUID_USER}/B`],
    ["an extra role", `assign:7/dev/${GUID_USER}/A,B`],
  ])("refuses assign_user_roles when confirm is %s, without revealing the expected value", async (_label, confirm) => {
    const assign = vi.fn();
    const client = await connected(fakeClient({ assignUserRoles: assign }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], ...(confirm === undefined ? {} : { confirm }) },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("confirm does not match the operation, integrationId, environment, username and role(s)");
    expect(textOf(r)).not.toContain(ASSIGN_OK);
    expect(textOf(r)).not.toContain(`7/dev/${GUID_USER}/A"`);
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["the assign verb", `assign:7/test/${GUID_USER}/A`],
    ["wrong environment", `remove:7/dev/${GUID_USER}/A`],
    ["wrong user", `remove:7/test/${OTHER_USER}/A`],
    ["wrong role", `remove:7/test/${GUID_USER}/B`],
  ])("refuses remove_user_role when confirm is %s", async (_label, confirm) => {
    const remove = vi.fn();
    const client = await connected(fakeClient({ removeUserRole: remove }));
    const r: any = await client.callTool({
      name: "remove_user_role",
      arguments: { integrationId: 7, environment: "test", username: GUID_USER, roleName: "A", ...(confirm === undefined ? {} : { confirm }) },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("confirm does not match");
    expect(textOf(r)).not.toContain(REMOVE_OK);
    expect(remove).not.toHaveBeenCalled();
  });

  it("accepts the role list in any order and any spacing", async () => {
    const assign = vi.fn(async () => undefined);
    const client = await connected(fakeClient({ assignUserRoles: assign, listUserRoles: beforeAfter([], ["a_role", "B-role"]) }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["a_role", "B-role"], confirm: `assign:7/dev/${GUID_USER}/B-role, a_role` },
    });
    expect(r.isError).toBeFalsy();
    expect(assign).toHaveBeenCalledWith(7, "dev", GUID_USER, ["a_role", "B-role"]);
  });

  it("assigns roles, re-reads the user and reports what is held", async () => {
    const assign = vi.fn(async () => undefined);
    const listUserRoles = beforeAfter(["OTHER"], ["FAM_ADMIN", "OTHER"]);
    const client = await connected(fakeClient({ assignUserRoles: assign, listUserRoles }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["FAM_ADMIN"], confirm: `assign:7/dev/${GUID_USER}/FAM_ADMIN` },
    });
    expect(assign).toHaveBeenCalledWith(7, "dev", GUID_USER, ["FAM_ADMIN"]);
    expect(listUserRoles).toHaveBeenCalledTimes(2);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(`Assigned \`FAM_ADMIN\` to \`${GUID_USER}\` on integration 7 (dev). Now holds: \`FAM_ADMIN\`, \`OTHER\`.`);
  });

  it("flags a partial assignment as an error naming the roles CSS did not apply", async () => {
    const client = await connected(fakeClient({ assignUserRoles: async () => undefined, listUserRoles: beforeAfter([], ["A"]) }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A", "B"], confirm: `assign:7/dev/${GUID_USER}/A,B` },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("NOT applied: `B`");
    expect(textOf(r)).toContain("Now holds: `A`.");
  });

  it("flags roles that were held before the write and are gone after it", async () => {
    const client = await connected(fakeClient({ assignUserRoles: async () => undefined, listUserRoles: beforeAfter(["X", "Y"], ["A", "Y"]) }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("DROPPED (held before, gone now): `X`");
  });

  it("reports an accepted write whose read-back failed instead of claiming success", async () => {
    const listUserRoles = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("CSS API 503 Error on GET /x: down"));
    const client = await connected(fakeClient({ assignUserRoles: async () => undefined, listUserRoles }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read-back failed");
    expect(textOf(r)).toContain("list_user_roles");
  });

  it("treats a malformed read-back as unverified rather than as an empty role set", async () => {
    const listUserRoles = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([null, { name: "A" }, "junk"]);
    const client = await connected(fakeClient({ assignUserRoles: async () => undefined, listUserRoles }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read-back failed");
    expect(textOf(r)).toContain("row without a role name");
  });

  it("still reads back when the CSS call errored, and reports the change as applied if CSS shows it", async () => {
    const client = await connected(
      fakeClient({
        assignUserRoles: async () => {
          throw new Error("CSS API 504 Gateway Timeout on POST /x: upstream");
        },
        listUserRoles: beforeAfter([], ["A"]),
      }),
    );
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Assigned `A`");
    expect(textOf(r)).toContain("CSS call reported an error");
    expect(textOf(r)).toContain("read-back shows the change applied");
  });

  it("reports a plain failure when the CSS call errored and the read-back shows no change", async () => {
    const client = await connected(
      fakeClient({
        assignUserRoles: async () => {
          throw new Error("CSS API 500 Error on POST /x: boom");
        },
        listUserRoles: beforeAfter([], []),
      }),
    );
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Error assigning roles: CSS API 500");
    expect(textOf(r)).toContain("Now holds: nothing.");
  });

  it("says it is unknown whether CSS applied the change when both the call and the read-back fail", async () => {
    const listUserRoles = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("CSS API 503 Error on GET /x: down"));
    const client = await connected(
      fakeClient({
        assignUserRoles: async () => {
          throw new Error("TimeoutError: The operation was aborted due to timeout");
        },
        listUserRoles,
      }),
    );
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unknown whether CSS applied the change");
  });

  it("removes a role when confirmed on a non-prod env and confirms it is gone", async () => {
    const remove = vi.fn(async () => undefined);
    const client = await connected(fakeClient({ removeUserRole: remove, listUserRoles: beforeAfter(["A", "OTHER"], ["OTHER"]) }));
    const r: any = await client.callTool({
      name: "remove_user_role",
      arguments: { integrationId: 7, environment: "test", username: GUID_USER, roleName: "A", confirm: REMOVE_OK },
    });
    expect(remove).toHaveBeenCalledWith(7, "test", GUID_USER, "A");
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(`Removed \`A\` from \`${GUID_USER}\` on integration 7 (test). Now holds: \`OTHER\`.`);
  });

  it("flags a removal that CSS accepted but did not apply", async () => {
    const client = await connected(fakeClient({ removeUserRole: async () => undefined, listUserRoles: beforeAfter(["A"], ["A"]) }));
    const r: any = await client.callTool({
      name: "remove_user_role",
      arguments: { integrationId: 7, environment: "test", username: GUID_USER, roleName: "A", confirm: REMOVE_OK },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("still holds `A`");
  });

  it("still writes when the before-state read fails, and says the dropped-role check was skipped", async () => {
    const listUserRoles = vi.fn().mockRejectedValueOnce(new Error("CSS API 503 Error on GET /x: down")).mockResolvedValueOnce([{ name: "A" }]);
    const assign = vi.fn(async () => undefined);
    const client = await connected(fakeClient({ assignUserRoles: assign, listUserRoles }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(assign).toHaveBeenCalled();
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("roles dropped as a side effect were not checked");
  });
});

describe("audit trail", () => {
  async function tempAudit() {
    const dir = await mkdtemp(join(tmpdir(), "css-audit-"));
    tempDirs.push(dir);
    return { dir, audit: new AuditLog<CssAuditRecord>({ stream: "css", dir }) };
  }

  async function records(dir: string) {
    const files = (await readdir(dir)).filter((f) => f.startsWith("css.") && f.endsWith(".jsonl"));
    const lines = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
    return lines.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("records an attempted line before the write and an applied line after, linked by attemptId", async () => {
    const { dir, audit } = await tempAudit();
    const client = await connected(
      fakeClient({ assignUserRoles: async () => undefined, listUserRoles: beforeAfter([], ["A"]) }),
      { audit },
    );
    await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    const recs = await records(dir);
    expect(recs.map((r) => r.outcome)).toEqual(["attempted", "applied"]);
    expect(recs[0].attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recs[1].attemptId).toBe(recs[0].attemptId);
    for (const rec of recs) {
      expect(rec).toMatchObject({ tool: "assign_user_roles", integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"] });
      expect(rec.osUser.length).toBeGreaterThan(0);
      expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("records refused and failed attempts too", async () => {
    const { dir, audit } = await tempAudit();
    const client = await connected(
      fakeClient({
        createRole: async () => {
          throw new Error("CSS API 409 Conflict on POST /x: exists");
        },
      }),
      { audit },
    );
    await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "R" } });
    await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "R", confirm: true } });
    const recs = await records(dir);
    expect(recs.map((r) => r.outcome)).toEqual(["refused", "attempted", "failed"]);
    expect(recs[2].detail).toBe("CSS API 409 Conflict on POST /x");
    expect(recs[2].attemptId).toBe(recs[1].attemptId);
  });

  it("records partial, unverified and errored-but-applied outcomes with a PI-free detail", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "false");
    const { dir, audit } = await tempAudit();
    const listUserRoles = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "A" }]) // call 1: partial (B missing)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("CSS API 503 Error on GET /x: jane.smith@gov.bc.ca down")) // call 2: unverified
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "A" }]); // call 3: CSS errored, read-back shows applied
    let calls = 0;
    const assign = vi.fn(async () => {
      if (++calls === 3) throw new Error("CSS API 504 Gateway Timeout on POST /x: slow");
    });
    const client = await connected(fakeClient({ assignUserRoles: assign, listUserRoles }), { audit });
    await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A", "B"], confirm: `assign:7/dev/${GUID_USER}/A,B` },
    });
    await client.callTool({ name: "assign_user_roles", arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK } });
    await client.callTool({ name: "assign_user_roles", arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK } });
    const recs = await records(dir);
    expect(recs.map((r) => r.outcome)).toEqual(["attempted", "partial", "attempted", "unverified", "attempted", "applied"]);
    expect(recs[1].detail).toBe("NOT applied: B");
    expect(recs[3].detail).toBe("read-back failed: CSS API 503 Error on GET /x");
    expect(recs[5].detail).toContain("CSS call errored (CSS API 504 Gateway Timeout on POST /x) but the read-back shows the change applied");
    expect(JSON.stringify(recs)).not.toContain("jane.smith@gov.bc.ca");
  });

  it("notes a skipped dropped-role check in the audit detail when the before-state read failed", async () => {
    const { dir, audit } = await tempAudit();
    const listUserRoles = vi.fn().mockRejectedValueOnce(new Error("CSS API 503 Error on GET /x: down")).mockResolvedValueOnce([{ name: "A" }]);
    const client = await connected(fakeClient({ assignUserRoles: async () => undefined, listUserRoles }), { audit });
    await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A", "B"], confirm: `assign:7/dev/${GUID_USER}/A,B` },
    });
    const recs = await records(dir);
    expect(recs.at(-1)).toMatchObject({ outcome: "partial" });
    expect(recs.at(-1).detail).toBe("NOT applied: B; before-state unavailable; dropped-role check skipped");
  });

  it("keeps upstream PI out of the audit detail even when scrubbing is off", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "false");
    const { dir, audit } = await tempAudit();
    const client = await connected(
      fakeClient({
        createRole: async () => {
          throw new Error("CSS API 400 Error on POST /x: jane.smith@gov.bc.ca already holds it");
        },
      }),
      { audit },
    );
    await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "R", confirm: true } });
    expect(JSON.stringify(await records(dir))).not.toContain("jane.smith@gov.bc.ca");
    expect(auditDetail(new Error("fakeClient: ask bob.lee@gov.bc.ca\nfor help"))).toBe("fakeClient: ask [EMAIL] for help");
  });

  it("refuses a write when the write-ahead audit line cannot be written", async () => {
    const audit = { append: async () => { throw new Error("disk full"); } } as unknown as AuditLog<CssAuditRecord>;
    const create = vi.fn(async () => ({ name: "R" }));
    const assign = vi.fn(async () => undefined);
    const client = await connected(fakeClient({ createRole: create, assignUserRoles: assign, listUserRoles: async () => [] }), { audit });

    const c: any = await client.callTool({ name: "create_role", arguments: { integrationId: 7, environment: "dev", roleName: "R", confirm: true } });
    expect(c.isError).toBe(true);
    expect(textOf(c)).toContain("refused because the audit log could not be written: disk full");
    expect(create).not.toHaveBeenCalled();

    const a: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: GUID_USER, roleNames: ["A"], confirm: ASSIGN_OK },
    });
    expect(a.isError).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it("audits directory searches with criteria keys and a row count, never values", async () => {
    const { dir, audit } = await tempAudit();
    const client = await connected(fakeClient({ searchIdirUsers: async () => [{ username: GUID_USER, email: "jane@gov.bc.ca" }] }), { audit });
    await client.callTool({ name: "search_idir_users", arguments: { lastName: "Smith", email: "jane@gov.bc.ca" } });
    const [rec] = await records(dir);
    expect(rec).toMatchObject({ tool: "search_idir_users", environment: "prod", criteria: ["lastName", "email"], results: 1, outcome: "searched" });
    expect(JSON.stringify(rec)).not.toContain("Smith");
    expect(JSON.stringify(rec)).not.toContain("jane@gov.bc.ca");
  });

  it("withholds directory rows when the search audit line cannot be written", async () => {
    const audit = { append: async () => { throw new Error("lock timeout"); } } as unknown as AuditLog<CssAuditRecord>;
    const client = await connected(fakeClient({ searchIdirUsers: async () => [{ username: GUID_USER, email: "x@gov.bc.ca" }] }), { audit });
    const r: any = await client.callTool({ name: "search_idir_users", arguments: { email: "x@gov.bc.ca" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("results withheld because the audit log could not be written");
    expect(textOf(r)).not.toContain("@azureidir");
  });

  it("refuses a criteria-less search before CSS and audits it as failed", async () => {
    const { dir, audit } = await tempAudit();
    const client = await connected(fakeClient(), { audit });
    const r: any = await client.callTool({ name: "search_idir_users", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/at least one of firstName/);
    const [rec] = await records(dir);
    expect(rec).toMatchObject({ tool: "search_idir_users", environment: "prod", outcome: "failed", criteria: [] });
  });
});
