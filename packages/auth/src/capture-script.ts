import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared builder for the interactive browser-capture scripts run by
 * SessionManager (SMSESSION) and SpoSessionManager (FedAuth/rtFa).
 *
 * The capture runs on a persistent Chromium profile so the identity
 * provider's "stay signed in" session survives between captures: after one
 * full login, later captures normally complete without any typing or MFA
 * until the IdP session expires. Credential autofill, when enabled, reads
 * the values from the subprocess environment (RAVEN_AUTOFILL_USERNAME /
 * RAVEN_AUTOFILL_PASSWORD) — never from the generated script text — and
 * fills only on the known identity-provider login hosts. The second factor
 * is deliberately never automated.
 */

/** The persistent Chromium profile shared by both capture flows. */
export function authProfileDir(): string {
  return join(homedir(), ".workflow-suite", "browser-profile");
}

/** Create (or re-tighten) the profile directory at mode 0700. */
export async function ensureProfileDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** A username/password pair for best-effort login autofill. */
export interface AutofillCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Resolve autofill credentials from the environment: the dedicated
 * IDIR_USERNAME/IDIR_PASSWORD pair first, else ATLASSIAN_EMAIL/
 * ATLASSIAN_PASSWORD (which already hold the same IDIR credentials for
 * the BWA Basic-auth route). RAVEN_AUTH_AUTOFILL=off disables autofill
 * entirely. Returns null when disabled or incomplete.
 */
export function resolveAutofillCredentials(
  env: Record<string, string | undefined>
): AutofillCredentials | null {
  if (env["RAVEN_AUTH_AUTOFILL"] === "off") return null;
  const username = env["IDIR_USERNAME"] ?? env["ATLASSIAN_EMAIL"];
  const password = env["IDIR_PASSWORD"] ?? env["ATLASSIAN_PASSWORD"];
  if (!username || !password) return null;
  return { username, password };
}

/**
 * The URL a SiteMinder capture must open. The Confluence REST endpoints
 * answer anonymous requests, so probing them never triggers the SiteMinder
 * challenge and no SMSESSION is minted; the dashboard is protected.
 */
export function siteMinderProbeUrl(targetUrl: string): string {
  return `${targetUrl.replace(/\/+$/, "")}/index.action`;
}

/**
 * Map a base URL to the SiteMinder-protected web host. The BWA host fronts
 * the same applications with an IDIR Basic realm for API clients — a
 * browser capture there dies on ERR_INVALID_AUTH_CREDENTIALS and SMSESSION
 * is never minted, because SiteMinder only challenges on the apps host.
 */
export function siteMinderWebUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname.startsWith("bwa.")) {
      url.hostname = `apps.${url.hostname.slice("bwa.".length)}`;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

/**
 * Locations that mean "you are being sent to log in": the SiteMinder/BC Gov
 * logon pages, the Entra login host, and SiteMinder's fedLaunch hop. Shared by
 * the Node-side session probe and the generated capture script so both judge a
 * cookie the same way.
 */
export const LOGIN_REDIRECT_PATTERN = /(?:login|logon|signin|siteminder|fedlaunch)/i;

/** Whether a response is a redirect into the login flow. */
export function isLoginRedirect(status: number, location: string): boolean {
  return status >= 300 && status < 400 && LOGIN_REDIRECT_PATTERN.test(location);
}

/** Options for {@link buildCaptureScript}. */
export interface CaptureScriptOptions {
  /** Full URL the capture navigates to (must trigger the login flow). */
  readonly targetUrl: string;
  /** Cookie names that constitute success, e.g. ["FedAuth", "rtFa"]. */
  readonly cookieNames: readonly string[];
  /** Restrict matches to cookies whose domain contains this string. */
  readonly cookieDomainFilter?: string;
  /** Persistent Chromium profile directory. */
  readonly profileDir: string;
  readonly userAgent: string;
  /** Navigation timeout (default 120s). */
  readonly navTimeoutMs?: number;
  /** Total budget for the cookie poll (default 180s). */
  readonly pollBudgetMs?: number;
  /** Delay between cookie polls (default 1s). */
  readonly pollIntervalMs?: number;
  /**
   * Protected URL used to confirm a captured cookie is honoured before it is
   * accepted. The persistent profile can hold a dead cookie from a previous
   * run, so "a cookie exists" is not evidence of a login. Omit to accept the
   * first real value (the SharePoint capture).
   */
  readonly verifyUrl?: string;
  /** Emit the credential-autofill routine. */
  readonly autofill: boolean;
}

const AUTOFILL_SNIPPET = `
  // Best-effort credential autofill, restricted to the identity providers'
  // own login pages. Values come from the environment, never from this
  // script. MFA prompts are left for the human on purpose.
  const AUTOFILL_HOSTS = ['login.microsoftonline.com', 'logon7.gov.bc.ca'];
  const AUTOFILL_MAX = 8;
  let autofillAttempts = 0;
  async function tryAutofill() {
    if (autofillAttempts >= AUTOFILL_MAX) return;
    const username = process.env.RAVEN_AUTOFILL_USERNAME;
    const password = process.env.RAVEN_AUTOFILL_PASSWORD;
    if (!username || !password) return;
    let host = '';
    try { host = new URL(page.url()).hostname; } catch {}
    if (!AUTOFILL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return;
    try {
      const userBox = page.locator('input[name="loginfmt"], input[type="email"], input[name="user"], input[name="username"], input#user').first();
      const passBox = page.locator('input[type="password"]').first();
      const submit = page.locator('#idSIButton9, input[type="submit"], button[type="submit"]').first();
      const passVisible = await passBox.isVisible({ timeout: 500 }).catch(() => false);
      const userVisible = await userBox.isVisible({ timeout: 500 }).catch(() => false);
      if (passVisible) {
        if (userVisible && !(await userBox.inputValue().catch(() => ''))) await userBox.fill(username);
        if (!(await passBox.inputValue().catch(() => ''))) {
          autofillAttempts += 1;
          await passBox.fill(password);
          await submit.click({ timeout: 1000 }).catch(() => {});
        }
      } else if (userVisible) {
        if (!(await userBox.inputValue().catch(() => ''))) {
          autofillAttempts += 1;
          await userBox.fill(username);
          await submit.click({ timeout: 1000 }).catch(() => {});
        }
      } else if (host.endsWith('login.microsoftonline.com')) {
        // "Stay signed in?" — answer Yes so the profile keeps the session.
        const kmsi = page.locator('#idSIButton9');
        if (await kmsi.isVisible({ timeout: 300 }).catch(() => false)) {
          autofillAttempts += 1;
          await kmsi.click({ timeout: 1000 }).catch(() => {});
        }
      }
    } catch {}
  }
  page.on('load', () => { tryAutofill().catch(() => {}); });
`;

/**
 * Generate the Playwright capture script executed via \`node -e\` in a
 * subprocess (Playwright must not share the caller's stdio). The script
 * prints exactly one JSON line: {status:'ok', cookies:{...}} or
 * {status:'error', message}.
 */
export function buildCaptureScript(opts: CaptureScriptOptions): string {
  const navTimeoutMs = opts.navTimeoutMs ?? 120_000;
  const pollBudgetMs = opts.pollBudgetMs ?? 180_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;

  return `
const { chromium } = require('playwright');

(async () => {
  const context = await chromium.launchPersistentContext(${JSON.stringify(opts.profileDir)}, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: ${JSON.stringify(opts.userAgent)},
    ignoreHTTPSErrors: true,
    viewport: null,
  });
  const page = context.pages()[0] ?? await context.newPage();
  if (process.env.RAVEN_AUTH_DEBUG) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) process.stderr.write('[capture] ' + frame.url().slice(0, 120) + '\\n');
    });
  }
${opts.autofill ? AUTOFILL_SNIPPET : ""}
  // Native dialogs (e.g. form-resubmission prompts on SAML POST hops) would
  // stall the flow invisibly; accept them.
  page.on('dialog', (dialog) => { dialog.accept().catch(() => {}); });

  // The identity hops intermittently drop the first connection in automated
  // Chromium with net::ERR_SOCKET_NOT_CONNECTED. Recover by restarting the
  // chain from the original target — reloading the failed page would re-POST
  // a SAML hop and stall on resubmission.
  let navRetries = 0;
  page.on('requestfailed', (request) => {
    try {
      if (!request.isNavigationRequest()) return;
      if (request.frame() !== page.mainFrame()) return;
      const failure = request.failure();
      if (failure && failure.errorText === 'net::ERR_ABORTED') return;
      if (navRetries >= 3) return;
      navRetries += 1;
      setTimeout(() => {
        page.goto(${JSON.stringify(opts.targetUrl)}, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }, 750);
    } catch {}
  });

  try {
    // domcontentloaded, never the idle-network signal: SSO redirect chains
    // and chatty login pages can keep the network busy for minutes, and the
    // cookie poll below is the real success signal anyway.
    await page.goto(${JSON.stringify(opts.targetUrl)}, { waitUntil: 'domcontentloaded', timeout: ${navTimeoutMs} });
  } catch (navErr) {
    const navMsg = navErr && navErr.message ? String(navErr.message) : String(navErr);
    if (process.env.RAVEN_AUTH_DEBUG) {
      process.stderr.write('[capture] goto failed: ' + navMsg.split('\\n')[0].slice(0, 200) + '\\n');
    }
    const isTransientNet = navMsg.indexOf('net::ERR_') !== -1;
    const isTimeout = navErr && navErr.name === 'TimeoutError';
    if (!isTransientNet && !isTimeout) {
      await context.close().catch(() => {});
      console.log(JSON.stringify({ status: 'error', message: 'Navigation failed: ' + navMsg.split('\\n')[0] }));
      return;
    }
    // Transient drops reload above; a goto timeout can coexist with a login
    // the user already completed — the cookie poll is the success signal.
  }

  const wanted = ${JSON.stringify(opts.cookieNames)};
  const domainFilter = ${opts.cookieDomainFilter ? JSON.stringify(opts.cookieDomainFilter) : "null"};
  const verifyUrl = ${opts.verifyUrl ? JSON.stringify(opts.verifyUrl) : "null"};
  const LOGIN_REDIRECT = new RegExp(${JSON.stringify(LOGIN_REDIRECT_PATTERN.source)}, 'i');

  // The persistent profile keeps cookies between runs, so the jar can already
  // hold SiteMinder's SMSESSION=LOGGEDOFF marker (or an expired real value)
  // before the user has logged in. Neither is a session: taking the first
  // value seen ended the capture before the login and cached a placeholder.
  const isDead = (value) => !value || String(value).trim().toUpperCase() === 'LOGGEDOFF';

  // Ask the protected page whether the server honours the cookies now in the
  // jar (the context's request API shares them). A redirect into the login
  // flow or a 401/403 means dead; a transport error or 5xx is "unknown" and
  // is re-checked rather than treated as either answer.
  async function probe() {
    try {
      const res = await context.request.get(verifyUrl, { maxRedirects: 0, failOnStatusCode: false, timeout: 15000 });
      const status = res.status();
      const location = (res.headers() || {})['location'] || '';
      if (status === 401 || status === 403) return 'dead';
      if (status >= 300 && status < 400) return LOGIN_REDIRECT.test(location) ? 'dead' : 'live';
      if (status >= 200 && status < 300) return 'live';
      return 'unknown';
    } catch (probeErr) {
      return 'unknown';
    }
  }

  let found = {};
  let accepted = false;
  let judged = '';
  const startTime = Date.now();
  while (Date.now() - startTime < ${pollBudgetMs}) {
    found = {};
    const cookies = await context.cookies();
    for (const cookie of cookies) {
      if (domainFilter && (!cookie.domain || cookie.domain.indexOf(domainFilter) === -1)) continue;
      if (wanted.indexOf(cookie.name) !== -1 && !isDead(cookie.value)) found[cookie.name] = cookie.value;
    }
    if (wanted.every((name) => found[name])) {
      if (!verifyUrl) { accepted = true; break; }
      // Judge each distinct candidate once; a dead one is skipped until the
      // login replaces it, an unknown one is asked again on the next poll.
      const signature = wanted.map((name) => found[name]).join('|');
      if (signature !== judged) {
        const verdict = await probe();
        if (verdict === 'live') { accepted = true; break; }
        if (verdict === 'dead') judged = signature;
      }
    }
    await new Promise((r) => setTimeout(r, ${pollIntervalMs}));
  }

  await context.close();

  if (accepted) {
    console.log(JSON.stringify({ status: 'ok', cookies: found }));
  } else {
    // A candidate that was present but rejected leaves nothing "missing";
    // say so rather than print an empty list.
    const missing = wanted.filter((name) => !found[name]).join(', ') || (wanted.join(', ') + ' (present but not accepted by the server)');
    console.log(JSON.stringify({ status: 'error', message: 'Cookies not captured within ${Math.round(pollBudgetMs / 1000)}s: ' + missing }));
  }
})();
`;
}

/** The JSON line a capture script prints. */
export interface CaptureResult {
  status: "ok" | "error";
  cookies?: Record<string, string>;
  message?: string;
}
