import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  readCachedSession,
  writeCachedSession,
  clearCachedSession,
} from "./cookie-cache.js";
import {
  authProfileDir,
  buildCaptureScript,
  ensureProfileDir,
  resolveAutofillCredentials,
  siteMinderProbeUrl,
  siteMinderWebUrl,
  type CaptureResult,
} from "./capture-script.js";
import type { AuthConfig } from "./types.js";
import { BROWSER_USER_AGENT } from "./browser-ua.js";

const DEFAULT_CACHE_PATH = join(homedir(), ".workflow-suite", "session.json");
const DEFAULT_TTL = 1500; // 25 minutes

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
      this.config.sessionTtlSeconds
    );
    if (cached) {
      this.smsession = cached;
      this.log("Loaded cached SMSESSION from disk");
      return cached;
    }

    // 3. Environment variable
    const envCookie = process.env["SMSESSION"];
    if (envCookie) {
      this.smsession = envCookie;
      await writeCachedSession(this.config.cachePath, envCookie);
      this.log("Loaded SMSESSION from environment variable");
      return envCookie;
    }

    // 4. Check the old Python Confluence MCP cache as fallback
    const legacyCachePath = join(homedir(), ".confluence-mcp", "session.json");
    const legacyCached = await readCachedSession(
      legacyCachePath,
      this.config.sessionTtlSeconds
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
   */
  async authenticate(): Promise<string> {
    this.log("Starting browser authentication flow...");

    const profileDir = authProfileDir();
    await ensureProfileDir(profileDir);
    const credentials = resolveAutofillCredentials(process.env);

    const script = buildCaptureScript({
      targetUrl: siteMinderProbeUrl(this.config.targetUrl),
      cookieNames: ["SMSESSION"],
      profileDir,
      userAgent: BROWSER_USER_AGENT,
      navTimeoutMs: 120_000,
      pollBudgetMs: 120_000,
      autofill: credentials !== null,
    });

    try {
      // Run from the monorepo root so require('playwright') resolves
      // from the hoisted node_modules regardless of the caller's cwd.
      const monorepoRoot = join(__dirname, "..", "..", "..");
      const result = execFileSync("node", ["-e", script], {
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

      if (parsed.status !== "ok" || !smsession) {
        throw new Error(
          parsed.message ?? "Authentication failed: no cookie captured"
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
        `  1. npx raven-auth          (opens browser for IDIR login)\n` +
        `  2. Set SMSESSION env var  (paste cookie value from browser DevTools)\n\n` +
        `The session caches to ~/.workflow-suite/session.json for 25 minutes.`
      );
    }
  }

  /**
   * Invalidate the current session (e.g., on 302/expiry detection).
   */
  async invalidate(): Promise<void> {
    this.smsession = null;
    await clearCachedSession(this.config.cachePath);
    this.log("Session invalidated");
  }

  /** User agent string for HTTP requests (matches Playwright browser) */
  get userAgent(): string {
    return BROWSER_USER_AGENT;
  }

  private log(message: string): void {
    process.stderr.write(`[raven-auth] ${message}\n`);
  }
}
