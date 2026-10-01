import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  isUsableSpoPair,
  readCachedSpoSession,
  writeCachedSpoSession,
  clearCachedSpoSession,
  clearCachedSpoSessionIf,
} from "./spo-cookie-cache.js";
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
  resolveAutofillCredentials,
  type CaptureResult,
} from "./capture-script.js";
import {
  AUTH_FAILURE_COOLDOWN_MS,
  clearAuthFailure,
  readRecentAuthFailure,
  recordAuthFailure,
} from "./auth-failure-memo.js";
import { withAuthLock } from "./auth-lock.js";
import type { AuthenticateOptions, SpoAuthConfig, SpoCookies } from "./types.js";
import { BROWSER_USER_AGENT } from "./browser-ua.js";
import { authCliPath } from "./auth-cli-path.js";

const DEFAULT_CACHE_PATH = join(
  homedir(),
  ".workflow-suite",
  "spo-session.json",
);
const DEFAULT_TTL = 28800; // 8 hours

/**
 * The standard "no valid SharePoint session" failure. The MCP tool
 * instructions key on its first words, so every way a login can fail,
 * including not getting the browser-login lock in time, is reported in this
 * one form.
 */
class SpoAuthError extends Error {}

/**
 * Manages the SharePoint Online FedAuth/rtFa cookie pair: cache, refresh,
 * and browser-based capture. SPO twin of SessionManager (SMSESSION).
 *
 * FedAuth is scoped to the tenant host (e.g. example.sharepoint.com);
 * rtFa spans SharePoint and enables silent re-auth. Both are required.
 */
export class SpoSessionManager {
  private cookies: SpoCookies | null = null;
  private config: SpoAuthConfig;

  constructor(config?: Partial<SpoAuthConfig>) {
    this.config = {
      targetUrl:
        config?.targetUrl ??
        process.env["SHAREPOINT_URL"] ??
        "https://example.sharepoint.com",
      cachePath: config?.cachePath ?? DEFAULT_CACHE_PATH,
      sessionTtlSeconds:
        config?.sessionTtlSeconds ??
        (Number(process.env["SHAREPOINT_SESSION_TTL"]) || DEFAULT_TTL),
      lockPath: config?.lockPath,
      lockOptions: config?.lockOptions,
    };
  }

  /**
   * Get a valid cookie pair.
   * Checks: in-memory -> disk cache -> env vars -> browser auth.
   */
  async getSession(): Promise<SpoCookies> {
    if (this.cookies) return this.cookies;

    const cached = await readCachedSpoSession(
      this.config.cachePath,
      this.config.sessionTtlSeconds,
    );
    if (cached) {
      this.cookies = cached;
      this.log("Loaded cached SPO session from disk");
      return cached;
    }

    const envPair = { fedAuth: process.env["SPO_FEDAUTH"], rtFa: process.env["SPO_RTFA"] };
    if (isUsableSpoPair(envPair)) {
      const pair: SpoCookies = envPair;
      this.cookies = pair;
      await this.cacheSession(pair, false);
      this.log("Loaded SPO session from environment variables");
      return pair;
    }

    return this.authenticate();
  }

  /**
   * Open a browser window for Entra/IDIR authentication against SharePoint
   * Online and capture the FedAuth + rtFa cookies. Runs Playwright in a
   * subprocess to avoid conflicts with the MCP server's stdio transport.
   *
   * The capture runs on the shared persistent profile, so an existing Entra
   * session usually completes the flow with no typing; when a full login is
   * needed, credentials autofill from the environment and only the MFA
   * prompt is left to the human.
   *
   * Shares the profile (and so the cross-process lock) with the SiteMinder
   * capture; after winning the lock it adopts a session another process just
   * cached instead of opening a second browser.
   *
   * Every failure, including not getting the lock in time, is reported as a
   * "No valid SharePoint session found" error (see {@link SpoAuthError}).
   *
   * @param options - `interactive` marks an explicit request from a person (see
   *   {@link AuthenticateOptions}); unattended callers leave it unset.
   */
  async authenticate(options: AuthenticateOptions = {}): Promise<SpoCookies> {
    try {
      const profileDir = authProfileDir();
      await ensureProfileDir(profileDir);

      return await withAuthLock(
        this.config.lockPath ?? authLockPath(),
        async () => {
          const adopted = await readCachedSpoSession(
            this.config.cachePath,
            this.config.sessionTtlSeconds,
          );
          if (adopted) {
            this.cookies = adopted;
            this.log("Adopted the SPO session another process just captured");
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
        },
      );
    } catch (err) {
      throw err instanceof SpoAuthError ? err : this.authFailure(err);
    }
  }

  /** Run the browser capture and cache the result. Callers hold the auth lock. */
  private async captureSession(profileDir: string, options: AuthenticateOptions): Promise<SpoCookies> {
    this.log("Starting SPO browser authentication flow...");

    const credentials = resolveAutofillCredentials(process.env);
    const debug = isEnvFlagOn(process.env["RAVEN_AUTH_DEBUG"]);
    const timings = CAPTURE_TIMINGS.sharePoint;

    const script = buildCaptureScript({
      targetUrl: this.config.targetUrl,
      cookieNames: ["FedAuth", "rtFa"],
      cookieDomainFilter: "sharepoint.com",
      profileDir,
      userAgent: BROWSER_USER_AGENT,
      navTimeoutMs: timings.navTimeoutMs,
      pollBudgetMs: timings.pollBudgetMs,
      debug,
      autofill: credentials !== null,
    });

    let pair: SpoCookies;
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
      const captured = { fedAuth: parsed.cookies?.["FedAuth"], rtFa: parsed.cookies?.["rtFa"] };

      if (parsed.status !== "ok" || !isUsableSpoPair(captured)) {
        throw new Error(
          parsed.message ?? "Authentication failed: cookies not captured",
        );
      }
      pair = captured;
    } catch (err) {
      await recordAuthFailure(this.failureMemoPath(), describeCaptureFailure(err));
      throw this.authFailure(err);
    }

    // The capture succeeded. For an unattended caller, failing to cache it
    // must not turn it into a failed login: keep it for this process and carry on.
    this.cookies = pair;
    await clearAuthFailure(this.failureMemoPath());
    await this.cacheSession(pair, options.interactive === true);
    this.log("FedAuth/rtFa captured via browser auth");
    return pair;
  }

  /** Where a failed login is remembered: beside the capture lock, one file per product. */
  private failureMemoPath(): string {
    return `${this.config.lockPath ?? authLockPath()}.sharepoint-failed`;
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

  /** Build the standard "No valid SharePoint session found" error from a failure's cause. */
  private authFailure(err: unknown): SpoAuthError {
    return this.failure(describeCaptureFailure(err));
  }

  /** Build the standard "No valid SharePoint session found" error with the ways to fix it. */
  private failure(detail: string): SpoAuthError {
    const hint = captureFailureHint(detail);
    return new SpoAuthError(
      `No valid SharePoint session found. Browser auth failed: ${detail}\n` +
        (hint ? `${hint}\n` : "") +
        `\n` +
        `To fix this, run one of:\n` +
        `  1. "${process.execPath}" "${authCliPath}" --sharepoint (opens browser for IDIR/Entra login)\n` +
        `     add --force to re-login even if the cached session looks fresh\n` +
        `  2. Set SPO_FEDAUTH and SPO_RTFA env vars (paste cookie values from browser DevTools)\n\n` +
        `The session caches to ~/.workflow-suite/spo-session.json for 8 hours.`,
    );
  }

  /**
   * Cache a pair. A failure is logged, not thrown, unless `required`: for an
   * unattended caller a missing cache costs a later login, not the session in
   * hand, but the login command's whole purpose is to leave one in the cache.
   */
  private async cacheSession(pair: SpoCookies, required: boolean): Promise<void> {
    try {
      await writeCachedSpoSession(this.config.cachePath, pair, this.host());
    } catch (err) {
      const reason = describeCaptureFailure(err);
      if (required) throw new Error(`The login succeeded but the session could not be saved: ${reason}`);
      this.log(`Could not cache the SPO session (${reason}); using it for this process only`);
    }
  }

  /**
   * Invalidate the current session (e.g., on expiry detection).
   *
   * Pass the pair that just failed: the disk cache is then removed only if it
   * still holds that pair. Long-lived MCP servers keep their pair in memory,
   * so a login another process cached since would otherwise be deleted here
   * and the next call would launch another browser instead of adopting it.
   *
   * @returns true when the cache will no longer hand out the pair that failed: it
   *   was removed, there was none, or a newer login replaced it (which is kept).
   *   false when the cache still holds that pair and could not be updated, so the
   *   next login would adopt it again. With no argument the cache is removed
   *   whatever it holds, so false means it could not be removed.
   */
  async invalidate(failedPair?: SpoCookies): Promise<boolean> {
    this.cookies = null;
    if (failedPair === undefined) {
      const removed = await clearCachedSpoSession(this.config.cachePath);
      this.log(removed ? "SPO session invalidated" : "SPO session invalidated in memory; the cache could not be removed");
      return removed;
    }

    if (await clearCachedSpoSessionIf(this.config.cachePath, failedPair)) {
      this.log("SPO session invalidated");
      return true;
    }
    // Left alone: a newer login replaced the pair (fine, it is adopted next), or the
    // cache still holds the pair that failed and could not be removed.
    const cached = await readCachedSpoSession(this.config.cachePath, this.config.sessionTtlSeconds);
    const stillCached = cached !== null && cached.fedAuth === failedPair.fedAuth && cached.rtFa === failedPair.rtFa;
    this.log(
      stillCached
        ? "SPO session invalidated in memory; the cache still holds it and could not be updated"
        : "SPO session invalidated in memory; the cache holds a newer login (or nothing usable) and was left as it is",
    );
    return !stillCached;
  }

  /** User agent string for HTTP requests (matches the Playwright browser). */
  get userAgent(): string {
    return BROWSER_USER_AGENT;
  }

  /** The SharePoint tenant root URL this manager authenticates against. */
  get targetUrl(): string {
    return this.config.targetUrl;
  }

  private host(): string {
    try {
      return new URL(this.config.targetUrl).hostname;
    } catch {
      return "sharepoint.com";
    }
  }

  private log(message: string): void {
    process.stderr.write(`[raven-auth] ${message}\n`);
  }
}
