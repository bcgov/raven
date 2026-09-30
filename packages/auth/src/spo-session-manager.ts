import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  readCachedSpoSession,
  writeCachedSpoSession,
  clearCachedSpoSession,
} from "./spo-cookie-cache.js";
import {
  authProfileDir,
  buildCaptureScript,
  ensureProfileDir,
  resolveAutofillCredentials,
  type CaptureResult,
} from "./capture-script.js";
import type { SpoAuthConfig, SpoCookies } from "./types.js";
import { BROWSER_USER_AGENT } from "./browser-ua.js";
import { authCliPath } from "./auth-cli-path.js";

const DEFAULT_CACHE_PATH = join(
  homedir(),
  ".workflow-suite",
  "spo-session.json",
);
const DEFAULT_TTL = 28800; // 8 hours

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

    const envFedAuth = process.env["SPO_FEDAUTH"];
    const envRtFa = process.env["SPO_RTFA"];
    if (envFedAuth && envRtFa) {
      const pair: SpoCookies = { fedAuth: envFedAuth, rtFa: envRtFa };
      this.cookies = pair;
      await writeCachedSpoSession(this.config.cachePath, pair, this.host());
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
   */
  async authenticate(): Promise<SpoCookies> {
    this.log("Starting SPO browser authentication flow...");

    const profileDir = authProfileDir();
    await ensureProfileDir(profileDir);
    const credentials = resolveAutofillCredentials(process.env);

    const script = buildCaptureScript({
      targetUrl: this.config.targetUrl,
      cookieNames: ["FedAuth", "rtFa"],
      cookieDomainFilter: "sharepoint.com",
      profileDir,
      userAgent: BROWSER_USER_AGENT,
      navTimeoutMs: 120_000,
      pollBudgetMs: 180_000,
      autofill: credentials !== null,
    });

    try {
      // Run from the monorepo root so require('playwright') resolves
      // from the hoisted node_modules regardless of the caller's cwd.
      const monorepoRoot = join(__dirname, "..", "..", "..");
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 240_000,
        cwd: monorepoRoot,
        stdio: ["ignore", "pipe", process.env["RAVEN_AUTH_DEBUG"] ? "inherit" : "pipe"],
        env: {
          ...process.env,
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
      const fedAuth = parsed.cookies?.["FedAuth"];
      const rtFa = parsed.cookies?.["rtFa"];

      if (parsed.status !== "ok" || !fedAuth || !rtFa) {
        throw new Error(
          parsed.message ?? "Authentication failed: cookies not captured",
        );
      }

      const pair: SpoCookies = { fedAuth, rtFa };
      this.cookies = pair;
      await writeCachedSpoSession(this.config.cachePath, pair, this.host());
      this.log("FedAuth/rtFa captured via browser auth");
      return pair;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown authentication error";
      throw new Error(
        `No valid SharePoint session found. Browser auth failed: ${msg}\n\n` +
          `To fix this, run one of:\n` +
          `  1. "${process.execPath}" "${authCliPath}" --sharepoint (opens browser for IDIR/Entra login)\n` +
          `  2. Set SPO_FEDAUTH and SPO_RTFA env vars (paste cookie values from browser DevTools)\n\n` +
          `The session caches to ~/.workflow-suite/spo-session.json for 8 hours.`,
      );
    }
  }

  /** Invalidate the current session (e.g., on expiry detection). */
  async invalidate(): Promise<void> {
    this.cookies = null;
    await clearCachedSpoSession(this.config.cachePath);
    this.log("SPO session invalidated");
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
