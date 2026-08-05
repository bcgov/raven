import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PiScrubber } from "@nrs/auth";
import {
  GitHubClient,
  GitHubApiError,
  checkAllowList,
  checkOrgAllowList,
  validateOwnerRepo,
  normalizeApiBaseUrl,
  findingsToSarif,
  encodeSarif,
  validateSarif,
  computeFingerprint,
} from "./github-client.js";
import type { SarifLog, CanonicalFinding } from "./types.js";

// ---------------------------------------------------------------------------
// PI scrubber — anonymise any personal data before returning to the LLM
// ---------------------------------------------------------------------------
const pi = new PiScrubber();

/** Formats an error safely: redacts token, scrubs PI. */
function safeErr(err: unknown, token?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (token) msg = msg.split(token).join("[REDACTED]");
  return pi.scrubText(msg);
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getToken(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) {
    throw new Error(
      "GITHUB_TOKEN is not set. Configure it in ~/.raven/.env or via scripts/setup-credentials.ps1.",
    );
  }
  return t;
}

function getApiBase(): string {
  return normalizeApiBaseUrl(process.env.GITHUB_API_URL ?? "https://api.github.com");
}

function getTimeoutMs(): number {
  const raw = process.env.GITHUB_TIMEOUT_MS;
  if (!raw) return 30_000;
  const n = parseInt(raw, 10);
  return isFinite(n) && n > 0 ? n : 30_000;
}

/** True if GitHub agentic autofix is enabled via config. */
function isAutofixEnabled(): boolean {
  return process.env.GITHUB_ENABLE_AUTOFIX === "true";
}

/** True if PR merge is enabled via config. */
function isMergeEnabled(): boolean {
  return process.env.GITHUB_ENABLE_MERGE === "true";
}

/**
 * For multi-source security summaries: 403/404 means the security product is
 * not enabled (or not visible to this token) for the repo — report that
 * explicitly as unavailable. Anything else (rate limit, auth, 5xx) rethrows:
 * a real failure must never masquerade as "0 alerts" in a security summary.
 */
async function alertsOrUnavailable<T>(p: Promise<T[]>): Promise<T[] | "n/a"> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 403 || err.status === 404)) {
      return "n/a";
    }
    throw err;
  }
}

/** Throws when a mutating operation hasn't been explicitly confirmed. */
function requireConfirmation(confirm: boolean, operation: string): void {
  if (!confirm) {
    throw new Error(
      `"${operation}" requires explicit confirmation. Pass confirm=true to proceed. ` +
        "Review the operation carefully before confirming.",
    );
  }
}

// Lazy singleton client — recreated if token or base changes between calls
// (not expected in normal use; handles test teardown cleanly).
let _client: GitHubClient | null = null;
let _clientToken: string | null = null;
let _clientBase: string | null = null;

function getClient(): GitHubClient {
  const token = getToken();
  const base = getApiBase();
  if (!_client || _clientToken !== token || _clientBase !== base) {
    _client = new GitHubClient(base, token, { timeoutMs: getTimeoutMs() });
    _clientToken = token;
    _clientBase = base;
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const ownerRepoSchema = {
  owner: z.string().min(1).describe("Repository owner (user or org)"),
  repo: z.string().min(1).describe("Repository name"),
};

const paginationSchema = {
  page: z.number().int().min(1).default(1),
  per_page: z.number().int().min(1).max(100).default(30),
};

const confirmSchema = {
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to execute this mutating operation. Set to true only after reviewing the inputs.",
    ),
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtAlert(a: {
  number: number;
  state: string;
  rule?: { id: string; name: string; severity?: string | null };
  tool?: { name: string };
  most_recent_instance?: { location?: { path: string; start_line: number } | null };
  html_url: string;
  created_at: string;
  dismissed_reason?: string | null;
}): string {
  const loc = a.most_recent_instance?.location;
  const locStr = loc ? ` @ ${loc.path}:${loc.start_line}` : "";
  const rule = a.rule;
  const dismissed = a.dismissed_reason ? ` [${a.dismissed_reason}]` : "";
  return (
    `- **#${a.number}** [${a.state}${dismissed}] ${rule?.id ?? "?"} — ${rule?.name ?? "?"}` +
    ` (${rule?.severity ?? "?"}) ${locStr} | ${a.html_url}`
  );
}

function fmtSecretAlert(a: {
  number: number;
  state: string;
  secret_type: string;
  secret_type_display_name?: string;
  resolution?: string | null;
  html_url: string;
  created_at: string;
}): string {
  const typeLabel = a.secret_type_display_name ?? a.secret_type;
  const res = a.resolution ? ` [${a.resolution}]` : "";
  return `- **#${a.number}** [${a.state}${res}] ${typeLabel} | ${a.html_url}`;
}

function fmtDependabotAlert(a: {
  number: number;
  state: string;
  dependency: { package: { ecosystem: string; name: string } };
  security_advisory: { severity: string; summary: string };
  html_url: string;
}): string {
  const pkg = `${a.dependency.package.ecosystem}:${a.dependency.package.name}`;
  return (
    `- **#${a.number}** [${a.state}] [${a.security_advisory.severity}] ` +
    `${pkg} — ${a.security_advisory.summary.slice(0, 100)} | ${a.html_url}`
  );
}

function fmtIssue(i: {
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at: string;
  labels?: Array<{ name: string }>;
}): string {
  const labels = i.labels?.map((l) => l.name).join(", ");
  const labelStr = labels ? ` [${labels}]` : "";
  return `- **#${i.number}** [${i.state}]${labelStr} ${i.title} | ${i.html_url}`;
}

function fmtPr(pr: {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
}): string {
  const draftStr = pr.draft ? " (draft)" : "";
  return `- **#${pr.number}** [${pr.state}${draftStr}] ${pr.title} | ${pr.html_url}`;
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

export function createGitHubServer(): McpServer {
  const server = new McpServer(
    { name: "RAVEN GitHub", version: "0.1.0" },
    {
      instructions:
        "GitHub tools for RAVEN. Covers GHAS code scanning, secret scanning, Dependabot alerts, " +
        "issues, pull requests, repository security configuration, and org-level security summaries. " +
        "Mutating operations require confirm=true. PR merge also requires GITHUB_ENABLE_MERGE=true. " +
        "Autofix tools require GITHUB_ENABLE_AUTOFIX=true. " +
        "Use GITHUB_REPOSITORY_ALLOWLIST to restrict which repositories can be targeted.",
    },
  );

  // =========================================================================
  // Foundation
  // =========================================================================

  server.tool(
    "github_health",
    "Check GitHub API connectivity. Returns authenticated user, rate limit status, " +
      "and current configuration (API base, allow-list, feature flags). " +
      "Use this to verify GITHUB_TOKEN is configured correctly before running other tools.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const c = getClient();
        const [user, rate] = await Promise.all([
          c.getAuthenticatedUser(),
          c.getRateLimit(),
        ]);
        const lines = [
          `**GitHub API: Connected**`,
          `- Authenticated as: ${user.login}${user.name ? ` (${user.name})` : ""}`,
          `- API base: ${getApiBase()}`,
          `- Rate limit: ${rate.rate.remaining}/${rate.rate.limit} requests remaining`,
          `- Rate reset: ${new Date(rate.rate.reset * 1000).toISOString()}`,
          `- Allow-list: ${process.env.GITHUB_REPOSITORY_ALLOWLIST ?? "(not configured — all repository operations are blocked)"}`,
          `- Autofix enabled: ${isAutofixEnabled()}`,
          `- PR merge enabled: ${isMergeEnabled()}`,
        ];
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "github_config",
    "Returns the current GitHub MCP server configuration without exposing credentials. " +
      "Shows API base URL, allow-list, feature flags, and timeout settings.",
    {},
    { readOnlyHint: true },
    async () => {
      const lines = [
        `**GitHub MCP Configuration**`,
        `- API base: ${getApiBase()}`,
        `- Token configured: ${Boolean(process.env.GITHUB_TOKEN)}`,
        `- Allow-list: ${process.env.GITHUB_REPOSITORY_ALLOWLIST ?? "(required; not configured)"}`,
        `- Autofix enabled: ${isAutofixEnabled()}`,
        `- PR merge enabled: ${isMergeEnabled()}`,
        `- Timeout: ${getTimeoutMs()}ms`,
      ];
      return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
    },
  );

  // =========================================================================
  // Domain A: GHAS Code Scanning — SARIF upload
  // =========================================================================

  server.tool(
    "security_publish_sarif",
    "Upload security findings to GitHub code scanning as a SARIF 2.1.0 report. " +
      "Accepts either a pre-built SARIF string (sarif_json) or an array of canonical findings " +
      "(findings) that the server converts to SARIF. " +
      "Findings are gzip-compressed and base64-encoded before upload. " +
      "Returns the upload ID for status polling with security_get_sarif_upload_status. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      commit_sha: z.string().describe("Commit SHA the SARIF is associated with"),
      ref: z
        .string()
        .describe("Git ref (e.g. refs/heads/main) the SARIF is associated with"),
      sarif_json: z
        .string()
        .optional()
        .describe("Pre-built SARIF 2.1.0 document as a JSON string"),
      findings: z
        .array(
          z.object({
            finding_id: z.string(),
            rule_id: z.string(),
            title: z.string(),
            description: z.string(),
            severity: z.enum(["critical", "high", "medium", "low", "note"]),
            security_severity: z.number().min(0).max(10).optional(),
            confidence: z.enum(["high", "medium", "low"]).optional(),
            precision: z
              .enum(["very-high", "high", "medium", "low"])
              .optional(),
            cwe: z.array(z.string()).optional(),
            owasp: z.array(z.string()).optional(),
            file: z.string(),
            start_line: z.number().int().min(1),
            end_line: z.number().int().min(1).optional(),
            start_column: z.number().int().min(1).optional(),
            end_column: z.number().int().min(1).optional(),
            evidence: z.string().optional(),
            recommendation: z.string().optional(),
            fingerprint_material: z
              .object({
                repo: z.string().optional(),
                file: z.string().optional(),
                rule_id: z.string().optional(),
                start_line_context_hash: z.string().optional(),
              })
              .optional(),
            requires_human_validation: z.boolean().optional(),
          }),
        )
        .optional()
        .describe("Array of canonical findings to convert to SARIF"),
      tool_name: z
        .string()
        .default("RAVEN Agentic Security Review")
        .describe("Tool name recorded in the SARIF run"),
      category: z
        .string()
        .optional()
        .describe("Category for the SARIF upload (for deduplication)"),
      checkout_uri: z
        .string()
        .optional()
        .describe(
          "file:// URI of the workspace root, used as SRCROOT in SARIF",
        ),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({
      owner,
      repo,
      commit_sha,
      ref,
      sarif_json,
      findings,
      tool_name,
      category,
      checkout_uri,
      confirm,
    }) => {
      try {
        requireConfirmation(confirm, "security_publish_sarif");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);

        let sarifLog: SarifLog;

        if (sarif_json) {
          sarifLog = JSON.parse(sarif_json) as SarifLog;
        } else if (findings && findings.length > 0) {
          sarifLog = findingsToSarif(
            findings as CanonicalFinding[],
            tool_name,
            `${owner}/${repo}`,
            checkout_uri,
          );
        } else {
          throw new Error(
            "Either sarif_json or at least one finding must be provided.",
          );
        }

        validateSarif(sarifLog);
        const encoded = await encodeSarif(sarifLog);

        const c = getClient();
        const result = await c.uploadSarif(owner, repo, {
          commit_sha,
          ref,
          sarif: encoded,
          checkout_uri,
          tool_name,
          category,
        });

        const lines = [
          `**SARIF upload accepted for ${owner}/${repo}**`,
          `- Upload ID: ${result.id}`,
          `- Status URL: ${result.url}`,
          `- Ref: ${ref}`,
          `- Commit: ${commit_sha}`,
          `- Results: ${sarifLog.runs[0]?.results?.length ?? 0} finding(s)`,
          ``,
          `Poll for processing completion with security_get_sarif_upload_status(sarif_id="${result.id}").`,
        ];
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_get_sarif_upload_status",
    "Get the processing status of a SARIF upload. Returns pending, complete, or failed, " +
      "plus any error messages from GitHub's SARIF processor.",
    {
      ...ownerRepoSchema,
      sarif_id: z.string().describe("SARIF upload ID returned by security_publish_sarif"),
    },
    { readOnlyHint: true },
    async ({ owner, repo, sarif_id }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const s = await c.getSarifUploadStatus(owner, repo, sarif_id);
        const lines = [
          `**SARIF upload ${sarif_id}**`,
          `- Status: **${s.processing_status}**`,
          s.analyses_url ? `- Analyses URL: ${s.analyses_url}` : "",
          s.errors?.length
            ? `- Errors:\n${s.errors.map((e) => `  - ${e}`).join("\n")}`
            : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain A: Code Scanning Alerts
  // =========================================================================

  server.tool(
    "security_list_code_scanning_alerts",
    "List code scanning alerts for a repository. Filter by state, severity, tool name, or ref. " +
      "Returns alert number, state, rule, severity, location, and HTML URL.",
    {
      ...ownerRepoSchema,
      state: z
        .enum(["open", "dismissed", "fixed"])
        .optional()
        .describe("Filter by alert state (default: open)"),
      severity: z
        .enum(["critical", "high", "medium", "low", "warning", "note", "error"])
        .optional(),
      tool_name: z
        .string()
        .optional()
        .describe("Filter to alerts from a specific tool (e.g. 'CodeQL')"),
      ref: z
        .string()
        .optional()
        .describe("Git ref to filter alerts (e.g. refs/heads/main)"),
      ...paginationSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo, state, severity, tool_name, ref, page, per_page }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const alerts = await c.listCodeScanningAlerts(owner, repo, {
          state: state ?? "open",
          severity,
          tool_name,
          ref,
          page,
          per_page,
        });
        if (!alerts.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No code scanning alerts found for ${owner}/${repo} (state=${state ?? "open"}).`),
              },
            ],
          };
        }
        const body =
          `**${alerts.length} code scanning alert(s) for ${owner}/${repo}**\n\n` +
          alerts.map(fmtAlert).join("\n");
        return { content: [{ type: "text", text: pi.scrubText(body) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_get_code_scanning_alert",
    "Get full details for a single code scanning alert including rule description, " +
      "location, dismissal info, and most recent instance.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
    },
    { readOnlyHint: true },
    async ({ owner, repo, alert_number }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const a = await c.getCodeScanningAlert(owner, repo, alert_number);
        const loc = a.most_recent_instance?.location;
        const locStr = loc ? `${loc.path}:${loc.start_line}` : "unknown";
        const lines = [
          `**Code Scanning Alert #${a.number} — ${owner}/${repo}**`,
          `- State: **${a.state}**${a.dismissed_reason ? ` (${a.dismissed_reason})` : ""}`,
          `- Rule: ${a.rule.id} — ${a.rule.name}`,
          `- Severity: ${a.rule.severity ?? "?"}${a.rule.security_severity_level ? ` / security: ${a.rule.security_severity_level}` : ""}`,
          `- Tool: ${a.tool.name}${a.tool.version ? ` v${a.tool.version}` : ""}`,
          `- Location: ${locStr}`,
          `- Created: ${a.created_at}`,
          `- Updated: ${a.updated_at}`,
          a.fixed_at ? `- Fixed at: ${a.fixed_at}` : "",
          a.dismissed_at ? `- Dismissed at: ${a.dismissed_at}` : "",
          a.dismissed_comment ? `- Dismissal comment: ${a.dismissed_comment}` : "",
          `- Rule description: ${a.rule.description?.slice(0, 500) ?? "(none)"}`,
          `- URL: ${a.html_url}`,
        ].filter(Boolean);
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_get_code_scanning_alert_instances",
    "Get all currently known instances (locations) of a code scanning alert. " +
      "Use this before attempting a fix to understand every affected location.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
      ref: z.string().optional(),
      ...paginationSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo, alert_number, ref, page, per_page }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const instances = await c.getCodeScanningAlertInstances(
          owner,
          repo,
          alert_number,
          { ref, page, per_page },
        );
        if (!instances.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No instances found for alert #${alert_number} in ${owner}/${repo}.`),
              },
            ],
          };
        }
        const header = `**${instances.length} instance(s) of alert #${alert_number} — ${owner}/${repo}**\n\n`;
        const rows = instances.map((inst, i) => {
          const loc = inst.location;
          return (
            `${i + 1}. [${inst.state}] ` +
            (loc ? `${loc.path}:${loc.start_line}` : "unknown") +
            (inst.ref ? ` (ref: ${inst.ref})` : "")
          );
        });
        return { content: [{ type: "text", text: pi.scrubText(header + rows.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_update_code_scanning_alert",
    "Dismiss or reopen a code scanning alert. " +
      "Dismissal requires a reason and a human-review comment. " +
      "Do NOT dismiss alerts autonomously — this operation records a policy decision. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
      state: z.enum(["open", "dismissed"]),
      dismissed_reason: z
        .enum([
          "false positive",
          "won't fix",
          "used in tests",
        ])
        .optional()
        .describe("Required when state='dismissed'"),
      dismissed_comment: z
        .string()
        .max(1000)
        .optional()
        .describe("Required when dismissing: human-review rationale"),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({
      owner,
      repo,
      alert_number,
      state,
      dismissed_reason,
      dismissed_comment,
      confirm,
    }) => {
      try {
        requireConfirmation(confirm, "security_update_code_scanning_alert");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);

        if (state === "dismissed" && !dismissed_reason) {
          throw new Error(
            "dismissed_reason is required when dismissing a code scanning alert.",
          );
        }
        if (state === "dismissed" && !dismissed_comment) {
          throw new Error(
            "dismissed_comment is required. Provide a human-review rationale.",
          );
        }

        const c = getClient();
        const a = await c.updateCodeScanningAlert(owner, repo, alert_number, {
          state,
          dismissed_reason,
          dismissed_comment,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Alert #${a.number} updated** — state: ${a.state}` +
                (a.dismissed_reason ? ` (${a.dismissed_reason})` : "") +
                `\n${a.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain B: Autofix (guarded by GITHUB_ENABLE_AUTOFIX)
  // =========================================================================

  server.tool(
    "security_create_code_scanning_autofix",
    "Request a GitHub-generated autofix suggestion for a code scanning alert. " +
      "Requires GITHUB_ENABLE_AUTOFIX=true and confirm=true. " +
      "Poll the result with security_get_code_scanning_autofix_status.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, alert_number, confirm }) => {
      try {
        if (!isAutofixEnabled()) {
          throw new Error(
            "Autofix tools are disabled. Set GITHUB_ENABLE_AUTOFIX=true to enable them.",
          );
        }
        requireConfirmation(confirm, "security_create_code_scanning_autofix");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);

        const c = getClient();
        const result = await c.createAutofix(owner, repo, alert_number);
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Autofix requested for alert #${alert_number} in ${owner}/${repo}**\n` +
                `- Status: ${result.status}\n` +
                (result.description ? `- Description: ${result.description}\n` : "") +
                `Poll with security_get_code_scanning_autofix_status.`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_get_code_scanning_autofix_status",
    "Get the status and proposed changes for a GitHub-generated autofix. " +
      "Requires GITHUB_ENABLE_AUTOFIX=true.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
    },
    { readOnlyHint: true },
    async ({ owner, repo, alert_number }) => {
      try {
        if (!isAutofixEnabled()) {
          throw new Error(
            "Autofix tools are disabled. Set GITHUB_ENABLE_AUTOFIX=true to enable them.",
          );
        }
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const a = await c.getAutofixStatus(owner, repo, alert_number);
        const lines = [
          `**Autofix status for alert #${alert_number} — ${owner}/${repo}**`,
          `- Status: **${a.status}**`,
          a.description ? `- Description: ${a.description}` : "",
          a.start_time ? `- Started: ${a.start_time}` : "",
          a.completion_time ? `- Completed: ${a.completion_time}` : "",
          a.changes?.length
            ? `- Proposed changes:\n${a.changes.map((ch) => `  - ${ch.path} (+${ch.additions}/-${ch.deletions})`).join("\n")}`
            : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_commit_code_scanning_autofix",
    "Commit a GitHub-generated autofix to a target branch. " +
      "Requires GITHUB_ENABLE_AUTOFIX=true and confirm=true. " +
      "Review the autofix changes with security_get_code_scanning_autofix_status before committing.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
      target_branch: z.string().describe("Branch to commit the autofix into"),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, alert_number, target_branch, confirm }) => {
      try {
        if (!isAutofixEnabled()) {
          throw new Error(
            "Autofix tools are disabled. Set GITHUB_ENABLE_AUTOFIX=true to enable them.",
          );
        }
        requireConfirmation(confirm, "security_commit_code_scanning_autofix");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const result = await c.commitAutofix(owner, repo, alert_number, target_branch);
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Autofix committed for alert #${alert_number} → ${target_branch}**\n` +
                (result.commit_url ? `- Commit: ${result.commit_url}\n` : "") +
                (result.message ? `- Message: ${result.message}` : ""),
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain C: Secret Scanning
  // =========================================================================

  server.tool(
    "security_list_secret_scanning_alerts",
    "List secret scanning alerts for a repository. " +
      "Secret values are never returned — only metadata (type, state, resolution).",
    {
      ...ownerRepoSchema,
      state: z.enum(["open", "resolved"]).optional(),
      resolution: z
        .string()
        .optional()
        .describe("Filter by resolution: revoked, false_positive, used_in_tests, won_t_fix, pattern_deleted, pattern_edited"),
      ...paginationSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo, state, resolution, page, per_page }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const alerts = await c.listSecretScanningAlerts(owner, repo, {
          state,
          resolution,
          page,
          per_page,
        });
        if (!alerts.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No secret scanning alerts found for ${owner}/${repo}.`),
              },
            ],
          };
        }
        const body =
          `**${alerts.length} secret scanning alert(s) for ${owner}/${repo}**\n\n` +
          alerts.map(fmtSecretAlert).join("\n");
        return { content: [{ type: "text", text: pi.scrubText(body) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_get_secret_scanning_alert",
    "Get metadata for a single secret scanning alert. " +
      "The secret value is never returned. " +
      "Returns alert number, type, state, resolution, and timestamps.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
    },
    { readOnlyHint: true },
    async ({ owner, repo, alert_number }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const a = await c.getSecretScanningAlert(owner, repo, alert_number);
        const lines = [
          `**Secret Scanning Alert #${a.number} — ${owner}/${repo}**`,
          `- Type: ${a.secret_type_display_name ?? a.secret_type}`,
          `- State: **${a.state}**`,
          a.resolution ? `- Resolution: ${a.resolution}` : "",
          a.resolution_comment ? `- Comment: ${a.resolution_comment}` : "",
          a.resolved_at ? `- Resolved: ${a.resolved_at}` : "",
          a.resolved_by ? `- Resolved by: ${a.resolved_by.login}` : "",
          `- Created: ${a.created_at}`,
          `- URL: ${a.html_url}`,
          ``,
          `_Note: The secret value is not returned._`,
        ].filter(Boolean);
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_update_secret_scanning_alert",
    "Resolve or reopen a secret scanning alert. " +
      "Common resolutions: revoked, false_positive, used_in_tests, won_t_fix. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
      state: z.enum(["open", "resolved"]),
      resolution: z
        .string()
        .optional()
        .describe("Required when state='resolved'"),
      resolution_comment: z
        .string()
        .max(1000)
        .optional()
        .describe("Optional comment explaining the resolution"),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, alert_number, state, resolution, resolution_comment, confirm }) => {
      try {
        requireConfirmation(confirm, "security_update_secret_scanning_alert");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        if (state === "resolved" && !resolution) {
          throw new Error("resolution is required when state='resolved'.");
        }
        const c = getClient();
        const a = await c.updateSecretScanningAlert(owner, repo, alert_number, {
          state,
          resolution,
          resolution_comment,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Secret scanning alert #${a.number} updated** — state: ${a.state}` +
                (a.resolution ? ` (${a.resolution})` : "") +
                `\n${a.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain D: Dependabot Alerts
  // =========================================================================

  server.tool(
    "security_list_dependabot_alerts",
    "List Dependabot alerts for a repository. Filter by state, severity, ecosystem, or package.",
    {
      ...ownerRepoSchema,
      state: z.enum(["open", "dismissed", "fixed", "auto_dismissed"]).optional(),
      severity: z.enum(["low", "medium", "high", "critical"]).optional(),
      ecosystem: z.string().optional().describe("e.g. npm, pip, maven"),
      package: z.string().optional(),
      // No page input: this endpoint is cursor-paginated and rejects `page`.
      per_page: z.number().int().min(1).max(100).default(30),
    },
    { readOnlyHint: true },
    async ({ owner, repo, state, severity, ecosystem, package: pkg, per_page }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const alerts = await c.listDependabotAlerts(owner, repo, {
          state,
          severity,
          ecosystem,
          package: pkg,
          per_page,
        });
        if (!alerts.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No Dependabot alerts found for ${owner}/${repo}.`),
              },
            ],
          };
        }
        const body =
          `**${alerts.length} Dependabot alert(s) for ${owner}/${repo}**\n\n` +
          alerts.map(fmtDependabotAlert).join("\n");
        return { content: [{ type: "text", text: pi.scrubText(body) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_get_dependabot_alert",
    "Get full details for a single Dependabot alert including advisory, CVSS, " +
      "vulnerable version range, and first patched version.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
    },
    { readOnlyHint: true },
    async ({ owner, repo, alert_number }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const a = await c.getDependabotAlert(owner, repo, alert_number);
        const adv = a.security_advisory;
        const vuln = a.security_vulnerability;
        const pkg = a.dependency.package;
        const lines = [
          `**Dependabot Alert #${a.number} — ${owner}/${repo}**`,
          `- State: **${a.state}**`,
          `- Package: ${pkg.ecosystem}:${pkg.name}`,
          `- Manifest: ${a.dependency.manifest_path}`,
          `- Advisory: ${adv.ghsa_id} — ${adv.summary}`,
          `- Severity: **${adv.severity}**${adv.cvss ? ` (CVSS ${adv.cvss.score})` : ""}`,
          adv.cwe_ids?.length ? `- CWEs: ${adv.cwe_ids.join(", ")}` : "",
          `- Vulnerable range: ${vuln.vulnerable_version_range}`,
          vuln.first_patched_version
            ? `- First patched: ${vuln.first_patched_version.identifier}`
            : "- No patched version available yet",
          `- Created: ${a.created_at}`,
          a.dismissed_at ? `- Dismissed: ${a.dismissed_at} (${a.dismissed_reason ?? "?"})` : "",
          a.dismissed_comment ? `- Dismissal comment: ${a.dismissed_comment}` : "",
          `- URL: ${a.html_url}`,
        ].filter(Boolean);
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "security_update_dependabot_alert",
    "Dismiss a Dependabot alert with a reason and optional comment. " +
      "Valid dismissed_reason values: fix_started, inaccurate, no_bandwidth, not_used, tolerable_risk. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      alert_number: z.number().int().min(1),
      state: z.enum(["dismissed", "open"]),
      dismissed_reason: z
        .enum(["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"])
        .optional(),
      dismissed_comment: z.string().max(1000).optional(),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, alert_number, state, dismissed_reason, dismissed_comment, confirm }) => {
      try {
        requireConfirmation(confirm, "security_update_dependabot_alert");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        if (state === "dismissed" && !dismissed_reason) {
          throw new Error("dismissed_reason is required when dismissing a Dependabot alert.");
        }
        const c = getClient();
        const a = await c.updateDependabotAlert(owner, repo, alert_number, {
          state,
          dismissed_reason,
          dismissed_comment,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Dependabot alert #${a.number} updated** — state: ${a.state}` +
                (a.dismissed_reason ? ` (${a.dismissed_reason})` : "") +
                `\n${a.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain E: GitHub Issues
  // =========================================================================

  server.tool(
    "issue_create",
    "Create a GitHub Issue as a remediation ticket. " +
      "For security findings include a summary, source, evidence, impact, remediation, and links section. " +
      "Deduplication markers (<!-- raven:finding-fingerprint=... -->) can be embedded in the body. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      title: z.string().min(1).max(256),
      body: z.string().max(65536).optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      milestone: z.number().int().optional(),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, title, body, labels, assignees, milestone, confirm }) => {
      try {
        requireConfirmation(confirm, "issue_create");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const issue = await c.createIssue(owner, repo, {
          title,
          body,
          labels,
          assignees,
          milestone,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Issue #${issue.number} created: ${issue.title}**\n` +
                `- State: ${issue.state}\n` +
                `- URL: ${issue.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "issue_update",
    "Update an existing GitHub Issue (title, body, state, labels, assignees). Requires confirm=true.",
    {
      ...ownerRepoSchema,
      issue_number: z.number().int().min(1),
      title: z.string().max(256).optional(),
      body: z.string().max(65536).optional(),
      state: z.enum(["open", "closed"]).optional(),
      state_reason: z
        .enum(["completed", "not_planned", "reopened"])
        .optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      milestone: z.number().int().nullable().optional(),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({
      owner,
      repo,
      issue_number,
      title,
      body,
      state,
      state_reason,
      labels,
      assignees,
      milestone,
      confirm,
    }) => {
      try {
        requireConfirmation(confirm, "issue_update");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const issue = await c.updateIssue(owner, repo, issue_number, {
          title,
          body,
          state,
          state_reason,
          labels,
          assignees,
          milestone: milestone ?? undefined,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Issue #${issue.number} updated**\n` +
                `- Title: ${issue.title}\n` +
                `- State: ${issue.state}\n` +
                `- URL: ${issue.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "issue_close",
    "Close a GitHub Issue with an optional closing comment and state reason. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      issue_number: z.number().int().min(1),
      state_reason: z
        .enum(["completed", "not_planned"])
        .default("completed"),
      comment: z
        .string()
        .max(65536)
        .optional()
        .describe("Optional comment added before closing"),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, issue_number, state_reason, comment, confirm }) => {
      try {
        requireConfirmation(confirm, "issue_close");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();

        // Optionally add a comment before closing
        if (comment) {
          await c.addIssueComment(owner, repo, issue_number, comment);
        }

        const issue = await c.updateIssue(owner, repo, issue_number, {
          state: "closed",
          state_reason,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Issue #${issue.number} closed** (${state_reason})\n` +
                `- URL: ${issue.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "issue_search",
    "Search GitHub Issues to detect duplicates before creating new ones. " +
      "Searches are scoped to the specified repository. " +
      "Returns matching issue numbers, titles, states, and URLs.",
    {
      ...ownerRepoSchema,
      query: z
        .string()
        .min(1)
        .describe(
          "GitHub search query (without repo: qualifier — that is added automatically). " +
            "Example: 'RAVEN-SQLI-001 label:security state:open'",
        ),
      ...paginationSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo, query, page, per_page }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const result = await c.searchIssues(owner, repo, query, { page, per_page });
        if (!result.items.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No issues found in ${owner}/${repo} matching: ${query}`),
              },
            ],
          };
        }
        const body =
          `**${result.total_count} issue(s) matching "${query}" in ${owner}/${repo}**\n\n` +
          result.items.map(fmtIssue).join("\n");
        return { content: [{ type: "text", text: pi.scrubText(body) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "issue_add_comment",
    "Add a comment to an existing GitHub Issue. Requires confirm=true.",
    {
      ...ownerRepoSchema,
      issue_number: z.number().int().min(1),
      body: z.string().min(1).max(65536),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, issue_number, body, confirm }) => {
      try {
        requireConfirmation(confirm, "issue_add_comment");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const comment = await c.addIssueComment(owner, repo, issue_number, body);
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Comment added to issue #${issue_number}**\n` +
                `- URL: ${comment.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain F: Pull Requests
  // =========================================================================

  server.tool(
    "pr_create",
    "Create a pull request from an already-pushed branch. " +
      "For security remediation PRs include a summary, security finding, changes made, " +
      "validation performed, risk/rollback, and linked items sections. " +
      "Requires confirm=true.",
    {
      ...ownerRepoSchema,
      head: z.string().describe("Source branch (e.g. raven/fix-alert-123)"),
      base: z.string().describe("Target branch (e.g. main)"),
      title: z.string().min(1).max(256),
      body: z.string().max(65536).optional(),
      draft: z.boolean().default(true),
      maintainer_can_modify: z.boolean().default(true),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({
      owner,
      repo,
      head,
      base,
      title,
      body,
      draft,
      maintainer_can_modify,
      confirm,
    }) => {
      try {
        requireConfirmation(confirm, "pr_create");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const pr = await c.createPullRequest(owner, repo, {
          head,
          base,
          title,
          body,
          draft,
          maintainer_can_modify,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**PR #${pr.number} created: ${pr.title}**\n` +
                `- State: ${pr.state}${pr.draft ? " (draft)" : ""}\n` +
                `- ${pr.head.ref} → ${pr.base.ref}\n` +
                `- URL: ${pr.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "pr_get",
    "Get details for a pull request: state, draft, branches, reviewers, merge status, and diff stats.",
    {
      ...ownerRepoSchema,
      pull_number: z.number().int().min(1),
    },
    { readOnlyHint: true },
    async ({ owner, repo, pull_number }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const pr = await c.getPullRequest(owner, repo, pull_number);
        const reviewers = pr.requested_reviewers?.map((r) => r.login).join(", ") ?? "(none)";
        const lines = [
          `**PR #${pr.number} — ${pr.title}**`,
          `- State: ${pr.state}${pr.draft ? " (draft)" : ""}${pr.merged ? " (merged)" : ""}`,
          `- Branches: ${pr.head.ref} → ${pr.base.ref}`,
          `- Author: ${pr.user?.login ?? "?"}`,
          `- Requested reviewers: ${reviewers}`,
          pr.additions != null ? `- Changes: +${pr.additions}/-${pr.deletions} in ${pr.changed_files} file(s)` : "",
          `- Created: ${pr.created_at}`,
          `- Updated: ${pr.updated_at}`,
          pr.merged_at ? `- Merged: ${pr.merged_at}` : "",
          `- URL: ${pr.html_url}`,
        ].filter(Boolean);
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "pr_update",
    "Update a pull request (title, body, state, draft status). Requires confirm=true.",
    {
      ...ownerRepoSchema,
      pull_number: z.number().int().min(1),
      title: z.string().max(256).optional(),
      body: z.string().max(65536).optional(),
      state: z.enum(["open", "closed"]).optional(),
      draft: z.boolean().optional(),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, pull_number, title, body, state, draft, confirm }) => {
      try {
        requireConfirmation(confirm, "pr_update");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const pr = await c.updatePullRequest(owner, repo, pull_number, {
          title,
          body,
          state,
          draft,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**PR #${pr.number} updated**\n` +
                `- State: ${pr.state}${pr.draft ? " (draft)" : ""}\n` +
                `- URL: ${pr.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "pr_request_review",
    "Request reviews from users or teams on a pull request. Requires confirm=true.",
    {
      ...ownerRepoSchema,
      pull_number: z.number().int().min(1),
      reviewers: z.array(z.string()).default([]),
      team_reviewers: z.array(z.string()).default([]),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, pull_number, reviewers, team_reviewers, confirm }) => {
      try {
        requireConfirmation(confirm, "pr_request_review");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        await c.requestReview(owner, repo, pull_number, reviewers, team_reviewers);
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Review requested on PR #${pull_number}**\n` +
                (reviewers.length ? `- Users: ${reviewers.join(", ")}\n` : "") +
                (team_reviewers.length
                  ? `- Teams: ${team_reviewers.join(", ")}\n`
                  : ""),
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "pr_comment",
    "Add a general (non-review) comment to a pull request. Requires confirm=true.",
    {
      ...ownerRepoSchema,
      pull_number: z.number().int().min(1),
      body: z.string().min(1).max(65536),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({ owner, repo, pull_number, body, confirm }) => {
      try {
        requireConfirmation(confirm, "pr_comment");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const comment = await c.addPullRequestComment(owner, repo, pull_number, body);
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**Comment added to PR #${pull_number}**\n` +
                `- URL: ${comment.html_url}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "pr_merge",
    "Merge a pull request. DISABLED by default — requires both GITHUB_ENABLE_MERGE=true " +
      "AND confirm=true. Most agent workflows should stop at PR creation or review request.",
    {
      ...ownerRepoSchema,
      pull_number: z.number().int().min(1),
      merge_method: z
        .enum(["merge", "squash", "rebase"])
        .default("squash"),
      commit_title: z.string().max(256).optional(),
      commit_message: z.string().max(65536).optional(),
      ...confirmSchema,
    },
    { readOnlyHint: false },
    async ({
      owner,
      repo,
      pull_number,
      merge_method,
      commit_title,
      commit_message,
      confirm,
    }) => {
      try {
        if (!isMergeEnabled()) {
          throw new Error(
            "PR merge is disabled by default. Set GITHUB_ENABLE_MERGE=true to enable it. " +
              "Consult your team policy before enabling autonomous merges.",
          );
        }
        requireConfirmation(confirm, "pr_merge");
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const result = await c.mergePullRequest(owner, repo, pull_number, {
          merge_method,
          commit_title,
          commit_message,
        });
        return {
          content: [
            {
              type: "text",
              text: pi.scrubText(
                `**PR #${pull_number} merged** (${merge_method})\n` +
                `- SHA: ${result.sha}\n` +
                `- Message: ${result.message}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain G: Repository Security Configuration
  // =========================================================================

  server.tool(
    "repo_get_security_configuration",
    "Return the security posture for a repository: GHAS status, secret scanning, " +
      "push protection, Dependabot, default branch, and whether a SECURITY.md is present.",
    {
      ...ownerRepoSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const [repoData, hasSecurityPolicy] = await Promise.all([
          c.getRepository(owner, repo),
          c.checkFileExists(owner, repo, "SECURITY.md"),
        ]);

        const sa = repoData.security_and_analysis;
        const status = (feature: { status?: string } | undefined | null) =>
          feature?.status ?? "unknown";

        const lines = [
          `**Security Configuration — ${owner}/${repo}**`,
          `- Visibility: ${repoData.private ? "private" : "public"}`,
          `- Default branch: ${repoData.default_branch}`,
          `- Advanced Security: ${status(sa?.advanced_security)}`,
          `- Code Scanning (code_security_and_analysis): ${status(sa?.code_security_and_analysis)}`,
          `- Secret Scanning: ${status(sa?.secret_scanning)}`,
          `- Secret Scanning Push Protection: ${status(sa?.secret_scanning_push_protection)}`,
          `- Dependabot Security Updates: ${status(sa?.dependabot_security_updates)}`,
          `- SECURITY.md: ${hasSecurityPolicy ? "present" : "absent"}`,
          `- URL: ${repoData.html_url}`,
        ];
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "repo_get_rulesets",
    "Return rulesets (branch protection rules) for a repository. " +
      "Shows enforcement level and rule types (pull request required, status checks, signing, etc.).",
    {
      ...ownerRepoSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();
        const rulesets = await c.getRulesets(owner, repo);
        if (!rulesets.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No rulesets configured for ${owner}/${repo}.`),
              },
            ],
          };
        }
        const lines = [`**Rulesets for ${owner}/${repo}** (${rulesets.length} ruleset(s))\n`];
        for (const rs of rulesets) {
          lines.push(`**${rs.name}** (ID: ${rs.id}, enforcement: ${rs.enforcement})`);
          if (rs.target) lines.push(`  Target: ${rs.target}`);
          if (Array.isArray(rs.rules) && rs.rules.length) {
            lines.push(
              `  Rules: ${rs.rules.map((r) => r.type).join(", ")}`,
            );
          }
          lines.push("");
        }
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "repo_get_security_summary",
    "Aggregate open security alert counts for a repository across code scanning, " +
      "Dependabot, and secret scanning. Returns a single-page summary with severity breakdowns.",
    {
      ...ownerRepoSchema,
    },
    { readOnlyHint: true },
    async ({ owner, repo }) => {
      try {
        validateOwnerRepo(owner, repo);
        checkAllowList(owner, repo);
        const c = getClient();

        // Fetch summaries in parallel; 403/404 = product not enabled → "n/a",
        // any other failure aborts the summary (no silent zeros).
        const [codeScanningAlerts, dependabotAlerts, secretAlerts] =
          await Promise.all([
            alertsOrUnavailable(
              c.listCodeScanningAlerts(owner, repo, { state: "open", per_page: 100 }),
            ),
            alertsOrUnavailable(
              c.listDependabotAlerts(owner, repo, { state: "open", per_page: 100 }),
            ),
            alertsOrUnavailable(
              c.listSecretScanningAlerts(owner, repo, { state: "open", per_page: 100 }),
            ),
          ]);

        const NA_NOTE = "n/a — not enabled or not visible to this token";

        // Code scanning breakdown by severity
        const csBySeverity: Record<string, number> = {
          critical: 0, high: 0, medium: 0, low: 0, other: 0,
        };
        if (codeScanningAlerts !== "n/a") {
          for (const a of codeScanningAlerts) {
            const sev = a.rule?.severity?.toLowerCase() ?? "other";
            if (sev in csBySeverity) {
              csBySeverity[sev]++;
            } else {
              csBySeverity.other++;
            }
          }
        }

        // Dependabot breakdown
        const depBySeverity: Record<string, number> = {
          critical: 0, high: 0, medium: 0, low: 0,
        };
        if (dependabotAlerts !== "n/a") {
          for (const a of dependabotAlerts) {
            const sev = a.security_advisory?.severity ?? "low";
            depBySeverity[sev] = (depBySeverity[sev] ?? 0) + 1;
          }
        }

        const lines = [
          `**Security Summary — ${owner}/${repo}**`,
          ``,
          codeScanningAlerts === "n/a"
            ? `**Code Scanning** (${NA_NOTE})`
            : `**Code Scanning** (${codeScanningAlerts.length} open alert(s))\n` +
              `  Critical: ${csBySeverity.critical} | High: ${csBySeverity.high} | Medium: ${csBySeverity.medium} | Low: ${csBySeverity.low}`,
          ``,
          dependabotAlerts === "n/a"
            ? `**Dependabot** (${NA_NOTE})`
            : `**Dependabot** (${dependabotAlerts.length} open alert(s))\n` +
              `  Critical: ${depBySeverity.critical} | High: ${depBySeverity.high} | Medium: ${depBySeverity.medium} | Low: ${depBySeverity.low}`,
          ``,
          secretAlerts === "n/a"
            ? `**Secret Scanning** (${NA_NOTE})`
            : `**Secret Scanning** (${secretAlerts.length} open alert(s))\n` +
              (secretAlerts.length
                ? `  Types: ${[...new Set(secretAlerts.map((a) => a.secret_type))].join(", ")}`
                : "  No open alerts."),
        ];
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  // =========================================================================
  // Domain H: Org-level security
  // =========================================================================

  server.tool(
    "org_list_security_alerts",
    "List code scanning alerts across an entire organisation (requires org-level GHAS). " +
      "Filter by state, severity, or tool name.",
    {
      org: z.string().min(1).describe("GitHub organisation login"),
      state: z.enum(["open", "dismissed", "fixed"]).optional(),
      severity: z.enum(["critical", "high", "medium", "low"]).optional(),
      tool_name: z.string().optional(),
      ...paginationSchema,
    },
    { readOnlyHint: true },
    async ({ org, state, severity, tool_name, page, per_page }) => {
      try {
        if (!/^[A-Za-z0-9_.-]+$/.test(org)) {
          throw new Error(`Invalid org: ${JSON.stringify(org)}`);
        }
        checkOrgAllowList(org);
        const c = getClient();
        const alerts = await c.listOrgCodeScanningAlerts(org, {
          state: state ?? "open",
          severity,
          tool_name,
          page,
          per_page,
        });
        if (!alerts.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No code scanning alerts found for org ${org}.`),
              },
            ],
          };
        }
        const body =
          `**${alerts.length} code scanning alert(s) in org ${org}**\n\n` +
          alerts.map(fmtAlert).join("\n");
        return { content: [{ type: "text", text: pi.scrubText(body) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "org_security_summary",
    "Aggregate open security alert counts across a set of repositories in an organisation. " +
      "For each repository fetches code scanning, Dependabot, and secret scanning alert counts. " +
      "Provide a list of repo names, or leave empty to scan the first page of org repos.",
    {
      org: z.string().min(1),
      repositories: z
        .array(z.string())
        .default([])
        .describe(
          "Specific repo names to summarise. Leave empty to use the first 30 repos in the org.",
        ),
      include_code_scanning: z.boolean().default(true),
      include_dependabot: z.boolean().default(true),
      include_secret_scanning: z.boolean().default(true),
    },
    { readOnlyHint: true },
    async ({
      org,
      repositories,
      include_code_scanning,
      include_dependabot,
      include_secret_scanning,
    }) => {
      try {
        if (!/^[A-Za-z0-9_.-]+$/.test(org)) {
          throw new Error(`Invalid org: ${JSON.stringify(org)}`);
        }
        checkOrgAllowList(org);
        const c = getClient();

        let repoNames = repositories;
        if (!repoNames.length) {
          const repos = await c.listOrgRepositories(org, { per_page: 30 });
          repoNames = repos.map((r) => r.name);
        }

        const rows: string[] = [
          `**Org Security Summary — ${org}** (${repoNames.length} repo(s))\n`,
          `| Repository | Code Scanning | Dependabot | Secret Scanning |`,
          `| --- | --- | --- | --- |`,
        ];

        // 403/404 per repo = product not enabled → "n/a" cell; any other
        // failure aborts the scan rather than reporting a false zero.
        const cell = (v: unknown[] | "n/a" | "off") =>
          v === "n/a" ? "n/a" : v === "off" ? "—" : String(v.length);
        for (const repoName of repoNames.slice(0, 50)) {
          const [cs, dep, sec] = await Promise.all([
            include_code_scanning
              ? alertsOrUnavailable(
                  c.listCodeScanningAlerts(org, repoName, { state: "open", per_page: 100 }),
                )
              : Promise.resolve("off" as const),
            include_dependabot
              ? alertsOrUnavailable(
                  c.listDependabotAlerts(org, repoName, { state: "open", per_page: 100 }),
                )
              : Promise.resolve("off" as const),
            include_secret_scanning
              ? alertsOrUnavailable(
                  c.listSecretScanningAlerts(org, repoName, { state: "open", per_page: 100 }),
                )
              : Promise.resolve("off" as const),
          ]);
          rows.push(`| ${repoName} | ${cell(cs)} | ${cell(dep)} | ${cell(sec)} |`);
        }

        return { content: [{ type: "text", text: pi.scrubText(rows.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "org_find_repositories_missing_security_controls",
    "Find repositories in an organisation that appear to be missing expected security controls. " +
      "Checks: code scanning enabled, secret scanning enabled, push protection, Dependabot alerts, " +
      "and SECURITY.md present. Returns a list of repos missing each control.",
    {
      org: z.string().min(1),
      required_controls: z
        .array(
          z.enum([
            "code_scanning",
            "secret_scanning",
            "push_protection",
            "dependabot_alerts",
            "security_policy",
          ]),
        )
        .default([
          "code_scanning",
          "secret_scanning",
          "push_protection",
          "dependabot_alerts",
          "security_policy",
        ]),
      max_repos: z.number().int().min(1).max(100).default(30),
    },
    { readOnlyHint: true },
    async ({ org, required_controls, max_repos }) => {
      try {
        if (!/^[A-Za-z0-9_.-]+$/.test(org)) {
          throw new Error(`Invalid org: ${JSON.stringify(org)}`);
        }
        checkOrgAllowList(org);
        const c = getClient();
        const repos = await c.listOrgRepositories(org, { per_page: max_repos });

        const missing: Record<string, string[]> = {};

        for (const repo of repos) {
          const lacking: string[] = [];
          const sa = repo.security_and_analysis;

          if (
            required_controls.includes("code_scanning") &&
            sa?.advanced_security?.status !== "enabled" &&
            sa?.code_security_and_analysis?.status !== "enabled"
          ) {
            lacking.push("code_scanning");
          }
          if (
            required_controls.includes("secret_scanning") &&
            sa?.secret_scanning?.status !== "enabled"
          ) {
            lacking.push("secret_scanning");
          }
          if (
            required_controls.includes("push_protection") &&
            sa?.secret_scanning_push_protection?.status !== "enabled"
          ) {
            lacking.push("push_protection");
          }
          if (
            required_controls.includes("dependabot_alerts") &&
            sa?.dependabot_security_updates?.status !== "enabled"
          ) {
            lacking.push("dependabot_alerts");
          }

          if (required_controls.includes("security_policy")) {
            // checkFileExists already maps 404 → false and rethrows real
            // failures — do not re-swallow them into "policy missing".
            const has = await c.checkFileExists(org, repo.name, "SECURITY.md");
            if (!has) lacking.push("security_policy");
          }

          if (lacking.length) {
            missing[repo.name] = lacking;
          }
        }

        const entries = Object.entries(missing);
        if (!entries.length) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`All ${repos.length} checked repo(s) in ${org} have the required controls.`),
              },
            ],
          };
        }

        const lines = [
          `**Repositories missing security controls in ${org}** (${entries.length}/${repos.length} checked)\n`,
          `| Repository | Missing Controls |`,
          `| --- | --- |`,
          ...entries.map(([name, ctrls]) => `| ${name} | ${ctrls.join(", ")} |`),
        ];
        return { content: [{ type: "text", text: pi.scrubText(lines.join("\n")) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err, process.env.GITHUB_TOKEN)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// Export the fingerprint helper so it can be used programmatically
export { computeFingerprint };
