import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PiScrubber } from "@nrs/auth";
import { CssClient } from "./css-client.js";
import type { CssRole, CssUser } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown) => pi.scrubText(err instanceof Error ? err.message : String(err));

const DEFAULT_API_URL = "https://api.loginproxy.gov.bc.ca/api/v1";
const DEFAULT_TOKEN_URL =
  "https://loginproxy.gov.bc.ca/auth/realms/standard/protocol/openid-connect/token";

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------
const integrationId = z.number().int().positive().describe("CSS integration id (from list_integrations)");
const environment = z.enum(["dev", "test", "prod"]).describe("Integration environment");
const roleName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\\]+$/, "Role name must not contain slashes")
  .describe("Client role name, e.g. ARTS_ADMIN");
const username = z
  .string()
  .trim()
  .regex(/^[^/\\\s@]+@[a-z]+$/i, "Expected the federated form <guid>@<idp>, e.g. 1a2b...@azureidir")
  .describe("Federated username <guid>@<idp>, e.g. from search_idir_users");
const limit = z.number().int().min(1).max(500).optional().describe("Max rows to show (default 50)");

// ---------------------------------------------------------------------------
// Global config (API account)
// ---------------------------------------------------------------------------
function getConfig() {
  const clientId = process.env.CSS_API_CLIENT_ID;
  const clientSecret = process.env.CSS_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "CSS_API_CLIENT_ID / CSS_API_CLIENT_SECRET are not set in environment or ~/.raven/.env " +
        "(request a CSS API Account for your team in the SSO-requests app)",
    );
  }
  return {
    clientId,
    clientSecret,
    apiUrl: process.env.CSS_API_URL || DEFAULT_API_URL,
    tokenUrl: process.env.CSS_TOKEN_URL || DEFAULT_TOKEN_URL,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function firstAttr(user: CssUser, key: string): string | undefined {
  const v = user.attributes?.[key];
  return Array.isArray(v) ? v[0] : v;
}

/** One user line. Names and email go through the PI scrubber; username does not, as it is the assignment key. */
function fmtUser(u: CssUser): string {
  const display =
    firstAttr(u, "display_name") ?? firstAttr(u, "displayName") ?? [u.firstName, u.lastName].filter(Boolean).join(" ");
  const name = display ? pi.scrub(display) : "(no name)";
  const login = firstAttr(u, "idir_username") ?? firstAttr(u, "bceid_username");
  const loginPart = login ? ` (${pi.scrubText(login)})` : "";
  const email = u.email ? ` — ${pi.scrubText(u.email)}` : "";
  return `- **${name}**${loginPart}${email} — \`${u.username}\``;
}

function fmtRole(r: CssRole): string {
  return `- \`${r.name}\`${r.composite ? " (composite)" : ""}`;
}

function capped<T>(rows: T[], max: number | undefined, fmt: (row: T) => string): string {
  const n = max ?? 50;
  const shown = rows.slice(0, n).map(fmt).join("\n");
  return rows.length > n ? `${shown}\n\n_Showing ${n} of ${rows.length}; raise \`limit\` to see more._` : shown;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (prefix: string, err: unknown) => ({
  content: [{ type: "text" as const, text: `${prefix}: ${safeErr(err)}` }],
  isError: true,
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
/**
 * Creates the CSS MCP server.
 *
 * @param clientOverride - Optional pre-built client, for tests.
 */
export function createCssServer(clientOverride?: CssClient): McpServer {
  const server = new McpServer(
    { name: "RAVEN CSS", version: "0.1.0" },
    {
      instructions:
        "Tools for the BC Gov Common Hosted Single Sign-On (CSS) API: Gold integrations, client roles, " +
        "and user-role assignments. The API account only reaches integrations owned by its CSS team. " +
        "Write tools (create_role, assign_user_roles, remove_user_role) change who can access live applications — " +
        "always confirm the integration, environment, user and role with the user before calling them. " +
        "Find a user's federated username with search_idir_users before assigning roles. " +
        "Set CSS_API_CLIENT_ID and CSS_API_CLIENT_SECRET in ~/.raven/.env.",
    },
  );

  let client: CssClient | null = clientOverride ?? null;
  const getClient = (): CssClient => (client ??= new CssClient(getConfig()));

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------
  server.tool(
    "list_integrations",
    "List the Gold integrations owned by the CSS API account's team, with ids and environments.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const rows = await getClient().listIntegrations();
        if (!rows.length) return ok("_No integrations are owned by this API account's team._");
        const lines = rows.map(
          (i) =>
            `- **${i.projectName}** — id \`${i.id}\` — ${i.authType ?? "?"} — envs: ${(i.environments ?? []).join(", ") || "none"} — ${i.status ?? "?"}`,
        );
        return ok(`**${rows.length} integration(s)**\n\n${lines.join("\n")}`);
      } catch (err) {
        return fail("Error listing integrations", err);
      }
    },
  );

  server.tool(
    "list_roles",
    "List the client roles defined on one integration environment.",
    { integrationId, environment },
    { readOnlyHint: true },
    async ({ integrationId, environment }) => {
      try {
        const rows = await getClient().listRoles(integrationId, environment);
        if (!rows.length) return ok(`_No roles on integration ${integrationId} (${environment})._`);
        return ok(`**${rows.length} role(s)** on ${integrationId} (${environment})\n\n${rows.map(fmtRole).join("\n")}`);
      } catch (err) {
        return fail("Error listing roles", err);
      }
    },
  );

  server.tool(
    "list_role_users",
    "List the users holding one role on one integration environment.",
    { integrationId, environment, roleName, limit },
    { readOnlyHint: true },
    async ({ integrationId, environment, roleName, limit }) => {
      try {
        const rows = await getClient().listRoleUsers(integrationId, environment, roleName);
        if (!rows.length) return ok(`_No users hold \`${roleName}\` on ${integrationId} (${environment})._`);
        return ok(`**${rows.length} user(s)** hold \`${roleName}\`\n\n${capped(rows, limit, fmtUser)}`);
      } catch (err) {
        return fail("Error listing role users", err);
      }
    },
  );

  server.tool(
    "list_user_roles",
    "List the roles one user holds on one integration environment.",
    { integrationId, environment, username },
    { readOnlyHint: true },
    async ({ integrationId, environment, username }) => {
      try {
        const rows = await getClient().listUserRoles(integrationId, environment, username);
        if (!rows.length) return ok(`_\`${username}\` holds no roles on ${integrationId} (${environment})._`);
        return ok(`**${rows.length} role(s)** held by \`${username}\`\n\n${rows.map(fmtRole).join("\n")}`);
      } catch (err) {
        return fail("Error listing user roles", err);
      }
    },
  );

  server.tool(
    "search_idir_users",
    "Search the IDIR (Azure AD) directory to find a person's federated username (<guid>@azureidir). " +
      "Provide at least one of firstName, lastName, email or guid.",
    {
      environment: environment.default("prod"),
      firstName: z.string().trim().min(2).optional().describe("First name (prefix match)"),
      lastName: z.string().trim().min(2).optional().describe("Last name (prefix match)"),
      email: z.string().trim().min(3).optional().describe("Email address"),
      guid: z.string().trim().regex(/^[0-9a-f]{32}$/i).optional().describe("IDIR GUID (32 hex characters)"),
      limit,
    },
    { readOnlyHint: true },
    async ({ environment, firstName, lastName, email, guid, limit }) => {
      try {
        const rows = await getClient().searchIdirUsers(environment, { firstName, lastName, email, guid });
        if (!rows.length) return ok("_No matching IDIR users._");
        return ok(`**${rows.length} match(es)**\n\n${capped(rows, limit, fmtUser)}`);
      } catch (err) {
        return fail("Error searching IDIR users", err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Write tools
  // -------------------------------------------------------------------------
  server.tool(
    "create_role",
    "Create a client role on one integration environment. Confirm with the user before invoking.",
    { integrationId, environment, roleName },
    { readOnlyHint: false, destructiveHint: false },
    async ({ integrationId, environment, roleName }) => {
      try {
        const role = await getClient().createRole(integrationId, environment, roleName);
        return ok(`Created role \`${role.name}\` on integration ${integrationId} (${environment}).`);
      } catch (err) {
        return fail("Error creating role", err);
      }
    },
  );

  server.tool(
    "assign_user_roles",
    "Assign one or more roles to a user on one integration environment. Works before the user's first " +
      "login (CSS verifies the username with the IdP). Only azureidir and bceidbusiness usernames are accepted. " +
      "Confirm with the user before invoking — this grants application access.",
    {
      integrationId,
      environment,
      username,
      roleNames: z.array(roleName).min(1).max(20).describe("Roles to assign"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ integrationId, environment, username, roleNames }) => {
      try {
        await getClient().assignUserRoles(integrationId, environment, username, roleNames);
        return ok(
          `Assigned ${roleNames.map((r) => `\`${r}\``).join(", ")} to \`${username}\` on integration ${integrationId} (${environment}).`,
        );
      } catch (err) {
        return fail("Error assigning roles", err);
      }
    },
  );

  server.tool(
    "remove_user_role",
    "Remove one role from a user on one integration environment. The role itself stays defined. " +
      "Confirm with the user before invoking — this revokes application access.",
    { integrationId, environment, username, roleName },
    { readOnlyHint: false, destructiveHint: true },
    async ({ integrationId, environment, username, roleName }) => {
      try {
        await getClient().removeUserRole(integrationId, environment, username, roleName);
        return ok(`Removed \`${roleName}\` from \`${username}\` on integration ${integrationId} (${environment}).`);
      } catch (err) {
        return fail("Error removing role", err);
      }
    },
  );

  return server;
}
