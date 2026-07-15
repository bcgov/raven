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
import type { AuthConfig, AuthResult } from "./types.js";

const DEFAULT_CACHE_PATH = join(homedir(), ".workflow-suite", "session.json");
const DEFAULT_TTL = 1500; // 25 minutes

/** User-agent string, selected by host OS so SiteMinder does not get a mismatched UA. */
function buildUserAgent(): string {
  switch (process.platform) {
    case "win32":
      return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
      );
    case "linux":
      return (
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
      );
    default: // darwin and others
      return (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
      );
  }
}
const BROWSER_USER_AGENT = buildUserAgent();

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
        (process.env["ATLASSIAN_BASE_URL"]
          ? `${process.env["ATLASSIAN_BASE_URL"]}/int/confluence`
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
   */
  async authenticate(): Promise<string> {
    this.log("Starting browser authentication flow...");

    const targetUrl = this.config.targetUrl;

    // Playwright script runs in a separate Node.js process.
    // It navigates to a protected resource, waits for the user to
    // authenticate via IDIR, then captures the SMSESSION cookie.
    const script = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: ${JSON.stringify(BROWSER_USER_AGENT)},
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  let smsessionValue = null;

  await page.goto(
    ${JSON.stringify(targetUrl + "/rest/api/space?limit=1")},
    { waitUntil: 'networkidle', timeout: 120000 }
  );

  const startTime = Date.now();
  while (Date.now() - startTime < 120000) {
    const cookies = await context.cookies();
    for (const cookie of cookies) {
      if (cookie.name === 'SMSESSION') {
        smsessionValue = cookie.value;
        break;
      }
    }

    if (smsessionValue) break;

    const currentUrl = page.url();
    if (currentUrl.includes('/int/confluence/') && !currentUrl.toLowerCase().includes('logon')) {
      const cookies2 = await context.cookies();
      for (const cookie of cookies2) {
        if (cookie.name === 'SMSESSION') {
          smsessionValue = cookie.value;
          break;
        }
      }
      if (smsessionValue) break;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();

  if (smsessionValue) {
    console.log(JSON.stringify({ status: 'ok', smsession: smsessionValue }));
  } else {
    console.log(JSON.stringify({ status: 'error', message: 'No SMSESSION cookie captured within 120s' }));
  }
})();
`;

    try {
      // Run from the monorepo root so require('playwright') resolves
      // from the hoisted node_modules regardless of the caller's cwd.
      const monorepoRoot = join(__dirname, "..", "..", "..");
      const result = execFileSync("node", ["-e", script], {
        encoding: "utf-8",
        timeout: 180_000,
        cwd: monorepoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Ensure Playwright finds its browsers
          PLAYWRIGHT_BROWSERS_PATH:
            process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? undefined,
        },
      });

      const parsed: AuthResult = JSON.parse(result.trim());

      if (parsed.status !== "ok" || !parsed.smsession) {
        throw new Error(
          parsed.message ?? "Authentication failed: no cookie captured"
        );
      }

      this.smsession = parsed.smsession;
      await writeCachedSession(this.config.cachePath, parsed.smsession);
      this.log("SMSESSION captured via browser auth");
      return parsed.smsession;
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
