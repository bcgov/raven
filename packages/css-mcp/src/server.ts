import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuditLog, PiScrubber } from "@nrs/auth";
import { CssClient, stripUnsafe } from "./css-client.js";
import type { CssEnvironment, CssRole, CssUser } from "./types.js";

export { assertTrustedHost } from "./css-client.js";

const pi = new PiScrubber();

/** The one CSS error shape that carries an upstream body: `CSS API <status> <text> on <METHOD> <route>: <body>`. */
const CSS_BODY_ERROR = /^(CSS API \d{3} .*? on [A-Z]+ \/\S*): /;

/**
 * Error text for the model. With PI scrubbing on, a CSS error is reduced to
 * its status and route: the upstream body can name people in ways no pattern
 * catches. Otherwise the message is pattern-scrubbed as usual.
 */
function safeErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (pi.isEnabled()) {
    const css = CSS_BODY_ERROR.exec(msg);
    if (css) return `${css[1]} (upstream body withheld while PI scrubbing is on)`;
  }
  return pi.scrubText(msg);
}

const DEFAULT_API_URL = "https://api.loginproxy.gov.bc.ca/api/v1";
const DEFAULT_TOKEN_URL =
  "https://loginproxy.gov.bc.ca/auth/realms/standard/protocol/openid-connect/token";
/** Rows shown by default for role listings. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Directory searches return personal information, so they show fewer rows. */
const SEARCH_LIMIT = 25;
const SEARCH_MAX_LIMIT = 100;
/** Longest free-text `detail` kept in an audit line. */
const MAX_AUDIT_DETAIL = 160;

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------
const integrationId = z.number().int().positive().describe("CSS integration id (from list_integrations)");
const environment = z.enum(["dev", "test", "prod"]).describe("Integration environment");
/**
 * Printable role names only: no control characters, slashes, commas, backticks
 * or dot segments, so a name can neither steer the request path, inject lines
 * into later listings, nor blur the role list inside a confirm string.
 */
const roleName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 _.:-]*$/,
    "Role name may contain letters, digits, spaces, _ . : - and must start with a letter or digit",
  )
  .describe("Client role name, e.g. ARTS_ADMIN");
/** CSS federated usernames: an IDIR/BCeID GUID (32 hex, or a dashed UUID) and the IdP alias. */
const username = z
  .string()
  .trim()
  .regex(
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})@[a-z]+$/i,
    "Expected the federated form <guid>@<idp>, e.g. 1a2b...@azureidir",
  )
  .describe("Federated username <guid>@<idp>, e.g. from search_idir_users");
const limit = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe(`Max rows to show (default ${DEFAULT_LIMIT})`);
const searchLimit = z
  .number()
  .int()
  .min(1)
  .max(SEARCH_MAX_LIMIT)
  .default(SEARCH_LIMIT)
  .describe(`Max rows to show (default ${SEARCH_LIMIT}, max ${SEARCH_MAX_LIMIT}); narrow the search rather than raising this`);
const nameFilter = (what: string) => z.string().trim().min(2).max(100).optional().describe(`${what} (prefix match)`);
const confirmFlag = z
  .boolean()
  .default(false)
  .describe("Must be true to execute this write. Set it only after the user has approved the exact inputs.");
const confirmTarget = z
  .string()
  .trim()
  .default("")
  .describe(
    'Must equal "<verb>:<integrationId>/<environment>/<username>/<roles>" for this exact call: <verb> is assign or remove, ' +
      "<roles> is the role name for remove_user_role or the comma-separated role names (any order) for assign_user_roles, e.g. " +
      '"assign:6551/dev/1a2b...@azureidir/ARTS_ADMIN,ARTS_VIEWER" or "remove:6551/dev/1a2b...@azureidir/ARTS_ADMIN". ' +
      "Set it only after the user has approved that exact operation, target and roles.",
  );

/** Throws when a write has not been explicitly confirmed. */
function requireConfirmation(confirmed: boolean, operation: string): void {
  if (!confirmed) {
    throw new Error(
      `"${operation}" requires explicit confirmation. Pass confirm=true after the user approves the inputs.`,
    );
  }
}

/**
 * Throws unless the caller restated the verb, the exact target and the same
 * set of roles (order does not matter). The expected value is deliberately
 * not echoed: printing it would let an unattended agent copy it back and turn
 * the gate into a two-call retry.
 */
function requireTargetConfirmation(
  given: string,
  want: { verb: "assign" | "remove"; integrationId: number; environment: string; username: string; roleNames: string[] },
  operation: string,
): void {
  const prefix = `${want.verb}:${want.integrationId}/${want.environment}/${want.username}/`;
  const givenRoles = given.startsWith(prefix)
    ? given.slice(prefix.length).split(",").map((r) => r.trim()).filter(Boolean).sort()
    : null;
  const wantRoles = [...want.roleNames].sort();
  const matches =
    givenRoles !== null && givenRoles.length === wantRoles.length && givenRoles.every((r, i) => r === wantRoles[i]);
  if (!matches) {
    throw new Error(
      `"${operation}" was refused: confirm does not match the operation, integrationId, environment, username and role(s) in this call. ` +
        'Re-check each of them against what the user approved, then restate it as "<verb>:<integrationId>/<environment>/<username>/<roles>".',
    );
  }
}

/**
 * Production writes are off unless `CSS_ALLOW_PROD_WRITES=true`. A role grant
 * on prod is live application access; dev and test are where mistakes belong.
 */
export function assertWriteAllowed(env: string, environ: NodeJS.ProcessEnv = process.env): void {
  if (env === "prod" && environ.CSS_ALLOW_PROD_WRITES !== "true") {
    throw new Error(
      "Writes to the prod environment are disabled. Set CSS_ALLOW_PROD_WRITES=true in ~/.raven/.env " +
        "(or the environment that launches this server) to enable them.",
    );
  }
}

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
    allowAnyHost: process.env.CSS_ALLOW_ANY_HOST === "true",
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
/** Upstream text, flattened before it reaches the assistant (see {@link stripUnsafe}). */
const clean = (value: unknown): string => stripUnsafe(String(value ?? ""));

function firstAttr(user: CssUser, key: string): string | undefined {
  const v = user.attributes?.[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * One user line. With scrubbing on, only the pseudonymous name and the
 * federated username (the assignment key) remain; login and email are left
 * out rather than echoed.
 */
function fmtUser(u: CssUser): string {
  const display = clean(
    firstAttr(u, "display_name") ?? firstAttr(u, "displayName") ?? [u.firstName, u.lastName].filter(Boolean).join(" "),
  );
  const name = display ? pi.scrub(display) : "(no name)";
  const federated = `\`${clean(u.username)}\``;
  if (pi.isEnabled()) return `- **${name}** — ${federated}`;
  const login = clean(firstAttr(u, "idir_username") ?? firstAttr(u, "bceid_username"));
  const loginPart = login ? ` (${login})` : "";
  const email = u.email ? ` — ${clean(u.email)}` : "";
  return `- **${name}**${loginPart}${email} — ${federated}`;
}

function fmtRole(r: CssRole): string {
  return `- \`${clean(r.name)}\`${r.composite ? " (composite)" : ""}`;
}

/**
 * Role names from a read-back. A row that is not shaped like a role is an
 * error, not a gap: the caller must treat the result as unverified rather
 * than conclude the user holds nothing.
 */
function roleNamesOf(rows: unknown): string[] {
  if (!Array.isArray(rows)) throw new Error("CSS read-back was not a list of roles.");
  return rows.map((r) => {
    const name = r && typeof r === "object" ? (r as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !name) throw new Error("CSS read-back contained a row without a role name.");
    return name;
  });
}

const codeList = (names: Iterable<string>): string => [...names].map((n) => `\`${clean(n)}\``).join(", ");

function capped<T>(rows: T[], n: number, fmt: (row: T) => string): string {
  const shown = rows.slice(0, n).map(fmt).join("\n");
  return rows.length > n ? `${shown}\n\n_Showing ${n} of ${rows.length}; narrow the search to see the rest._` : shown;
}

const SCRUBBED_SEARCH_HINT =
  "\n\n_PI scrubbing is on, so these rows cannot be told apart by name. Re-run with the person's `email` or `guid` " +
  "so exactly one row matches before assigning roles._";
const BEFORE_STATE_NOTE = "\n\n_The before-state read failed, so roles dropped as a side effect were not checked._";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ ...ok(text), isError: true as const });
const fail = (prefix: string, e: unknown, suffix = "") => err(`${prefix}: ${safeErr(e)}${suffix}`);

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
/**
 * One line per write attempt and directory search in the local audit stream.
 * No names or emails: the federated username ties a change to a person, and
 * the OS user ties it to the operator, which CSS itself cannot do for a shared
 * team account. `attempted` is written before the CSS call and the outcome
 * after; `attemptId` links the two.
 */
export interface CssAuditRecord {
  tool: string;
  environment: string;
  outcome: "attempted" | "applied" | "partial" | "unverified" | "refused" | "failed" | "searched";
  osUser: string;
  attemptId?: string;
  integrationId?: number;
  username?: string;
  roleNames?: string[];
  /** Directory-search criteria keys only, never their values. */
  criteria?: string[];
  results?: number;
  detail?: string;
}

/** Options for {@link createCssServer}. */
export interface CssServerOptions {
  /** Audit log. Omit for the default `css` stream under `~/.raven/audit`; `null` disables it. */
  audit?: AuditLog<CssAuditRecord> | null;
}

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * What the audit `detail` may hold: the status/route head of a CSS error, or
 * a message with emails redacted. Never an upstream body, whatever the PI
 * scrubbing setting.
 */
export function auditDetail(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const css = CSS_BODY_ERROR.exec(msg);
  const head = css ? css[1] : msg.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[EMAIL]");
  return head.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_AUDIT_DETAIL);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
/**
 * Creates the CSS MCP server.
 *
 * @param clientOverride - Optional pre-built client, for tests.
 * @param opts - Audit log override, for tests.
 */
export function createCssServer(clientOverride?: CssClient, opts: CssServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "RAVEN CSS", version: "0.1.0" },
    {
      instructions:
        "Tools for the BC Gov Common Hosted Single Sign-On (CSS) API: Gold integrations, client roles, " +
        "and user-role assignments. The API account only reaches integrations owned by its CSS team. " +
        "Write tools change who can access live applications. create_role needs confirm=true; assign_user_roles and " +
        'remove_user_role need confirm="<verb>:<integrationId>/<environment>/<username>/<roles>" (verb assign or remove) ' +
        "restating the exact operation, target and roles, and both re-read the user's roles afterwards and report any " +
        "difference. Always get the user's approval of that exact operation, target and roles first; a refusal means " +
        "re-check the arguments with the user, not retry. Prod writes are refused unless CSS_ALLOW_PROD_WRITES=true. " +
        "Every write attempt and directory search is appended to the local audit log ~/.raven/audit/css.<month>.jsonl " +
        "with the operating-system user, and is refused if that line cannot be written. Find a user's federated username " +
        "with search_idir_users; prefer email or guid so exactly one row matches. Set CSS_API_CLIENT_ID and " +
        "CSS_API_CLIENT_SECRET in ~/.raven/.env.",
    },
  );

  let client: CssClient | null = clientOverride ?? null;
  const getClient = (): CssClient => (client ??= new CssClient(getConfig()));

  let audit: AuditLog<CssAuditRecord> | null | undefined = opts.audit;
  const getAudit = (): AuditLog<CssAuditRecord> | null =>
    audit === undefined ? (audit = new AuditLog<CssAuditRecord>({ stream: "css" })) : audit;

  /** Best-effort audit line; a failure is reported in the tool text, never hidden. */
  async function record(entry: Omit<CssAuditRecord, "osUser">): Promise<string> {
    const log = getAudit();
    if (!log) return "";
    try {
      await log.append({ ...entry, osUser: osUser() });
      return "";
    } catch (e) {
      return `\n\n_Audit record could not be written: ${safeErr(e)}_`;
    }
  }

  /** Audit line that must land; if it cannot be written the call does not go ahead (or its result is withheld). */
  async function recordOrRefuse(entry: Omit<CssAuditRecord, "osUser">): Promise<void> {
    const log = getAudit();
    if (!log) return;
    await log.append({ ...entry, osUser: osUser() });
  }

  const prodWritesEnabled = () => process.env.CSS_ALLOW_PROD_WRITES === "true";
  const detailOf = (text: string) => text.replace(/`/g, "").slice(0, MAX_AUDIT_DETAIL);

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
        const banner = prodWritesEnabled() ? "_Prod writes are ENABLED (CSS_ALLOW_PROD_WRITES=true) for this server._\n\n" : "";
        if (!rows.length) return ok(`${banner}_No integrations are owned by this API account's team._`);
        const lines = rows.map(
          (i) =>
            `- **${clean(i.projectName)}** — id \`${clean(i.id)}\` — ${clean(i.authType) || "?"} — envs: ${(i.environments ?? []).map(clean).join(", ") || "none"} — ${clean(i.status) || "?"}`,
        );
        return ok(`${banner}**${rows.length} integration(s)**\n\n${lines.join("\n")}`);
      } catch (e) {
        return fail("Error listing integrations", e);
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
      } catch (e) {
        return fail("Error listing roles", e);
      }
    },
  );

  server.tool(
    "list_role_users",
    "List the users holding one role on one integration environment. Walks CSS's pages up to `limit` rows and says so when more may exist.",
    { integrationId, environment, roleName, limit },
    { readOnlyHint: true },
    async ({ integrationId, environment, roleName, limit }) => {
      try {
        const { users, more } = await getClient().listRoleUsers(integrationId, environment, roleName, limit);
        if (!users.length) return ok(`_No users hold \`${roleName}\` on ${integrationId} (${environment})._`);
        const head = `**${users.length} user(s)${more ? " (more may exist)" : ""}** hold \`${roleName}\``;
        const tail = more
          ? `\n\n_Stopped at ${users.length} rows; more holders may exist. Raise \`limit\` (max ${MAX_LIMIT}) to see them._`
          : "";
        return ok(`${head}\n\n${users.map(fmtUser).join("\n")}${tail}`);
      } catch (e) {
        return fail("Error listing role users", e);
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
      } catch (e) {
        return fail("Error listing user roles", e);
      }
    },
  );

  server.tool(
    "search_idir_users",
    "Search the IDIR (Azure AD) directory to find a person's federated username (<guid>@azureidir). " +
      "Provide at least one of firstName, lastName, email or guid; prefer email or guid so exactly one row matches. Searches are audited.",
    {
      environment: environment.default("prod"),
      firstName: nameFilter("First name"),
      lastName: nameFilter("Last name"),
      email: z.string().trim().min(3).max(100).optional().describe("Email address"),
      guid: z.string().trim().regex(/^[0-9a-f]{32}$/i).optional().describe("IDIR GUID (32 hex characters)"),
      limit: searchLimit,
    },
    { readOnlyHint: true },
    async ({ environment, firstName, lastName, email, guid, limit }) => {
      const criteria = Object.entries({ firstName, lastName, email, guid })
        .filter(([, v]) => v)
        .map(([k]) => k);
      let rows: CssUser[];
      try {
        rows = await getClient().searchIdirUsers(environment, { firstName, lastName, email, guid });
      } catch (e) {
        return fail("Error searching IDIR users", e, await record({ tool: "search_idir_users", environment, criteria, outcome: "failed", detail: auditDetail(e) }));
      }
      // Directory rows are personal information: no audit line, no rows.
      try {
        await recordOrRefuse({ tool: "search_idir_users", environment, criteria, results: rows.length, outcome: "searched" });
      } catch (e) {
        return fail("Error searching IDIR users: results withheld because the audit log could not be written", e);
      }
      if (!rows.length) return ok("_No matching IDIR users._");
      const hint = rows.length > 1 && pi.isEnabled() ? SCRUBBED_SEARCH_HINT : "";
      return ok(`**${rows.length} match(es)**\n\n${capped(rows, limit, fmtUser)}${hint}`);
    },
  );

  // -------------------------------------------------------------------------
  // Write tools
  // -------------------------------------------------------------------------
  server.tool(
    "create_role",
    "Create a client role on one integration environment. Confirm with the user before invoking; requires confirm=true.",
    { integrationId, environment, roleName, confirm: confirmFlag },
    { readOnlyHint: false, destructiveHint: false },
    async ({ integrationId, environment, roleName, confirm }) => {
      const prefix = "Error creating role";
      const entry = { tool: "create_role", attemptId: randomUUID(), integrationId, environment, roleNames: [roleName] };
      try {
        requireConfirmation(confirm, "create_role");
        assertWriteAllowed(environment);
      } catch (e) {
        return fail(prefix, e, await record({ ...entry, outcome: "refused", detail: auditDetail(e) }));
      }

      // Before-state, so an errored call can be judged by what changed. Best effort: a failed read must not block the write.
      const roleExists = async () => (await getClient().listRoles(integrationId, environment)).some((r) => r.name === roleName);
      let before: boolean | null = null;
      try {
        before = await roleExists();
      } catch {
        before = null;
      }

      try {
        await recordOrRefuse({ ...entry, outcome: "attempted" });
      } catch (e) {
        return fail(`${prefix}: refused because the audit log could not be written`, e);
      }

      const where = `on integration ${integrationId} (${environment})`;
      let role: CssRole | null = null;
      let callError: unknown = null;
      try {
        role = await getClient().createRole(integrationId, environment, roleName);
      } catch (e) {
        callError = e;
      }
      if (role) {
        const note = await record({ ...entry, outcome: "applied" });
        return ok(`Created role \`${clean(role.name)}\` ${where}.${note}`);
      }

      // The call errored. A timeout or an unreadable body can arrive after CSS created the
      // role, so what CSS holds now, compared with before, decides the record, not the error.
      const why = auditDetail(callError);
      let after: boolean;
      try {
        after = await roleExists();
      } catch (e) {
        const note = await record({ ...entry, outcome: "unverified", detail: detailOf(`CSS call errored: ${why}; read-back failed: ${auditDetail(e)}`) });
        return err(
          `${prefix}: ${safeErr(callError)}. The read-back also failed (${safeErr(e)}), so it is unknown whether CSS created the role. ` +
            `Run list_roles to verify.${note}`,
        );
      }
      if (!after) {
        return fail(prefix, callError, await record({ ...entry, outcome: "failed", detail: detailOf(why) }));
      }
      if (before === null) {
        const note = await record({ ...entry, outcome: "unverified", detail: detailOf(`CSS call errored: ${why}; before-state unavailable; role exists now`) });
        return err(
          `${prefix}: ${safeErr(callError)}. The role exists now, but the before-state could not be read, ` +
            `so it is unknown whether this call created it.${note}`,
        );
      }
      if (before) {
        const note = await record({ ...entry, outcome: "failed", detail: detailOf(`${why}; role existed before`) });
        return fail(prefix, callError, ` The role existed before this call.${note}`);
      }
      const note = await record({ ...entry, outcome: "applied", detail: detailOf(`CSS call errored (${why}) but the read-back shows the role exists now`) });
      return ok(
        `Created role \`${clean(roleName)}\` ${where}. _The CSS call reported an error (${safeErr(callError)}), ` +
          `but the read-back shows the role exists now._${note}`,
      );
    },
  );

  /**
   * Shared pipeline for the two user-role writes: gate → before-state →
   * write-ahead audit → CSS call → read-back → outcome audit. The read-back
   * runs even when the CSS call errored, because a timeout or proxy error can
   * arrive after CSS applied the change; what CSS holds afterwards decides the
   * outcome, never the shape of the error.
   */
  async function userRoleWrite(
    w: {
      tool: "assign_user_roles" | "remove_user_role";
      integrationId: number;
      environment: CssEnvironment;
      username: string;
      roleNames: string[];
      confirm: string;
    },
    perform: (c: CssClient) => Promise<void>,
    verify: (after: Set<string>) => string[],
    done: string,
  ) {
    const assigning = w.tool === "assign_user_roles";
    const prefix = assigning ? "Error assigning roles" : "Error removing role";
    const entry = {
      tool: w.tool,
      attemptId: randomUUID(),
      integrationId: w.integrationId,
      environment: w.environment,
      username: w.username,
      roleNames: w.roleNames,
    };
    const target = `\`${w.username}\` on integration ${w.integrationId} (${w.environment})`;

    try {
      requireTargetConfirmation(
        w.confirm,
        { verb: assigning ? "assign" : "remove", integrationId: w.integrationId, environment: w.environment, username: w.username, roleNames: w.roleNames },
        w.tool,
      );
      assertWriteAllowed(w.environment);
    } catch (e) {
      return fail(prefix, e, await record({ ...entry, outcome: "refused", detail: auditDetail(e) }));
    }

    // Before-state, so roles CSS drops as a side effect are noticed. Best effort: a failed read here must not block the write.
    let before: Set<string> | null = null;
    try {
      before = new Set(roleNamesOf(await getClient().listUserRoles(w.integrationId, w.environment, w.username)));
    } catch {
      before = null;
    }
    const beforeNote = before === null ? BEFORE_STATE_NOTE : "";
    const beforeDetail = before === null ? "before-state unavailable; dropped-role check skipped" : "";

    try {
      await recordOrRefuse({ ...entry, outcome: "attempted" });
    } catch (e) {
      return fail(`${prefix}: refused because the audit log could not be written`, e);
    }

    let callError: unknown = null;
    try {
      await perform(getClient());
    } catch (e) {
      callError = e;
    }

    // Read back. Anything that goes wrong from here is "unverified", never "applied".
    let after: Set<string>;
    try {
      after = new Set(roleNamesOf(await getClient().listUserRoles(w.integrationId, w.environment, w.username)));
    } catch (e) {
      const why = [callError ? `CSS call errored: ${auditDetail(callError)}` : "", `read-back failed: ${auditDetail(e)}`]
        .filter(Boolean)
        .join("; ");
      const note = await record({ ...entry, outcome: "unverified", detail: detailOf(why) });
      const lead = callError
        ? `${prefix}: ${safeErr(callError)}. The read-back also failed (${safeErr(e)}), so it is unknown whether CSS applied the change.`
        : `${assigning ? "Assign" : "Remove"} request for ${target} was accepted, but the read-back failed: ${safeErr(e)}.`;
      return err(`${lead} Run list_user_roles to verify.${note}`);
    }

    const holdsLine = `Now holds: ${after.size ? codeList(after) : "nothing"}.`;
    const problems = verify(after);
    const dropped = before ? [...before].filter((n) => !after.has(n) && !w.roleNames.includes(n)) : [];
    if (dropped.length) problems.push(`DROPPED (held before, gone now): ${codeList(dropped)}`);

    if (callError && problems.length) {
      // The call failed and the read-back does not show what was asked. What CSS
      // holds now, compared with before, decides the record: unknown before-state
      // means we cannot tell, a changed state is a partial write, an unchanged
      // state is a plain failure.
      const why = auditDetail(callError);
      if (before === null) {
        const note = await record({ ...entry, outcome: "unverified", detail: detailOf(`CSS call errored: ${why}; ${beforeDetail}; ${problems.join("; ")}`) });
        return err(
          `${prefix}: ${safeErr(callError)}. The read-back does not show the change, and the before-state could not be read, ` +
            `so it is unknown whether CSS changed anything. ${problems.join(". ")}. ${holdsLine}${note}`,
        );
      }
      const changed = before.size !== after.size || [...before].some((n) => !after.has(n)) || [...after].some((n) => !before.has(n));
      if (changed) {
        const note = await record({ ...entry, outcome: "partial", detail: detailOf(`CSS call errored: ${why}; ${problems.join("; ")}`) });
        return err(`${prefix}: ${safeErr(callError)}, yet CSS's state changed. ${problems.join(". ")}. ${holdsLine}${note}`);
      }
      const note = await record({ ...entry, outcome: "failed", detail: detailOf(why) });
      return fail(prefix, callError, ` ${holdsLine}${note}`);
    }
    if (problems.length) {
      const note = await record({ ...entry, outcome: "partial", detail: detailOf([problems.join("; "), beforeDetail].filter(Boolean).join("; ")) });
      return err(`CSS accepted the request for ${target}, but the result differs from what was asked. ${problems.join(". ")}. ${holdsLine}${beforeNote}${note}`);
    }
    const applied = callError
      ? `CSS call errored (${auditDetail(callError)}) but the read-back shows the change applied`
      : "";
    const note = await record({ ...entry, outcome: "applied", ...(applied || beforeDetail ? { detail: detailOf([applied, beforeDetail].filter(Boolean).join("; ")) } : {}) });
    const errorNote = callError ? ` _The CSS call reported an error (${safeErr(callError)}), but the read-back shows the change applied._` : "";
    return ok(`${done} ${target}. ${holdsLine}${errorNote}${beforeNote}${note}`);
  }

  server.tool(
    "assign_user_roles",
    "Assign one or more roles to a user on one integration environment, then re-read and report what the user holds. " +
      "Works before the user's first login (CSS verifies the username with the IdP); only azureidir and bceidbusiness " +
      'usernames are accepted. Requires confirm="assign:<integrationId>/<environment>/<username>/<roles, comma-separated>" — this grants application access.',
    {
      integrationId,
      environment,
      username,
      roleNames: z.array(roleName).min(1).max(20).describe("Roles to assign"),
      confirm: confirmTarget,
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ integrationId, environment, username, roleNames, confirm }) =>
      userRoleWrite(
        { tool: "assign_user_roles", integrationId, environment, username, roleNames, confirm },
        (c) => c.assignUserRoles(integrationId, environment, username, roleNames),
        (after) => {
          const missing = roleNames.filter((r) => !after.has(r));
          return missing.length ? [`NOT applied: ${codeList(missing)}`] : [];
        },
        `Assigned ${codeList(roleNames)} to`,
      ),
  );

  server.tool(
    "remove_user_role",
    "Remove one role from a user on one integration environment, then re-read and report what the user holds. " +
      'The role itself stays defined. Requires confirm="remove:<integrationId>/<environment>/<username>/<roleName>" — this revokes application access.',
    { integrationId, environment, username, roleName, confirm: confirmTarget },
    { readOnlyHint: false, destructiveHint: true },
    async ({ integrationId, environment, username, roleName, confirm }) =>
      userRoleWrite(
        { tool: "remove_user_role", integrationId, environment, username, roleNames: [roleName], confirm },
        (c) => c.removeUserRole(integrationId, environment, username, roleName),
        (after) => (after.has(roleName) ? [`still holds \`${clean(roleName)}\``] : []),
        `Removed \`${clean(roleName)}\` from`,
      ),
  );

  return server;
}
