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
import type { SpoAuthConfig, SpoAuthResult, SpoCookies } from "./types.js";
import { BROWSER_USER_AGENT } from "./browser-ua.js";

const DEFAULT_CACHE_PATH = join(homedir(), ".workflow-suite", "spo-session.json");
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
      this.config.sessionTtlSeconds
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
   */
  async authenticate(): Promise<SpoCookies> {
    this.log("Starting SPO browser authentication flow...");

    const targetUrl = this.config.targetUrl;

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

  // Entra's device-auth hop (device.login.microsoftonline.com) intermittently
  // drops the first connection in automated Chromium with
  // net::ERR_SOCKET_NOT_CONNECTED; a plain reload succeeds. Auto-retry failed
  // main-frame navigations so the user never has to refresh the error page.
  let navRetries = 0;
  page.on('requestfailed', (request) => {
    try {
      if (!request.isNavigationRequest()) return;
      if (request.frame() !== page.mainFrame()) return;
      const failure = request.failure();
      if (failure && failure.errorText === 'net::ERR_ABORTED') return;
      if (navRetries >= 3) return;
      navRetries += 1;
      setTimeout(() => { page.reload().catch(() => {}); }, 750);
    } catch {}
  });

  try {
    await page.goto(${JSON.stringify(targetUrl)}, { waitUntil: 'networkidle', timeout: 120000 });
  } catch (navErr) {
    const navMsg = navErr && navErr.message ? String(navErr.message) : String(navErr);
    const isTransientNet = navMsg.indexOf('net::ERR_') !== -1;
    const isTimeout = navErr && navErr.name === 'TimeoutError';
    if (!isTransientNet && !isTimeout) {
      await browser.close().catch(() => {});
      console.log(JSON.stringify({ status: 'error', message: 'Navigation failed: ' + navMsg.split('\\n')[0] }));
      return;
    }
    // net::ERR_* drops are reloaded by the requestfailed handler above, and a
    // goto timeout can coexist with a login the user already completed — the
    // cookie poll below is the authoritative success signal for both.
  }

  let fedAuth = null;
  let rtFa = null;
  const startTime = Date.now();
  while (Date.now() - startTime < 180000) {
    const cookies = await context.cookies();
    for (const cookie of cookies) {
      if (!cookie.domain || cookie.domain.indexOf('sharepoint.com') === -1) continue;
      if (cookie.name === 'FedAuth') fedAuth = cookie.value;
      if (cookie.name === 'rtFa') rtFa = cookie.value;
    }
    if (fedAuth && rtFa) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();

  if (fedAuth && rtFa) {
    console.log(JSON.stringify({ status: 'ok', fedAuth, rtFa }));
  } else {
    console.log(JSON.stringify({ status: 'error', message: 'FedAuth/rtFa cookies not captured within 180s' }));
  }
})();
`;

    try {
      // Run from the monorepo root so require('playwright') resolves
      // from the hoisted node_modules regardless of the caller's cwd.
      const monorepoRoot = join(__dirname, "..", "..", "..");
      const result = execFileSync("node", ["-e", script], {
        encoding: "utf-8",
        timeout: 240_000,
        cwd: monorepoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH:
            process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? undefined,
        },
      });

      const parsed: SpoAuthResult = JSON.parse(result.trim());

      if (parsed.status !== "ok" || !parsed.fedAuth || !parsed.rtFa) {
        throw new Error(
          parsed.message ?? "Authentication failed: cookies not captured"
        );
      }

      const pair: SpoCookies = { fedAuth: parsed.fedAuth, rtFa: parsed.rtFa };
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
          `  1. npx raven-auth --sharepoint   (opens browser for IDIR/Entra login)\n` +
          `  2. Set SPO_FEDAUTH and SPO_RTFA env vars (paste cookie values from browser DevTools)\n\n` +
          `The session caches to ~/.workflow-suite/spo-session.json for 8 hours.`
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
