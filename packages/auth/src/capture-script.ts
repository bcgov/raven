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

/**
 * Create (or re-tighten) the profile directory at mode 0700. The mode bits are
 * POSIX permissions: they have no effect on Windows, where the user-profile
 * ACLs on the home directory are what protect the profile.
 */
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
 * The cross-process lock that serialises captures on the shared profile
 * (see `withAuthLock`). It lives beside the profile directory.
 */
export function authLockPath(): string {
  return join(homedir(), ".workflow-suite", "browser-profile.lock");
}

/** Spellings that switch an environment flag off, matching how RAVEN_SCRUB_PI is read. */
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/**
 * Whether an environment flag is switched on: set to anything other than
 * empty or an "off" spelling (0, false, no, off, disabled, in any case).
 * `RAVEN_AUTH_DEBUG=0` therefore means off, not "set, so on".
 */
export function isEnvFlagOn(value: string | undefined): boolean {
  const normalised = value?.trim().toLowerCase();
  return !!normalised && !OFF_VALUES.has(normalised);
}

/**
 * Resolve autofill credentials from the environment: the dedicated
 * IDIR_USERNAME/IDIR_PASSWORD pair first, else ATLASSIAN_EMAIL/
 * ATLASSIAN_PASSWORD (which already hold the same IDIR credentials for
 * the BWA Basic-auth route). RAVEN_AUTH_AUTOFILL set to off, false, 0, no or
 * disabled (any case) disables autofill entirely. Only a complete pair is
 * ever used: a half-configured IDIR pair is skipped rather than combined with
 * the other account's half, because a mismatched login burns IDIR lockout
 * attempts. Returns null when disabled or when neither pair is complete.
 */
export function resolveAutofillCredentials(
  env: Record<string, string | undefined>
): AutofillCredentials | null {
  const autofillSwitch = env["RAVEN_AUTH_AUTOFILL"]?.trim().toLowerCase();
  if (autofillSwitch !== undefined && OFF_VALUES.has(autofillSwitch)) return null;

  const pairs: ReadonlyArray<readonly [string | undefined, string | undefined]> = [
    [env["IDIR_USERNAME"], env["IDIR_PASSWORD"]],
    [env["ATLASSIAN_EMAIL"], env["ATLASSIAN_PASSWORD"]],
  ];
  for (const [username, password] of pairs) {
    if (username && password) return { username, password };
  }
  return null;
}

/**
 * Output buffer for the capture child. execFileSync's 1 MiB default kills a
 * child that writes a lot to stderr or stdout (a verbose browser) in the
 * middle of a login.
 */
export const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Time budgets for the two captures, in milliseconds.
 *
 * The script's worst case is its navigation timeout plus its poll budget, plus
 * one cookie probe (15 s) because the budget is only checked at the top of each
 * poll. The process timeout must exceed that so a stalled navigation ends in
 * the script's own "Cookies not captured within Ns" message instead of an
 * opaque ETIMEDOUT from the parent; and it must stay under the 5-minute stale
 * limit of the capture lock, so a live capture is never mistaken for an
 * abandoned one.
 */
export const CAPTURE_TIMINGS = {
  siteMinder: { navTimeoutMs: 60_000, pollBudgetMs: 120_000, processTimeoutMs: 210_000 },
  sharePoint: { navTimeoutMs: 60_000, pollBudgetMs: 180_000, processTimeoutMs: 270_000 },
} as const;

/**
 * A one-line, bounded description of why the capture child failed. What the
 * child wrote to stderr is what actually went wrong (a missing module, no
 * display, Chromium not installed); execFileSync's own message is "Command
 * failed: <node> -e <the whole script>", so only its first line is used, and
 * only when stderr is empty.
 */
export function describeCaptureFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const stderrText = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : "";
  const stderrLine = stderrText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  const line = stderrLine ?? (err instanceof Error ? err.message : "Unknown authentication error").split("\n")[0];
  return line.slice(0, 300);
}

/**
 * The environment for the capture child: the caller's environment, without
 * Playwright's debug variables, plus the autofill credentials when enabled.
 *
 * DEBUG=pw:api (or PWDEBUG) makes Playwright log every call with its
 * arguments, which includes the password autofill types, so they must never
 * be inherited. Credentials travel through the environment, never through
 * argv or the script text.
 */
export function captureChildEnv(
  env: NodeJS.ProcessEnv,
  credentials: AutofillCredentials | null
): NodeJS.ProcessEnv {
  return {
    ...env,
    DEBUG: undefined,
    PWDEBUG: undefined,
    // Ensure Playwright finds its browsers
    PLAYWRIGHT_BROWSERS_PATH: env["PLAYWRIGHT_BROWSERS_PATH"] ?? undefined,
    ...(credentials
      ? {
          RAVEN_AUTOFILL_USERNAME: credentials.username,
          RAVEN_AUTOFILL_PASSWORD: credentials.password,
        }
      : {}),
  };
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

// What "you are being sent to log in" looks like. Matched on the parsed
// Location, never as a substring of the whole value, so an application's own
// canonical redirect (a Jenkins job called `login-service`) is not mistaken
// for SiteMinder. Shared by the Node-side probes and the generated capture
// script so both judge a cookie the same way.

/** BC Gov logon hosts (logon7, logontest7, loginproxy...) and the Entra login host. */
export const LOGIN_HOST_PATTERN = /^(?:(?:logon|login)[a-z0-9-]*\.gov\.bc\.ca|login\.microsoftonline\.com)$/i;
/** Paths owned by SiteMinder itself: its agent and CGI directories, and the fedLaunch federation hop. */
export const LOGIN_PATH_PATTERN = /\/(?:(?:siteminderagent|clp-cgi)\/|fedlaunch(?:\/|$))/i;
/** Query parameters SiteMinder adds when it bounces a request to login. */
export const LOGIN_QUERY_PATTERN = /(?:^|[?&])(?:SMAGENTNAME|SMAUTHREASON|fedLaunch)(?:=|&|$)/i;

/** Whether a response is a redirect into the login flow. */
export function isLoginRedirect(status: number, location: string): boolean {
  if (status < 300 || status >= 400) return false;
  let url: URL;
  try {
    // Relative locations resolve against a placeholder; only SiteMinder paths
    // and query parameters can match those, never a host.
    url = new URL(location, "https://placeholder.invalid");
  } catch {
    return false;
  }
  return (
    LOGIN_HOST_PATTERN.test(url.hostname) ||
    LOGIN_PATH_PATTERN.test(url.pathname) ||
    LOGIN_QUERY_PATTERN.test(url.search)
  );
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
  /**
   * Log each main-frame navigation (URL without its query string or fragment)
   * to stderr. Decided by the caller; the script never reads the environment
   * for it. Default false.
   */
  readonly debug?: boolean;
  /** Emit the credential-autofill routine. */
  readonly autofill: boolean;
}

/**
 * A finite whole number of at least `min`, else `fallback`. These values are
 * interpolated into generated code, so NaN, Infinity and negatives must never
 * reach it (the build function is a public export).
 */
function wholeNumber(value: number | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.trunc(value)) : fallback;
}

const AUTOFILL_SNIPPET = `
  // Best-effort credential autofill, restricted to the identity providers'
  // own login pages over https. Values come from the environment, never from
  // this script. MFA prompts are left for the human on purpose.
  //
  // A rejected password is never retried: every further failed IDIR login
  // moves the account closer to lockout, so the person takes over after one
  // try. The password is also never typed for a different account than the
  // form is already showing.
  const AUTOFILL_HOSTS = ['login.microsoftonline.com', 'logon7.gov.bc.ca'];
  const AUTOFILL_MAX = 8;
  const PASSWORD_MAX = 1;
  const USER_SEL = 'input[name="loginfmt"], input[type="email"], input[name="user"], input[name="username"], input#user';
  const PASS_SEL = 'input[type="password"]';
  const SUBMIT_SEL = '#idSIButton9, input[type="submit"], button[type="submit"]';
  const KMSI_SEL = '#idSIButton9';
  let autofillAttempts = 0;
  let passwordSubmits = 0;
  let autofillBusy = false;
  let autofillAgain = false;
  // locator.isVisible({ timeout }) ignores its timeout and answers at once, so
  // a form rendered shortly after the load event was never seen. Wait for it.
  const shows = (locator, ms) => locator.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
  async function autofillOnce() {
    if (autofillAttempts >= AUTOFILL_MAX) return;
    const username = process.env.RAVEN_AUTOFILL_USERNAME;
    const password = process.env.RAVEN_AUTOFILL_PASSWORD;
    if (!username || !password) return;
    let url;
    try { url = new URL(page.url()); } catch { return; }
    const host = url.hostname;
    if (url.protocol !== 'https:' || !AUTOFILL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return;
    const userBox = page.locator(USER_SEL).first();
    const passBox = page.locator(PASS_SEL).first();
    const submit = page.locator(SUBMIT_SEL).first();
    const anyField = page.locator(USER_SEL + ', ' + PASS_SEL).first();
    if (await shows(anyField, 1500)) {
      const passVisible = await passBox.isVisible().catch(() => false);
      const userVisible = await userBox.isVisible().catch(() => false);
      const prefilled = userVisible ? await userBox.inputValue().catch(() => '') : '';
      if (prefilled && prefilled.trim().toLowerCase() !== username.trim().toLowerCase()) return;
      if (passVisible) {
        if (passwordSubmits >= PASSWORD_MAX) return;
        if (userVisible && !prefilled) await userBox.fill(username);
        if (!(await passBox.inputValue().catch(() => ''))) {
          autofillAttempts += 1;
          passwordSubmits += 1;
          await passBox.fill(password);
          await submit.click({ timeout: 1000 }).catch(() => {});
        }
      } else if (userVisible && !prefilled) {
        autofillAttempts += 1;
        await userBox.fill(username);
        await submit.click({ timeout: 1000 }).catch(() => {});
      }
    } else if (host.endsWith('login.microsoftonline.com')) {
      // "Stay signed in?" — answer Yes so the profile keeps the session.
      const kmsi = page.locator(KMSI_SEL);
      if (await shows(kmsi, 1500)) {
        autofillAttempts += 1;
        await kmsi.click({ timeout: 1000 }).catch(() => {});
      }
    }
  }
  async function tryAutofill() {
    // Overlapping load events must not park two passes on the same field. One
    // that arrives mid-pass is remembered and run once more afterwards.
    if (autofillBusy) { autofillAgain = true; return; }
    autofillBusy = true;
    try {
      do {
        autofillAgain = false;
        try { await autofillOnce(); } catch {}
      } while (autofillAgain && autofillAttempts < AUTOFILL_MAX);
    } finally { autofillBusy = false; }
  }
  page.on('load', () => { tryAutofill().catch(() => {}); });
`;

/**
 * Generate the Playwright capture script executed via \`node -e\` in a
 * subprocess (Playwright must not share the caller's stdio). The script
 * prints exactly one JSON line: {status:'ok', cookies:{...}} or
 * {status:'error', message}, including when the capture itself fails (for
 * example the user closes the login window).
 *
 * The script also watches the process that launched it and shuts the browser
 * down if that process dies, so an orphaned capture cannot keep the shared
 * profile locked against the next login.
 */
export function buildCaptureScript(opts: CaptureScriptOptions): string {
  const navTimeoutMs = wholeNumber(opts.navTimeoutMs, 120_000, 100);
  const pollBudgetMs = wholeNumber(opts.pollBudgetMs, 180_000, 100);
  const pollIntervalMs = wholeNumber(opts.pollIntervalMs, 1_000, 10);

  return `
const { chromium } = require('playwright');

(async () => {
  const DEBUG = ${opts.debug === true ? "true" : "false"};
  const context = await chromium.launchPersistentContext(${JSON.stringify(opts.profileDir)}, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: ${JSON.stringify(opts.userAgent)},
    ignoreHTTPSErrors: true,
    viewport: null,
  });

  // The lock that serialises captures names only the process that launched
  // this one. If that process is killed mid-login, nothing else would ever
  // close this browser, and an orphaned Chromium keeps the persistent profile
  // locked, so the next login fails. Watch the parent and go down with it.
  const parentPid = process.ppid;
  const parentWatch = setInterval(() => {
    let parentAlive = true;
    try { process.kill(parentPid, 0); } catch (e) { parentAlive = !!e && e.code === 'EPERM'; }
    if (!parentAlive) {
      clearInterval(parentWatch);
      context.close().catch(() => {}).then(() => process.exit(1));
    }
  }, 1000);
  if (parentWatch.unref) parentWatch.unref();

  const page = context.pages()[0] ?? await context.newPage();
  if (DEBUG) {
    // The query string and fragment of an SSO hop can carry tokens: log neither.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) process.stderr.write('[capture] ' + frame.url().split(/[?#]/)[0].slice(0, 120) + '\\n');
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
    if (DEBUG) {
      process.stderr.write('[capture] goto failed: ' + navMsg.split('\\n')[0].slice(0, 200) + '\\n');
    }
    const isTransientNet = navMsg.indexOf('net::ERR_') !== -1;
    const isTimeout = navErr && navErr.name === 'TimeoutError';
    if (!isTransientNet && !isTimeout) {
      await context.close().catch(() => {});
      console.log(JSON.stringify({ status: 'error', message: 'Navigation failed: ' + navMsg.split('\\n')[0] }));
      return;
    }
    // Transient drops are retried from the original target by the
    // requestfailed handler above; a goto timeout can coexist with a login
    // the user already completed — the cookie poll is the success signal.
  }

  const wanted = ${JSON.stringify(opts.cookieNames)};
  const domainFilter = ${opts.cookieDomainFilter ? JSON.stringify(opts.cookieDomainFilter) : "null"};
  const verifyUrl = ${opts.verifyUrl ? JSON.stringify(opts.verifyUrl) : "null"};
  // Same rules as isLoginRedirect() in capture-script.ts, on the parsed Location.
  const LOGIN_HOST = new RegExp(${JSON.stringify(LOGIN_HOST_PATTERN.source)}, 'i');
  const LOGIN_PATH = new RegExp(${JSON.stringify(LOGIN_PATH_PATTERN.source)}, 'i');
  const LOGIN_QUERY = new RegExp(${JSON.stringify(LOGIN_QUERY_PATTERN.source)}, 'i');
  function isLoginLocation(location) {
    let url;
    try { url = new URL(location, 'https://placeholder.invalid'); } catch (e) { return false; }
    return LOGIN_HOST.test(url.hostname) || LOGIN_PATH.test(url.pathname) || LOGIN_QUERY.test(url.search);
  }

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
      if (status >= 300 && status < 400) return isLoginLocation(location) ? 'dead' : 'live';
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
    // Only cookies the browser would send to the target. The profile holds
    // cookies for every host ever visited; picking by name alone could cache an
    // unrelated SMSESSION/FedAuth that the URL-scoped probe never validated.
    const cookies = await context.cookies(${JSON.stringify(opts.targetUrl)});
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

  clearInterval(parentWatch);
  await context.close();

  if (accepted) {
    console.log(JSON.stringify({ status: 'ok', cookies: found }));
  } else {
    // A candidate that was present but rejected leaves nothing "missing";
    // say so rather than print an empty list.
    const missing = wanted.filter((name) => !found[name]).join(', ') || (wanted.join(', ') + ' (present but not accepted by the server)');
    console.log(JSON.stringify({ status: 'error', message: 'Cookies not captured within ${Math.round(pollBudgetMs / 1000)}s: ' + missing }));
  }
})().catch((err) => {
  // Keep the one-JSON-line contract when anything throws (the login window was
  // closed, Chromium could not start, ...). Report only the first line of the
  // message; the caller must not be handed a stack trace.
  const detail = String(err && err.message ? err.message : err).split('\\n')[0].slice(0, 300);
  process.stdout.write(JSON.stringify({ status: 'error', message: 'Capture failed: ' + detail }) + '\\n', () => process.exit(0));
});
`;
}

/** The JSON line a capture script prints. */
export interface CaptureResult {
  status: "ok" | "error";
  cookies?: Record<string, string>;
  message?: string;
}
