import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import {
  SessionManager,
  createAuthenticatedFetch,
  createBasicAuthFetch,
  authCliPath,
} from '@nrs/auth';
import { config } from '../config.js';
import { parseRawTicket } from './ticket-parser.js';
import type { Ticket } from '../types.js';

export class JiraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraAuthError';
  }
}

const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.csv']);

type AuthenticatedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * User-scoped cache under ~/.raven, mirroring the auth package's
 * SessionManager / cookie-cache layout. The previous location
 * (`process.cwd()/.cache`) wrote ticket text — including comments and
 * attachment contents that may contain PII — into whatever directory
 * launched the server, with default permissions, and was easy to
 * accidentally commit. Anchoring at HOME removes that exposure and
 * keeps cache state independent of the launcher's CWD.
 */
function getCacheDir(): string {
  return path.join(homedir(), '.raven', 'cache', 'bug-classifier');
}

function getAttachmentCacheDir(): string {
  return path.join(getCacheDir(), 'attachments');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    // 0o700 — owner-only, mirrors how @nrs/auth secures ~/.raven artifacts
    // (cookie cache, session). Ticket text may contain PII even after
    // PiScrubber, and attachments are written verbatim.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Cache filename includes the lookback window AND the maxTickets cap.
 * Both gate what gets written: months bounds the JQL `created >=` clause,
 * and maxTickets bounds the per-project budget passed into runJqlQuery.
 * A first run with `maxTickets=200` writes a partial snapshot; without
 * `maxTickets` in the key, a later run with `maxTickets=2000` would
 * silently reuse that incomplete cache until the 24h TTL expires.
 */
function getCachePath(project: string, months: number, maxTickets: number): string {
  return path.join(getCacheDir(), `${project}-${months}m-${maxTickets}t.json`);
}

function isCacheValid(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return Date.now() - stat.mtimeMs < config.cacheTtlMs;
}

/** Default Jira base when no env var is set — matches jira-mcp's default. */
const DEFAULT_JIRA_BASE = 'https://apps.example.gov.bc.ca/int/jira';

/**
 * Resolve the Jira base URL. Mirrors jira-mcp / assets-mcp: use
 * ATLASSIAN_BASE_URL when set (appending /int/jira if needed), otherwise
 * fall back to the canonical apps.example.gov.bc.ca host. Never throws —
 * SMSESSION-only setups need this to be tolerant of a missing env var.
 *
 * Exported so server.ts can build correct ticket links in markdown reports.
 */
export function getJiraBaseUrl(): string {
  const baseUrl = process.env.ATLASSIAN_BASE_URL;
  if (!baseUrl) return DEFAULT_JIRA_BASE;
  // Append /int/jira if not already present (matches Raven convention)
  if (baseUrl.includes('/int/jira')) return baseUrl.replace(/\/+$/, '');
  return `${baseUrl.replace(/\/+$/, '')}/int/jira`;
}

/**
 * Build an authenticated fetch wrapper. Mirrors the auth pattern other
 * Atlassian MCP servers in this monorepo follow: prefer Basic Auth env
 * vars, fall back to SiteMinder/SMSESSION via SessionManager so users
 * already logged in via the standard flow can use this server too.
 */
async function createAuthFetch(): Promise<{ authFetch: AuthenticatedFetch; jiraUrl: string }> {
  const email = process.env.ATLASSIAN_EMAIL;
  const password = process.env.ATLASSIAN_PASSWORD;
  const baseUrl = process.env.ATLASSIAN_BASE_URL;
  const jiraUrl = getJiraBaseUrl();

  // Match jira-mcp / assets-mcp: only use Basic Auth when ALL THREE env
  // vars are set. ATLASSIAN_BASE_URL points at the BWA host that accepts
  // Basic Auth — the public apps.example.gov.bc.ca host (our default) does
  // not, so a user with email+password but no BWA URL must go through
  // SMSESSION just like the other servers do.
  if (email && password && baseUrl) {
    return { authFetch: createBasicAuthFetch(email, password), jiraUrl };
  }

  // Fall back to SMSESSION — same as jira-mcp / assets-mcp / etc.
  try {
    const sessionManager = new SessionManager();
    const authFetch = await createAuthenticatedFetch(sessionManager);
    return { authFetch, jiraUrl };
  } catch (err) {
    throw new JiraAuthError(
      'No Jira credentials available. For Basic Auth set ATLASSIAN_EMAIL, ' +
      'ATLASSIAN_PASSWORD, AND ATLASSIAN_BASE_URL in ~/.raven/.env (all ' +
      'three are required — base URL points at the BWA host that accepts ' +
      'Basic Auth). Otherwise authenticate via SMSESSION: ' +
      `node ${authCliPath}. Underlying error: ${(err as Error).message}`,
    );
  }
}

/**
 * Verify that the configured credentials can talk to Jira. Distinguishes
 * authentication failures (401/403) from transport problems (DNS, timeouts,
 * 5xx) so users with legitimate credentials don't get sent down the
 * "fix your password" path during a Jira outage or network issue.
 */
async function validateCredentials(authFetch: AuthenticatedFetch, jiraUrl: string): Promise<void> {
  let res: Response;
  try {
    res = await authFetch(`${jiraUrl}/rest/api/2/myself`);
  } catch (err) {
    // Network / DNS / timeout — not an auth problem.
    throw new Error(`Jira unreachable (${(err as Error).message}). Check VPN and network.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new JiraAuthError(`Jira authentication failed (${res.status}). Check credentials in ~/.raven/.env.`);
  }
  if (!res.ok) {
    // 5xx, etc. — Jira responded but not happily; not an auth issue.
    throw new Error(`Jira /myself returned HTTP ${res.status}. Server may be unhealthy.`);
  }
}

const SEARCH_FIELDS = [
  'project', 'summary', 'description', 'issuetype', 'labels',
  'components', 'priority', 'status', 'created', 'resolutiondate',
  'issuelinks', 'comment', 'attachment',
].join(',');

/**
 * Run a JQL query with pagination. `budget` caps how many issues we'll
 * accumulate before stopping pagination — the caller passes the remaining
 * maxTickets headroom so we don't burn network/parsing on tickets that
 * will be discarded later.
 */
async function runJqlQuery(
  authFetch: AuthenticatedFetch,
  jiraUrl: string,
  jql: string,
  verbose: boolean,
  budget: number = Infinity,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  let startAt = 0;

  while (true) {
    // Cap each request at min(jiraPageSize, remaining budget). Without
    // this, a per-project budget of (say) 25 tickets still triggered a
    // 100-ticket page fetch, so the cap meant nothing for traffic /
    // download / parse cost — just for what we KEPT in memory.
    const remaining = Number.isFinite(budget) ? Math.max(0, budget - results.length) : Infinity;
    const pageSize = Math.min(config.jiraPageSize, remaining);
    if (pageSize <= 0) break;

    if (verbose) console.error(`  Fetching tickets ${startAt}-${startAt + pageSize}...`);

    const params = new URLSearchParams({
      jql,
      startAt: String(startAt),
      maxResults: String(pageSize),
      fields: SEARCH_FIELDS,
      // No `expand: renderedFields` — nothing in this package reads the
      // rendered HTML, and including it nearly doubles each search-page
      // payload on multi-project lookbacks.
    });

    let res: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await authFetch(`${jiraUrl}/rest/api/2/search?${params}`);
        break;
      } catch (err: unknown) {
        if (attempt < 3) {
          const delay = Math.pow(2, attempt) * 1000;
          if (verbose) console.error(`  Network error, retrying in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    if (!res!.ok) {
      // Truncate the body — Jira can return KB of HTML (login portals,
      // error pages) and we don't want that pasted into tool results.
      const body = await res!.text();
      const truncated = body.length > 500 ? body.slice(0, 500) + "… [truncated]" : body;
      throw new Error(`Jira search failed (${res!.status}): ${truncated}`);
    }

    const data = await res!.json() as { issues?: Record<string, unknown>[]; total?: number };
    const issues = data.issues ?? [];
    results.push(...issues);

    if (verbose) console.error(`  Got ${issues.length} (total: ${data.total ?? '?'})`);

    if (results.length >= (data.total ?? 0) || issues.length < pageSize) {
      break;
    }
    if (results.length >= budget) {
      if (verbose) console.error(`  Reached budget cap (${budget}); stopping pagination`);
      break;
    }
    startAt += pageSize;
  }

  return results;
}

/**
 * Build a safe local cache path for a Jira attachment.
 *
 * `att.filename` comes from Jira metadata and is otherwise untrusted
 * user input — a crafted filename like `../../etc/passwd` would, after
 * `path.join` normalization, escape `cacheDir` and let `fs.writeFileSync`
 * overwrite arbitrary files on the developer's machine.
 *
 * Returns the joined path when safe, or `null` when the resolved path
 * would escape `cacheDir`. `path.basename` strips any directory
 * separators before joining, and the resolve+startsWith check is
 * belt-and-suspenders against unusual edge cases.
 *
 * Exported for unit-testing — calling the real function ensures a
 * regression in this code is actually caught by the test suite.
 */
export function safeAttachmentPath(cacheDir: string, id: string, filename: string): string | null {
  const safeFilename = path.basename(filename);
  const cachedPath = path.join(cacheDir, `${id}-${safeFilename}`);
  if (!path.resolve(cachedPath).startsWith(path.resolve(cacheDir) + path.sep)) {
    return null;
  }
  return cachedPath;
}

async function downloadTextAttachments(
  authFetch: AuthenticatedFetch,
  rawAttachments: Array<{ id: string; filename: string; size: number; content?: string }>,
  verbose: boolean
): Promise<string[]> {
  const texts: string[] = [];
  const cacheDir = getAttachmentCacheDir();
  ensureDir(cacheDir);

  for (const att of rawAttachments) {
    const ext = path.extname(att.filename).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    if (att.size > config.maxAttachmentBytes) {
      if (verbose) console.error(`  Skipping oversized attachment: ${att.filename} (${att.size} bytes)`);
      continue;
    }

    const cachedPath = safeAttachmentPath(cacheDir, att.id, att.filename);
    if (cachedPath === null) {
      if (verbose) console.error(`  Skipping attachment with suspicious filename: ${att.filename}`);
      continue;
    }
    if (fs.existsSync(cachedPath)) {
      texts.push(fs.readFileSync(cachedPath, 'utf-8'));
      continue;
    }

    try {
      const contentUrl = att.content;
      if (!contentUrl) continue;
      const res = await authFetch(contentUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      fs.writeFileSync(cachedPath, text, 'utf-8');
      texts.push(text);
    } catch {
      if (verbose) console.error(`  Warning: Failed to download attachment ${att.filename}`);
    }
  }

  return texts;
}

export async function fetchTickets(
  projects: string[],
  months: number,
  noCache: boolean,
  verbose: boolean,
  maxTickets: number
): Promise<Ticket[]> {
  // Cache lookup happens BEFORE credential validation. Otherwise a transient
  // Jira outage or missing env vars would render a fresh 24h cache useless,
  // turning recoverable problems into hard failures even when no fetch
  // is needed.
  const allTickets = new Map<string, Ticket>();
  const projectsNeedingFetch: string[] = [];

  for (const project of projects) {
    if (!noCache) {
      const cachePath = getCachePath(project, months, maxTickets);
      if (isCacheValid(cachePath)) {
        try {
          if (verbose) console.error(`  Using cached data for ${project} (${months}m window)`);
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Ticket[];
          for (const t of cached) allTickets.set(t.key, t);
          continue;
        } catch {
          if (verbose) console.error(`  Warning: Corrupt cache for ${project}, re-fetching`);
        }
      }
    }
    projectsNeedingFetch.push(project);
  }

  // Only authenticate if at least one project actually needs a network fetch.
  if (projectsNeedingFetch.length === 0) {
    return finalizeTickets(allTickets, maxTickets);
  }

  const { authFetch, jiraUrl } = await createAuthFetch();
  await validateCredentials(authFetch, jiraUrl);

  // Each project fetches up to maxTickets, then finalizeTickets sorts
  // by recency and truncates the union to maxTickets globally. The
  // earlier per-project even-split (with 1.5x padding) was order-
  // independent but DROPPED tickets that should have been in the global
  // top-N by recency: a dense project with 2000 newer bugs would lose
  // some when the per-project cap was 1500.
  //
  // Order-independent (each project gets the same budget regardless of
  // input order) AND recency-correct (the global truncate keeps the
  // newest tickets across all projects). Trade-off: total Jira fetch
  // can be up to maxTickets × N when every project is dense.
  const perProjectBudget = maxTickets;

  for (const project of projectsNeedingFetch) {
    const budget = perProjectBudget;

    if (verbose) console.error(`\nFetching tickets for ${project} (budget ${budget})...`);

    // BC Gov Jira Server doesn't support relative dates (-12m). Use absolute date.
    // Labels with hyphens must be quoted for Jira Server.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    // Restrict to bug-like issue types/labels. Without this filter, tasks
    // and stories whose summary happens to mention "error", "outage", or
    // "rollback" would get clustered as bugs.
    //
    // We previously ran a second JQL with an additional `summary ~ ...`
    // clause to catch typo-tagged issues. After bug-like filtering was
    // added to both queries, jql2 became a strict subset of jql1
    // (same project + bugLikeClause + created window, plus an extra
    // narrowing condition), so it never contributed unique tickets and
    // just doubled Jira load. Removed.
    const bugLikeClause = `(type in (Bug, Request) OR labels in ("defect", "bug", "datafix", "data-fix", "data-fixes", "datafixes"))`;
    const jql1 = `project = "${project}" AND ${bugLikeClause} AND created >= "${cutoffStr}" ORDER BY created DESC`;

    let rawIssues: Record<string, unknown>[];
    try {
      const results = await runJqlQuery(authFetch, jiraUrl, jql1, verbose, budget);

      const seen = new Set<string>();
      rawIssues = [];
      for (const issue of results) {
        const key = issue.key as string;
        if (!seen.has(key)) {
          seen.add(key);
          rawIssues.push(issue);
        }
      }
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      // 404 = project does not exist — skip with a warning.
      // 400 ≠ "project not found" — Jira returns 400 for bad JQL, unsupported
      // fields, etc. Bubbling those up surfaces real query bugs instead of
      // silently dropping the project.
      if (msg.includes('404')) {
        console.warn(`Warning: Project ${project} not found. Skipping.`);
        continue;
      }
      throw err;
    }

    if (verbose) console.error(`  Found ${rawIssues.length} unique tickets for ${project}`);

    const tickets: Ticket[] = [];
    for (const raw of rawIssues) {
      const ticket = parseRawTicket(raw);
      const fields = (raw.fields ?? {}) as Record<string, unknown>;
      const rawAttachments = (Array.isArray(fields.attachment) ? fields.attachment : []) as Array<{
        id: string; filename: string; size: number; content?: string;
      }>;

      if (rawAttachments.length > 0) {
        ticket.attachmentTexts = await downloadTextAttachments(authFetch, rawAttachments, verbose);
      }

      tickets.push(ticket);
    }

    try {
      ensureDir(getCacheDir());
      // PII trust model: tickets here are written verbatim from Jira —
      // summaries, descriptions, comments, and attachment text retain
      // any PII the source ticket had. Mitigations:
      //   • Cache lives under ~/.raven/cache/bug-classifier with 0o700
      //     (owner-only; mirrors @nrs/auth's session/cookie cache).
      //   • TTL is config.cacheTtlMs (24h) — entries rotate automatically.
      //   • Egress (LLM prompts, MCP tool output) is scrubbed by PiScrubber
      //     in server.ts before leaving the process; the cache itself is
      //     never sent anywhere.
      // The cache is effectively a local copy of data the operator already
      // has Jira authorization to read — no new exposure beyond Jira itself.
      fs.writeFileSync(getCachePath(project, months, maxTickets), JSON.stringify(tickets, null, 2), 'utf-8');
    } catch {
      if (verbose) console.error(`  Warning: Could not write cache for ${project}`);
    }

    for (const t of tickets) allTickets.set(t.key, t);
  }

  return finalizeTickets(allTickets, maxTickets);
}

function finalizeTickets(allTickets: Map<string, Ticket>, maxTickets: number): Ticket[] {
  let result = [...allTickets.values()];
  if (result.length > maxTickets) {
    console.warn(`Warning: ${result.length} tickets exceeds --max-tickets (${maxTickets}). Truncating to most recent.`);
    result.sort((a, b) => b.created.localeCompare(a.created));
    result = result.slice(0, maxTickets);
  }
  return result;
}
