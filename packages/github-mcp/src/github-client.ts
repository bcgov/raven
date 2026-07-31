import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import type {
  CanonicalFinding,
  SarifLog,
  SarifRule,
  SarifResult,
  GitHubCodeScanningAlert,
  GitHubAlertInstance,
  GitHubSarifUploadResponse,
  GitHubSarifStatusResponse,
  GitHubSecretScanningAlert,
  GitHubDependabotAlert,
  GitHubIssue,
  GitHubPullRequest,
  GitHubAutofix,
  GitHubRepository,
  GitHubRuleset,
} from "./types.js";

const gzipAsync = promisify(gzip);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum response body size we will read (4 MB). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Default per-page cap for list endpoints. */
const DEFAULT_PER_PAGE = 30;
/** Hard per-page cap (GitHub's own max is 100). */
const MAX_PER_PAGE = 100;
/** Default request timeout in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

// ---------------------------------------------------------------------------
// Allow-list validation
// ---------------------------------------------------------------------------

/** Validates that an owner/repo is allowed by GITHUB_REPOSITORY_ALLOWLIST. */
export function checkAllowList(owner: string, repo: string): void {
  const raw = process.env.GITHUB_REPOSITORY_ALLOWLIST;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "GITHUB_REPOSITORY_ALLOWLIST is required. Configure exact owner/repo entries or owner/* wildcards.",
    );
  }

  const entries = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const key = `${owner}/${repo}`.toLowerCase();

  const allowed = entries.some((e) => {
    if (e === key) return true;
    // Wildcard: "bcgov/*" matches any repo under bcgov
    if (e.endsWith("/*")) {
      const prefix = e.slice(0, -1); // "bcgov/"
      return key.startsWith(prefix);
    }
    return false;
  });

  if (!allowed) {
    throw new Error(
      `Repository ${owner}/${repo} is not permitted by GITHUB_REPOSITORY_ALLOWLIST. ` +
        `Add "${owner}/${repo}" or "${owner}/*" to allow it.`,
    );
  }
}

/** Validates an organisation against the repository allow-list. */
export function checkOrgAllowList(org: string): void {
  const raw = process.env.GITHUB_REPOSITORY_ALLOWLIST;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "GITHUB_REPOSITORY_ALLOWLIST is required. Configure entries for the target organisation.",
    );
  }
  const prefix = `${org}/`.toLowerCase();
  const allowed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === `${org.toLowerCase()}/*` || entry.startsWith(prefix));
  if (!allowed) {
    throw new Error(
      `Organisation ${org} is not permitted by GITHUB_REPOSITORY_ALLOWLIST.`,
    );
  }
}

/** Normalizes and validates an HTTPS GitHub API base URL. */
export function normalizeApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GITHUB_API_URL must be a valid absolute URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("GITHUB_API_URL must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("GITHUB_API_URL must not contain credentials, query strings, or fragments.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Input sanitisation helpers
// ---------------------------------------------------------------------------

/** Validates that owner/repo identifiers contain only safe characters. */
export function validateOwnerRepo(owner: string, repo: string): void {
  // GitHub allows alphanumeric, hyphen, underscore, and dot in repo names.
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) {
    throw new Error(`Invalid owner: ${JSON.stringify(owner)}`);
  }
  if (!/^[A-Za-z0-9_.\-]+$/.test(repo)) {
    throw new Error(`Invalid repo: ${JSON.stringify(repo)}`);
  }
}

/** Ensures per_page is within [1, MAX_PER_PAGE]. */
export function clampPerPage(n: number): number {
  return Math.max(1, Math.min(n, MAX_PER_PAGE));
}

// ---------------------------------------------------------------------------
// SARIF helpers
// ---------------------------------------------------------------------------

const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Documents/CommitteeSpecifications/2.1.0/sarif-schema-2.1.0.json";

const SEVERITY_LEVEL: Record<string, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  note: "note",
};

/**
 * Computes a stable partial fingerprint from deterministic material.
 * The hex digest is truncated to 40 chars (160-bit prefix).
 */
export function computeFingerprint(
  repoSlug: string,
  ruleId: string,
  file: string,
  startLine: number,
  message: string,
): string {
  const normalised = [
    repoSlug.toLowerCase(),
    ruleId.toLowerCase(),
    file.replace(/\\/g, "/").toLowerCase(),
    String(startLine),
    message.trim().toLowerCase().slice(0, 256),
  ].join("|");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 40);
}

/** Converts a single CanonicalFinding to a SARIF rule object. */
function findingToSarifRule(f: CanonicalFinding): SarifRule {
  const tags: string[] = ["security"];
  if (f.cwe) tags.push(...f.cwe.map((c) => c.toLowerCase()));
  if (f.owasp) tags.push(...f.owasp);

  return {
    id: f.rule_id,
    name: f.rule_id,
    shortDescription: { text: f.title },
    fullDescription: { text: f.description },
    help: {
      text: f.recommendation ?? f.description,
      markdown: f.recommendation
        ? `**Recommended Remediation**\n\n${f.recommendation}`
        : undefined,
    },
    properties: {
      tags,
      precision: f.precision ?? "medium",
      ...(f.security_severity != null
        ? { "security-severity": String(f.security_severity) }
        : {}),
    },
  };
}

/** Converts a single CanonicalFinding to a SARIF result object. */
function findingToSarifResult(
  f: CanonicalFinding,
  repoSlug: string,
): SarifResult {
  const filePath = f.file.replace(/\\/g, "/").replace(/^\//, "");
  const fingerprint = computeFingerprint(
    f.fingerprint_material?.repo ?? repoSlug,
    f.fingerprint_material?.rule_id ?? f.rule_id,
    f.fingerprint_material?.file ?? filePath,
    f.start_line,
    f.title,
  );

  return {
    ruleId: f.rule_id,
    level: SEVERITY_LEVEL[f.severity] ?? "warning",
    message: {
      text: f.evidence
        ? `${f.title}\n\nEvidence: ${f.evidence}`
        : f.title,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: filePath },
          region: {
            startLine: f.start_line,
            ...(f.end_line != null ? { endLine: f.end_line } : {}),
            ...(f.start_column != null ? { startColumn: f.start_column } : {}),
            ...(f.end_column != null ? { endColumn: f.end_column } : {}),
          },
        },
      },
    ],
    partialFingerprints: {
      "primaryLocationLineHash/v1": fingerprint,
    },
  };
}

/**
 * Converts an array of CanonicalFindings to a minimal SARIF 2.1.0 log.
 * Deduplicated rules are computed from the findings array.
 */
export function findingsToSarif(
  findings: CanonicalFinding[],
  toolName: string,
  repoSlug: string,
  checkoutUri?: string,
): SarifLog {
  const rulesMap = new Map<string, SarifRule>();
  for (const f of findings) {
    if (!rulesMap.has(f.rule_id)) {
      rulesMap.set(f.rule_id, findingToSarifRule(f));
    }
  }

  const results: SarifResult[] = findings.map((f) =>
    findingToSarifResult(f, repoSlug),
  );

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: "1.0.0",
            semanticVersion: "1.0.0",
            rules: Array.from(rulesMap.values()),
          },
        },
        results,
        ...(checkoutUri
          ? { originalUriBaseIds: { SRCROOT: { uri: checkoutUri } } }
          : {}),
      },
    ],
  };
}

/**
 * Validates a parsed SARIF log: version must be "2.1.0" and every result
 * must have a ruleId.  Throws descriptively on any violation.
 */
export function validateSarif(sarif: SarifLog): void {
  if (sarif.version !== "2.1.0") {
    throw new Error(`SARIF version must be "2.1.0", got "${sarif.version}"`);
  }
  if (!Array.isArray(sarif.runs) || sarif.runs.length === 0) {
    throw new Error("SARIF must have at least one run");
  }
  for (const [ri, run] of sarif.runs.entries()) {
    if (!run.tool?.driver?.name) {
      throw new Error(`SARIF run[${ri}].tool.driver.name is required`);
    }
    for (const [idx, result] of (run.results ?? []).entries()) {
      if (!result.ruleId) {
        throw new Error(`SARIF run[${ri}].results[${idx}] is missing ruleId`);
      }
      const loc = result.locations?.[0]?.physicalLocation?.artifactLocation;
      if (loc && loc.uri && (loc.uri.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(loc.uri))) {
        throw new Error(
          `SARIF result[${idx}] has an absolute path "${loc.uri}". ` +
            "All artifact URIs must be repository-relative.",
        );
      }
    }
  }
}

/**
 * Gzip-compresses and base64-encodes a SARIF log for the GitHub upload API.
 */
export async function encodeSarif(sarif: SarifLog): Promise<string> {
  const json = JSON.stringify(sarif);
  const compressed = await gzipAsync(Buffer.from(json, "utf-8"));
  return compressed.toString("base64");
}

// ---------------------------------------------------------------------------
// GitHub REST client
// ---------------------------------------------------------------------------

export interface GitHubClientOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * Lightweight GitHub REST API client.
 *
 * Authentication: Bearer token (GITHUB_TOKEN).
 * Never exposes the raw token in error messages.
 *
 * The optional fourth parameter `fetchFn` is injected in tests to avoid real
 * HTTP calls.  Production code uses globalThis.fetch (Node 18+).
 */
export class GitHubClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(
    apiBase: string,
    token: string,
    options: GitHubClientOptions = {},
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiBase = normalizeApiBaseUrl(apiBase);
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /** The configured API base URL (for tests / diagnostics). */
  get baseUrl(): string {
    return this.apiBase;
  }

  // -------------------------------------------------------------------------
  // Core HTTP helper
  // -------------------------------------------------------------------------

  /** Makes a GitHub API request. Never leaks the token in thrown errors. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
          qs.append(k, String(v));
        }
      }
    }
    const query = qs.toString() ? `?${qs}` : "";
    const url = `${this.apiBase}/${path.replace(/^\//, "")}${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await this.fetchFn(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "RAVEN-GitHub-MCP/1.0",
        },
        ...(body != null ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      // Ensure token is never included in the thrown error message.
      throw new Error(
        `GitHub API request failed (${method} ${path}): ${this.redactToken(msg)}`,
      );
    }
    clearTimeout(timer);

    // Rate limit: log remaining and retry-after, but don't auto-retry here
    // (caller can implement retry logic if needed).
    const remaining = resp.headers.get("x-ratelimit-remaining");
    const retryAfter = resp.headers.get("retry-after");
    if (remaining === "0" || resp.status === 429) {
      const wait = retryAfter ?? "unknown";
      throw new Error(
        `GitHub API rate limit exceeded on ${path}. Retry after ${wait}s.`,
      );
    }

    if (resp.status === 202 || resp.status === 201 || resp.status === 204) {
      if (resp.status === 204) return {} as T;
      // For 201/202 try to parse JSON but don't fail if empty
      const text = await this.readBounded(resp);
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    }

    if (!resp.ok) {
      const text = await this.readBounded(resp).catch(() => "");
      throw new GitHubApiError(
        resp.status,
        `GitHub API error ${resp.status} on ${method} ${path}: ${this.redactToken(text.slice(0, 500))}`,
      );
    }

    const text = await this.readBounded(resp);
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  /** Reads the response body up to maxBodyBytes, returning a string. */
  private async readBounded(resp: Response): Promise<string> {
    const text = await resp.text();
    const byteLen = Buffer.byteLength(text, "utf-8");
    if (byteLen > this.maxBodyBytes) {
      throw new Error(
        `GitHub API response too large (${byteLen} bytes > ${this.maxBodyBytes} max)`,
      );
    }
    return text;
  }

  /** Removes the token from a string to prevent leakage in error messages. */
  private redactToken(s: string): string {
    return this.token ? s.split(this.token).join("[REDACTED]") : s;
  }

  // -------------------------------------------------------------------------
  // Foundation / health
  // -------------------------------------------------------------------------

  async getRateLimit(): Promise<{
    rate: { limit: number; remaining: number; reset: number };
  }> {
    return this.request("GET", "rate_limit");
  }

  async getAuthenticatedUser(): Promise<{ login: string; name?: string | null }> {
    return this.request("GET", "user");
  }

  // -------------------------------------------------------------------------
  // SARIF / Code Scanning
  // -------------------------------------------------------------------------

  async uploadSarif(
    owner: string,
    repo: string,
    payload: {
      commit_sha: string;
      ref: string;
      sarif: string;
      checkout_uri?: string;
      tool_name?: string;
      category?: string;
    },
  ): Promise<GitHubSarifUploadResponse> {
    return this.request(
      "POST",
      `repos/${owner}/${repo}/code-scanning/sarifs`,
      payload,
    );
  }

  async getSarifUploadStatus(
    owner: string,
    repo: string,
    sarifId: string,
  ): Promise<GitHubSarifStatusResponse> {
    return this.request(
      "GET",
      `repos/${owner}/${repo}/code-scanning/sarifs/${sarifId}`,
    );
  }

  async listCodeScanningAlerts(
    owner: string,
    repo: string,
    params: {
      state?: string;
      severity?: string;
      tool_name?: string;
      ref?: string;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<GitHubCodeScanningAlert[]> {
    return this.request<GitHubCodeScanningAlert[]>(
      "GET",
      `repos/${owner}/${repo}/code-scanning/alerts`,
      undefined,
      {
        state: params.state,
        severity: params.severity,
        tool_name: params.tool_name,
        ref: params.ref,
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? DEFAULT_PER_PAGE),
      },
    );
  }

  async getCodeScanningAlert(
    owner: string,
    repo: string,
    alertNumber: number,
  ): Promise<GitHubCodeScanningAlert> {
    return this.request(
      "GET",
      `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}`,
    );
  }

  async getCodeScanningAlertInstances(
    owner: string,
    repo: string,
    alertNumber: number,
    params: { ref?: string; page?: number; per_page?: number } = {},
  ): Promise<GitHubAlertInstance[]> {
    return this.request<GitHubAlertInstance[]>(
      "GET",
      `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}/instances`,
      undefined,
      {
        ref: params.ref,
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? DEFAULT_PER_PAGE),
      },
    );
  }

  async updateCodeScanningAlert(
    owner: string,
    repo: string,
    alertNumber: number,
    payload: {
      state: "open" | "dismissed";
      dismissed_reason?: string;
      dismissed_comment?: string;
    },
  ): Promise<GitHubCodeScanningAlert> {
    return this.request(
      "PATCH",
      `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}`,
      payload,
    );
  }

  // -------------------------------------------------------------------------
  // Autofix
  // -------------------------------------------------------------------------

  async createAutofix(
    owner: string,
    repo: string,
    alertNumber: number,
  ): Promise<GitHubAutofix> {
    return this.request(
      "POST",
      `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}/autofix`,
    );
  }

  async getAutofixStatus(
    owner: string,
    repo: string,
    alertNumber: number,
  ): Promise<GitHubAutofix> {
    return this.request(
      "GET",
      `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}/autofix`,
    );
  }

  async commitAutofix(
    owner: string,
    repo: string,
    alertNumber: number,
    targetBranch: string,
  ): Promise<{ commit_url?: string; message?: string }> {
    return this.request(
      "POST",
      `repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}/autofix/commits`,
      { target_branch: targetBranch },
    );
  }

  // -------------------------------------------------------------------------
  // Secret Scanning
  // -------------------------------------------------------------------------

  async listSecretScanningAlerts(
    owner: string,
    repo: string,
    params: {
      state?: string;
      resolution?: string;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<GitHubSecretScanningAlert[]> {
    const raw = await this.request<Array<GitHubSecretScanningAlert & { secret?: string }>>(
      "GET",
      `repos/${owner}/${repo}/secret-scanning/alerts`,
      undefined,
      {
        state: params.state,
        resolution: params.resolution,
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? DEFAULT_PER_PAGE),
      },
    );
    // Strip the secret value before returning
    return raw.map(({ secret: _secret, ...rest }) => rest);
  }

  async getSecretScanningAlert(
    owner: string,
    repo: string,
    alertNumber: number,
  ): Promise<GitHubSecretScanningAlert> {
    const raw = await this.request<GitHubSecretScanningAlert & { secret?: string }>(
      "GET",
      `repos/${owner}/${repo}/secret-scanning/alerts/${alertNumber}`,
    );
    // Strip the secret value before returning
    const { secret: _secret, ...rest } = raw;
    return rest;
  }

  async updateSecretScanningAlert(
    owner: string,
    repo: string,
    alertNumber: number,
    payload: {
      state: "open" | "resolved";
      resolution?: string;
      resolution_comment?: string;
    },
  ): Promise<GitHubSecretScanningAlert> {
    const raw = await this.request<GitHubSecretScanningAlert & { secret?: string }>(
      "PATCH",
      `repos/${owner}/${repo}/secret-scanning/alerts/${alertNumber}`,
      payload,
    );
    const { secret: _secret, ...rest } = raw;
    return rest;
  }

  // -------------------------------------------------------------------------
  // Dependabot Alerts
  // -------------------------------------------------------------------------

  async listDependabotAlerts(
    owner: string,
    repo: string,
    params: {
      state?: string;
      severity?: string;
      ecosystem?: string;
      package?: string;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<GitHubDependabotAlert[]> {
    return this.request<GitHubDependabotAlert[]>(
      "GET",
      `repos/${owner}/${repo}/dependabot/alerts`,
      undefined,
      {
        state: params.state,
        severity: params.severity,
        ecosystem: params.ecosystem,
        package: params.package,
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? DEFAULT_PER_PAGE),
      },
    );
  }

  async getDependabotAlert(
    owner: string,
    repo: string,
    alertNumber: number,
  ): Promise<GitHubDependabotAlert> {
    return this.request(
      "GET",
      `repos/${owner}/${repo}/dependabot/alerts/${alertNumber}`,
    );
  }

  async updateDependabotAlert(
    owner: string,
    repo: string,
    alertNumber: number,
    payload: {
      state: "dismissed" | "open";
      dismissed_reason?: string;
      dismissed_comment?: string;
    },
  ): Promise<GitHubDependabotAlert> {
    return this.request(
      "PATCH",
      `repos/${owner}/${repo}/dependabot/alerts/${alertNumber}`,
      payload,
    );
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  async createIssue(
    owner: string,
    repo: string,
    payload: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      milestone?: number | null;
    },
  ): Promise<GitHubIssue> {
    return this.request("POST", `repos/${owner}/${repo}/issues`, payload);
  }

  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    payload: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      state_reason?: string;
      labels?: string[];
      assignees?: string[];
      milestone?: number | null;
    },
  ): Promise<GitHubIssue> {
    return this.request(
      "PATCH",
      `repos/${owner}/${repo}/issues/${issueNumber}`,
      payload,
    );
  }

  async addIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number; html_url: string; body: string }> {
    return this.request(
      "POST",
      `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  async searchIssues(
    owner: string,
    repo: string,
    query: string,
    params: { page?: number; per_page?: number } = {},
  ): Promise<{ total_count: number; items: GitHubIssue[] }> {
    const q = `${query} repo:${owner}/${repo}`;
    return this.request(
      "GET",
      "search/issues",
      undefined,
      {
        q,
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? DEFAULT_PER_PAGE),
      },
    );
  }

  // -------------------------------------------------------------------------
  // Pull Requests
  // -------------------------------------------------------------------------

  async createPullRequest(
    owner: string,
    repo: string,
    payload: {
      title: string;
      body?: string;
      head: string;
      base: string;
      draft?: boolean;
      maintainer_can_modify?: boolean;
    },
  ): Promise<GitHubPullRequest> {
    return this.request("POST", `repos/${owner}/${repo}/pulls`, payload);
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GitHubPullRequest> {
    return this.request("GET", `repos/${owner}/${repo}/pulls/${pullNumber}`);
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    payload: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      base?: string;
      draft?: boolean;
    },
  ): Promise<GitHubPullRequest> {
    return this.request(
      "PATCH",
      `repos/${owner}/${repo}/pulls/${pullNumber}`,
      payload,
    );
  }

  async requestReview(
    owner: string,
    repo: string,
    pullNumber: number,
    reviewers: string[],
    teamReviewers: string[],
  ): Promise<GitHubPullRequest> {
    return this.request(
      "POST",
      `repos/${owner}/${repo}/pulls/${pullNumber}/requested_reviewers`,
      { reviewers, team_reviewers: teamReviewers },
    );
  }

  async addPullRequestComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<{ id: number; html_url: string; body: string }> {
    // Use the Issues comments endpoint (general PR comments, not review comments)
    return this.request(
      "POST",
      `repos/${owner}/${repo}/issues/${pullNumber}/comments`,
      { body },
    );
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    payload: {
      merge_method?: "merge" | "squash" | "rebase";
      commit_title?: string;
      commit_message?: string;
    },
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    return this.request(
      "PUT",
      `repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      payload,
    );
  }

  // -------------------------------------------------------------------------
  // Repository Security Configuration
  // -------------------------------------------------------------------------

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request("GET", `repos/${owner}/${repo}`);
  }

  async getRulesets(
    owner: string,
    repo: string,
  ): Promise<GitHubRuleset[]> {
    return this.request<GitHubRuleset[]>(
      "GET",
      `repos/${owner}/${repo}/rulesets`,
    );
  }

  async checkFileExists(
    owner: string,
    repo: string,
    path: string,
  ): Promise<boolean> {
    try {
      await this.request("GET", `repos/${owner}/${repo}/contents/${path}`);
      return true;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return false;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Org-level security alerts
  // -------------------------------------------------------------------------

  async listOrgCodeScanningAlerts(
    org: string,
    params: {
      state?: string;
      severity?: string;
      tool_name?: string;
      page?: number;
      per_page?: number;
    } = {},
  ): Promise<GitHubCodeScanningAlert[]> {
    return this.request<GitHubCodeScanningAlert[]>(
      "GET",
      `orgs/${org}/code-scanning/alerts`,
      undefined,
      {
        state: params.state,
        severity: params.severity,
        tool_name: params.tool_name,
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? DEFAULT_PER_PAGE),
      },
    );
  }

  async listOrgRepositories(
    org: string,
    params: { page?: number; per_page?: number } = {},
  ): Promise<GitHubRepository[]> {
    return this.request<GitHubRepository[]>(
      "GET",
      `orgs/${org}/repos`,
      undefined,
      {
        page: params.page ?? 1,
        per_page: clampPerPage(params.per_page ?? 50),
      },
    );
  }
}
