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
  CAPTURE_MAX_BUFFER,
  CAPTURE_TIMINGS,
  authLockPath,
  authProfileDir,
  buildCaptureScript,
  captureChildEnv,
  captureFailureHint,
  describeCaptureFailure,
  ensureProfileDir,
  isEnvFlagOn,
  isLoginRedirect,
  resolveAutofillCredentials,
  siteMinderProbeUrl,
  siteMinderWebUrl,
  type CaptureResult,
} from "./capture-script.js";
import {
  AUTH_FAILURE_COOLDOWN_MS,
  clearAuthFailure,
  readRecentAuthFailure,
  recordAuthFailure,
} from "./auth-failure-memo.js";
import { withAuthLock } from "./auth-lock.js";
import type { AuthConfig, AuthenticateOptions } from "./types.js";
import { BROWSER_USER_AGENT } from "./browser-ua.js";
import { authCliPath } from "./auth-cli-path.js";

const DEFAULT_CACHE_PATH = join(homedir(), ".workflow-suite", "session.json");
const DEFAULT_TTL = 1500; // 25 minutes
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The standard "no valid session" failure. The MCP tool instructions tell the
 * model to look for the words "No valid SMSESSION found" and relay the fix, so
 * every way a login can fail, including not getting the browser-login lock in
 * time, is reported in this one form.
 */
class SessionAuthError extends Error {}

/** An environment variable's value, with blank treated as unset. */
const envValue = (name: string): string | undefined => process.env[name]?.trim() || undefined;

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
  let response: Response;
  try {
    response = await fetchImpl(probeUrl, {
      headers: { Cookie: `SMSESSION=${cookie}`, "User-Agent": BROWSER_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return "unknown";
  }

  try {
    const { status } = response;
    if (status === 401 || status === 403) return "dead";
    if (status >= 300 && status < 400) {
      return isLoginRedirect(status, response.headers.get("location") ?? "") ? "dead" : "live";
    }
    if (status >= 200 && status < 300) return "live";
    return "unknown";
  } finally {
    // The status is all that is needed. Without this a large page keeps
    // streaming and holds the caller (the CLI) open until it has finished.
    await response.body?.cancel().catch(() => {});
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
    // A browser capture can only mint SMSESSION on the SSO web host, never on
    // the BWA API host, so an environment URL pointing at BWA is mapped to the
    // SSO host. An explicit config.targetUrl is the caller's choice and is
    // used as given.
    const confluenceUrl = envValue("CONFLUENCE_URL");
    const atlassianBaseUrl = envValue("ATLASSIAN_BASE_URL");
    this.config = {
      targetUrl:
        config?.targetUrl ??
        (confluenceUrl
          ? siteMinderWebUrl(confluenceUrl)
          : atlassianBaseUrl
            ? `${siteMinderWebUrl(atlassianBaseUrl)}/int/confluence`
            : "https://apps.example.gov.bc.ca/int/confluence"),
      cachePath: config?.cachePath ?? DEFAULT_CACHE_PATH,
      sessionTtlSeconds: config?.sessionTtlSeconds ?? DEFAULT_TTL,
      lockPath: config?.lockPath,
      lockOptions: config?.lockOptions,
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
      await this.cacheSession(envCookie, false);
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
      await this.cacheSession(legacyCached, false);
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
   *
   * Every failure, including not getting the lock in time, is reported as a
   * "No valid SMSESSION found" error (see {@link SessionAuthError}).
   *
   * @param options - `interactive` marks an explicit request from a person (see
   *   {@link AuthenticateOptions}); unattended callers leave it unset.
   */
  async authenticate(options: AuthenticateOptions = {}): Promise<string> {
    try {
      const profileDir = authProfileDir();
      await ensureProfileDir(profileDir);

      return await withAuthLock(
        this.config.lockPath ?? authLockPath(),
        async () => {
          const adopted = await readCachedSession(
            this.config.cachePath,
            this.config.sessionTtlSeconds
          );
          if (adopted) {
            this.smsession = adopted;
            this.log("Adopted the session another process just captured");
            return adopted;
          }
          // A login that just failed was seen by everyone queued behind it; do
          // not open another window (and autofill the password again) for each.
          // A person who runs the login command is the retry, so it is exempt.
          if (!options.interactive) {
            const recent = await readRecentAuthFailure(this.failureMemoPath(), AUTH_FAILURE_COOLDOWN_MS);
            if (recent) throw this.failure(this.cooldownDetail(recent));
          }
          return this.captureSession(profileDir, options);
        },
        {
          onWait: () => this.log("Another RAVEN login is in progress; waiting for it to finish..."),
          ...this.config.lockOptions,
        }
      );
    } catch (err) {
      throw err instanceof SessionAuthError ? err : this.authFailure(err);
    }
  }

  /** Run the browser capture and cache the result. Callers hold the auth lock. */
  private async captureSession(profileDir: string, options: AuthenticateOptions): Promise<string> {
    this.log("Starting browser authentication flow...");

    const credentials = resolveAutofillCredentials(process.env);
    const probeUrl = siteMinderProbeUrl(this.config.targetUrl);
    const debug = isEnvFlagOn(process.env["RAVEN_AUTH_DEBUG"]);
    const timings = CAPTURE_TIMINGS.siteMinder;

    const script = buildCaptureScript({
      targetUrl: probeUrl,
      cookieNames: ["SMSESSION"],
      profileDir,
      userAgent: BROWSER_USER_AGENT,
      navTimeoutMs: timings.navTimeoutMs,
      pollBudgetMs: timings.pollBudgetMs,
      // The persistent profile can already hold a dead SMSESSION; only accept
      // one the protected page actually honours.
      verifyUrl: probeUrl,
      debug,
      autofill: credentials !== null,
    });

    let smsession: string;
    try {
      // Run from the monorepo root so require('playwright') resolves
      // from the hoisted node_modules regardless of the caller's cwd.
      const monorepoRoot = join(__dirname, "..", "..", "..");
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: timings.processTimeoutMs,
        maxBuffer: CAPTURE_MAX_BUFFER,
        cwd: monorepoRoot,
        stdio: ["ignore", "pipe", debug ? "inherit" : "pipe"],
        env: captureChildEnv(process.env, credentials),
      });

      const parsed: CaptureResult = JSON.parse(result.trim());
      const captured = parsed.cookies?.["SMSESSION"];

      if (parsed.status !== "ok" || !isUsableSmsession(captured)) {
        throw new Error(
          parsed.message ?? "Authentication failed: no cookie captured",
        );
      }
      smsession = captured;
    } catch (err) {
      await recordAuthFailure(this.failureMemoPath(), describeCaptureFailure(err));
      throw this.authFailure(err);
    }

    // The login is verified. For an unattended caller, failing to cache it
    // must not turn it into a failed login: keep it for this process and carry on.
    this.smsession = smsession;
    await clearAuthFailure(this.failureMemoPath());
    await this.cacheSession(smsession, options.interactive === true);
    this.log("SMSESSION captured via browser auth");
    return smsession;
  }

  /** Where a failed login is remembered: beside the capture lock, one file per product. */
  private failureMemoPath(): string {
    return `${this.config.lockPath ?? authLockPath()}.siteminder-failed`;
  }

  /** Say why a login is not being attempted right now. */
  private cooldownDetail(recent: { at: number; message: string }): string {
    const ago = Math.max(0, Math.round((Date.now() - recent.at) / 1000));
    const wait = Math.max(1, Math.ceil((AUTH_FAILURE_COOLDOWN_MS - (Date.now() - recent.at)) / 1000));
    return (
      `A browser login just failed ${ago}s ago (${recent.message}); not opening another for ${wait}s ` +
      `so queued requests do not each start their own. The login command below ignores this wait.`
    );
  }

  /** Build the standard "No valid SMSESSION found" error from a failure's cause. */
  private authFailure(err: unknown): SessionAuthError {
    return this.failure(describeCaptureFailure(err));
  }

  /** Build the standard "No valid SMSESSION found" error with the ways to fix it. */
  private failure(detail: string): SessionAuthError {
    const hint = captureFailureHint(detail);
    return new SessionAuthError(
      `No valid SMSESSION found. Browser auth failed: ${detail}\n` +
        (hint ? `${hint}\n` : "") +
        `\n` +
        `To fix this, run one of:\n` +
        `  1. "${process.execPath}" "${authCliPath}" (opens browser for IDIR login)\n` +
        `     add --force to re-login even if the cached session looks fresh\n` +
        `  2. Set SMSESSION env var  (paste cookie value from browser DevTools)\n\n` +
        `The session caches to ~/.workflow-suite/session.json for 25 minutes.`,
    );
  }

  /**
   * Cache a session. A failure is logged, not thrown, unless `required`: for an
   * unattended caller a missing cache costs a later login, not the session in
   * hand, but the login command's whole purpose is to leave one in the cache.
   */
  private async cacheSession(cookie: string, required: boolean): Promise<void> {
    try {
      await writeCachedSession(this.config.cachePath, cookie);
    } catch (err) {
      const reason = describeCaptureFailure(err);
      if (required) throw new Error(`The login succeeded but the session could not be saved: ${reason}`);
      this.log(`Could not cache the session (${reason}); using it for this process only`);
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
   *
   * @returns true when the cache is gone afterwards (removed, or there was
   *   none); false when it was left in place: a newer login replaced the cookie
   *   that failed, or the file could not be read or removed. With no argument the
   *   cache is removed whatever it holds, so false means it could not be removed.
   */
  async invalidate(failedCookie?: string): Promise<boolean> {
    this.smsession = null;
    const removed =
      failedCookie === undefined
        ? await clearCachedSession(this.config.cachePath)
        : await clearCachedSessionIf(this.config.cachePath, failedCookie);
    this.log(
      removed
        ? "Session invalidated"
        : "Session invalidated in memory; the cache was left as it is " +
            "(a newer login, or a file that could not be read or removed)"
    );
    return removed;
  }

  /** User agent string for HTTP requests (matches Playwright browser) */
  get userAgent(): string {
    return BROWSER_USER_AGENT;
  }

  private log(message: string): void {
    process.stderr.write(`[raven-auth] ${message}\n`);
  }
}
