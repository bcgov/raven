import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CssClient } from "../css-client.js";
import { createCssServer } from "../server.js";

async function connected(clientOverride?: CssClient) {
  const server = createCssServer(clientOverride);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "css-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open.push({ client, server });
  return client;
}

const open: Array<{ client: Client; server: ReturnType<typeof createCssServer> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A CssClient whose methods are all mocked; nothing reaches the network. */
function fakeClient(overrides: Partial<Record<keyof CssClient, unknown>> = {}) {
  const c = new CssClient({ clientId: "x", clientSecret: "y", apiUrl: "https://x", tokenUrl: "https://x" });
  for (const [name, impl] of Object.entries(overrides)) {
    vi.spyOn(c as any, name).mockImplementation(impl as any);
  }
  return c;
}

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
    }
    expect(byName.remove_user_role.annotations?.destructiveHint).toBe(true);
  });

  it("explains missing credentials instead of throwing", async () => {
    vi.stubEnv("CSS_API_CLIENT_ID", "");
    vi.stubEnv("CSS_API_CLIENT_SECRET", "");
    const client = await connected();
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/CSS_API_CLIENT_ID/);
  });

  it("formats integrations", async () => {
    const client = await connected(
      fakeClient({
        listIntegrations: async () => [
          { id: 6551, projectName: "arts-po-c", authType: "oidc", environments: ["dev"], status: "applied" },
        ],
      }),
    );
    const r: any = await client.callTool({ name: "list_integrations", arguments: {} });
    expect(textOf(r)).toContain("**arts-po-c** — id `6551` — oidc — envs: dev — applied");
  });

  it("scrubs names and emails but keeps the federated username", async () => {
    vi.stubEnv("RAVEN_SCRUB_PI", "true");
    const client = await connected(
      fakeClient({
        searchIdirUsers: async () => [
          {
            username: "0123456789abcdef0123456789abcdef@azureidir",
            firstName: "Jane",
            lastName: "Smith",
            email: "jane.smith@gov.bc.ca",
            attributes: { display_name: ["Smith, Jane CITZ:EX"] },
          },
        ],
      }),
    );
    const r: any = await client.callTool({ name: "search_idir_users", arguments: { lastName: "Smith" } });
    const text = textOf(r);
    expect(text).toContain("`0123456789abcdef0123456789abcdef@azureidir`");
    expect(text).not.toContain("jane.smith@gov.bc.ca");
    expect(text).not.toContain("Smith, Jane");
  });

  it("caps long user lists and says so", async () => {
    const users = Array.from({ length: 60 }, (_, i) => ({ username: `u${i}@azureidir` }));
    const client = await connected(fakeClient({ listRoleUsers: async () => users }));
    const r: any = await client.callTool({
      name: "list_role_users",
      arguments: { integrationId: 1, environment: "dev", roleName: "A" },
    });
    expect(textOf(r)).toContain("Showing 50 of 60");
  });

  it("rejects a username that is not in federated form before calling CSS", async () => {
    const assign = vi.fn();
    const client = await connected(fakeClient({ assignUserRoles: assign }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 1, environment: "dev", username: "JSMITH", roleNames: ["A"] },
    });
    expect(r.isError).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it("assigns roles and reports what changed", async () => {
    const assign = vi.fn(async () => undefined);
    const client = await connected(fakeClient({ assignUserRoles: assign }));
    const r: any = await client.callTool({
      name: "assign_user_roles",
      arguments: { integrationId: 7, environment: "dev", username: "abc@azureidir", roleNames: ["FAM_ADMIN"] },
    });
    expect(assign).toHaveBeenCalledWith(7, "dev", "abc@azureidir", ["FAM_ADMIN"]);
    expect(textOf(r)).toContain("Assigned `FAM_ADMIN` to `abc@azureidir` on integration 7 (dev).");
  });

  it("returns API errors as tool errors", async () => {
    const client = await connected(
      fakeClient({
        createRole: async () => {
          throw new Error("CSS API 409 Conflict on POST /integrations/7/dev/roles: exists");
        },
      }),
    );
    const r: any = await client.callTool({
      name: "create_role",
      arguments: { integrationId: 7, environment: "dev", roleName: "FAM_ADMIN" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("409 Conflict");
  });
});
