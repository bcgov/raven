import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  readCachedSession,
  writeCachedSession,
  clearCachedSession,
  clearCachedSessionIf,
  isUsableSmsession,
} from "./cookie-cache.js";
import {
  authLockPath,
  authProfileDir,
  buildCaptureScript,
  ensureProfileDir,
  isLoginRedirect,
  resolveAutofillCredentials,
  siteMinderProbeUrl,
  siteMinderWebUrl,
  type CaptureResult,
} from "./capture-script.js";
import { withAuthLock } from "./auth-lock.js";
import type { AuthConfig } from "./types.js";
import { BROWSER_USER_AGENT } from "./browser-ua.js";
import { authCliPath } from "./auth-cli-path.js";

const DEFAULT_CACHE_PATH = join(homedir(), ".workflow-suite", "session.json");
const DEFAULT_TTL = 1500; // 25 minutes
const PROBE_TIMEOUT_MS = 15_000;

/** Whether the server currently honours a cookie. `unknown` = could not tell. */
export type ProbeVerdict = "live" | "dead" | "unknown";

/** Result of checking the cached cookie against the server. */
export type CacheCheck =
  | { state: "none" }
  | { state: ProbeVerdict; cookie: string };

/**
 * Ask the SiteMinder-protected page whether it honours `cookie`. A redirect
 * into the login flow or a 401/403 is `dead`; a transport error or 5xx is
 * `unknown` so a network blip never discards a working session.
 */
export async function probeSession(
  cookie: string,
  probeUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<ProbeVerdict> {
  try {
    const response = await fetchImpl(probeUrl, {
      headers: { Cookie: `SMSESSION=${cookie}`, "User-Agent": BROWSER_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const { status } = response;
    if (status === 401 || status === 403) return "dead";
    if (status >= 300 && status < 400) {
      return isLoginRedirect(status, response.headers.get("location") ?? "") ? "dead" : "live";
    }
    if (status >= 200 && status < 300) return "live";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Manages SMSESSION cookie lifecycle: cache, refresh, and browser-based capture.
 *
 * Ported from confluence_mcp.py SessionManager (lines 72-225).
 * All three Atlassian services (Confluence, Jira, Bitbucket) sit behind
 * SiteMinder SSO at apps.example.gov.bc.ca, so one SMSESSION works for all.
 */
export class SessionManager {
  private smsession: string | null = null;
  private config: AuthConfig;

  constructor(config?: Partial<AuthConfig>) {
    this.config = {
      targetUrl:
        config?.targetUrl ??
        process.env["CONFLUENCE_URL"] ??
        // ATLASSIAN_BASE_URL is usually the BWA API host, where a browser
        // capture can never mint SMSESSION — map it to the SSO web host.
        (process.env["ATLASSIAN_BASE_URL"]
          ? `${siteMinderWebUrl(process.env["ATLASSIAN_BASE_URL"])}/int/confluence`
          : "https://apps.example.gov.bc.ca/int/confluence"),
      cachePath: config?.cachePath ?? DEFAULT_CACHE_PATH,
      sessionTtlSeconds: config?.sessionTtlSeconds ?? DEFAULT_TTL,
      lockPath: config?.lockPath,
    };
  }

  /**
   * Get a valid SMSESSION cookie.
   * Checks: in-memory -> disk cache -> env var -> browser auth.
   */
  async getSession(): Promise<string> {
    // 1. In-memory
    if (this.smsession) return this.smsession;

    // 2. Disk cache
    const cached = await readCachedSession(
      this.config.cachePath,
      this.config.sessionTtlSeconds,
    );
    if (cached) {
      this.smsession = cached;
      this.log("Loaded cached SMSESSION from disk");
      return cached;
    }

    // 3. Environment variable
    const envCookie = process.env["SMSESSION"];
    if (isUsableSmsession(envCookie)) {
      this.smsession = envCookie;
      await writeCachedSession(this.config.cachePath, envCookie);
      this.log("Loaded SMSESSION from environment variable");
      return envCookie;
    }

    // 4. Check the old Python Confluence MCP cache as fallback
    const legacyCachePath = join(homedir(), ".confluence-mcp", "session.json");
    const legacyCached = await readCachedSession(
      legacyCachePath,
      this.config.sessionTtlSeconds,
    );
    if (legacyCached) {
      this.smsession = legacyCached;
      await writeCachedSession(this.config.cachePath, legacyCached);
      this.log("Loaded SMSESSION from legacy confluence-mcp cache");
      return legacyCached;
    }

    // 5. Browser authentication (interactive - requires a visible desktop)
    return this.authenticate();
  }

  /**
   * Open a browser window for SiteMinder authentication.
   * Runs Playwright in a subprocess to avoid conflicts with the MCP
   * server's stdio transport (Playwright must not write to stdout).
   *
   * The capture navigates to the protected Confluence dashboard — the REST
   * endpoints answer anonymous requests, so probing them never triggers the
   * SiteMinder challenge and no SMSESSION is minted. It runs on the shared
   * persistent profile, so an existing identity-provider session usually
   * completes the flow with no typing; when a full login is needed,
   * credentials autofill from the environment and only the MFA prompt is
   * left to the human.
   *
   * Captures are serialised across processes: Chromium lets one process own
   * the persistent profile, and several MCP servers can hit expiry at once.
   * Having won the lock, this re-checks the cache first, so a waiter adopts
   * the login the previous owner just finished rather than opening a second
   * browser.
   */
  async authenticate(): Promise<string> {
    const profileDir = authProfileDir();
    await ensureProfileDir(profileDir);

    return withAuthLock(this.config.lockPath ?? authLockPath(), async () => {
      const adopted = await readCachedSession(
        this.config.cachePath,
        this.config.sessionTtlSeconds
      );
      if (adopted) {
        this.smsession = adopted;
        this.log("Adopted the session another process just captured");
        return adopted;
      }
      return this.captureSession(profileDir);
    });
  }

  /** Run the browser capture and cache the result. Callers hold the auth lock. */
  private async captureSession(profileDir: string): Promise<string> {
    this.log("Starting browser authentication flow...");

    const credentials = resolveAutofillCredentials(process.env);
    const probeUrl = siteMinderProbeUrl(this.config.targetUrl);

    const script = buildCaptureScript({
      targetUrl: probeUrl,
      cookieNames: ["SMSESSION"],
      profileDir,
      userAgent: BROWSER_USER_AGENT,
      navTimeoutMs: 120_000,
      pollBudgetMs: 120_000,
      // The persistent profile can already hold a dead SMSESSION; only accept
      // one the protected page actually honours.
      verifyUrl: probeUrl,
      autofill: credentials !== null,
    });

    try {
      // Run from the monorepo root so require('playwright') resolves
      // from the hoisted node_modules regardless of the caller's cwd.
      const monorepoRoot = join(__dirname, "..", "..", "..");
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 180_000,
        cwd: monorepoRoot,
        stdio: ["ignore", "pipe", process.env["RAVEN_AUTH_DEBUG"] ? "inherit" : "pipe"],
        env: {
          ...process.env,
          // Ensure Playwright finds its browsers
          PLAYWRIGHT_BROWSERS_PATH:
            process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? undefined,
          // Autofill credentials travel via the environment, never argv or
          // the script text.
          ...(credentials
            ? {
                RAVEN_AUTOFILL_USERNAME: credentials.username,
                RAVEN_AUTOFILL_PASSWORD: credentials.password,
              }
            : {}),
        },
      });

      const parsed: CaptureResult = JSON.parse(result.trim());
      const smsession = parsed.cookies?.["SMSESSION"];

      if (parsed.status !== "ok" || !isUsableSmsession(smsession)) {
        throw new Error(
          parsed.message ?? "Authentication failed: no cookie captured",
        );
      }

      this.smsession = smsession;
      await writeCachedSession(this.config.cachePath, smsession);
      this.log("SMSESSION captured via browser auth");
      return smsession;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown authentication error";
      throw new Error(
        `No valid SMSESSION found. Browser auth failed: ${msg}\n\n` +
          `To fix this, run one of:\n` +
          `  1. "${process.execPath}" "${authCliPath}" (opens browser for IDIR login)\n` +
          `     add --force to re-login even if the cached session looks fresh\n` +
          `  2. Set SMSESSION env var  (paste cookie value from browser DevTools)\n\n` +
          `The session caches to ~/.workflow-suite/session.json for 25 minutes.`,
      );
    }
  }

  /**
   * Check the cached cookie against the server rather than trusting its age:
   * a cookie can be minutes old and already dead server-side.
   *
   * @param fetchImpl - Override the transport (tests).
   */
  async checkCache(fetchImpl?: typeof fetch): Promise<CacheCheck> {
    const cookie = await readCachedSession(
      this.config.cachePath,
      this.config.sessionTtlSeconds
    );
    if (!cookie) return { state: "none" };

    const state = await probeSession(
      cookie,
      siteMinderProbeUrl(this.config.targetUrl),
      fetchImpl
    );
    return { state, cookie };
  }

  /**
   * Invalidate the current session (e.g., on 302/expiry detection).
   *
   * Pass the cookie that just failed: the disk cache is then removed only if
   * it still holds that cookie. Long-lived MCP servers keep their cookie in
   * memory, so a re-login done elsewhere (the CLI, a sibling server) would
   * otherwise be deleted here and the next call would launch another browser
   * instead of adopting it.
   */
  async invalidate(failedCookie?: string): Promise<void> {
    this.smsession = null;
    if (failedCookie === undefined) {
      await clearCachedSession(this.config.cachePath);
      this.log("Session invalidated");
      return;
    }

    const removed = await clearCachedSessionIf(this.config.cachePath, failedCookie);
    this.log(
      removed
        ? "Session invalidated"
        : "Session invalidated (kept a newer cached login)"
    );
  }

  /** User agent string for HTTP requests (matches Playwright browser) */
  get userAgent(): string {
    return BROWSER_USER_AGENT;
  }

  private log(message: string): void {
    process.stderr.write(`[raven-auth] ${message}\n`);
  }
}
