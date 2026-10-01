import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Script } from "node:vm";
import { DEFAULT_STALE_MS } from "../auth-lock.js";
import {
  CAPTURE_LAUNCH_TIMEOUT_MS,
  CAPTURE_OVERHEAD_MS,
  CAPTURE_PROBE_TIMEOUT_MS,
  CAPTURE_TIMINGS,
  authLockPath,
  captureChildEnv,
  captureFailureHint,
  authProfileDir,
  buildCaptureScript,
  describeCaptureFailure,
  ensureProfileDir,
  isEnvFlagOn,
  isLoginRedirect,
  resolveAutofillCredentials,
  siteMinderProbeUrl,
  siteMinderWebUrl,
  type CaptureResult,
  type CaptureScriptOptions,
} from "../capture-script.js";

const execFileAsync = promisify(execFile);

const baseOpts = {
  targetUrl: "https://apps.example.gov.bc.ca/int/confluence/index.action",
  cookieNames: ["SMSESSION"],
  profileDir: "/tmp/profile dir",
  userAgent: "Mozilla/5.0 (test)",
  autofill: false,
} as const;

describe("authProfileDir", () => {
  it("lives under ~/.workflow-suite", () => {
    expect(authProfileDir()).toBe(join(homedir(), ".workflow-suite", "browser-profile"));
  });
});

describe("ensureProfileDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auth-profile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Mode bits are POSIX permissions; Windows reports a fixed value and ignores them.
  it.skipIf(process.platform === "win32")("creates the directory with mode 0700", async () => {
    const target = join(dir, "profile");
    await ensureProfileDir(target);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing looser directory to 0700", async () => {
    const target = join(dir, "profile");
    await mkdir(target, { recursive: true, mode: 0o755 });
    await ensureProfileDir(target);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });
});

describe("resolveAutofillCredentials", () => {
  it("prefers the dedicated IDIR variables", () => {
    expect(
      resolveAutofillCredentials({
        IDIR_USERNAME: "jdoe",
        IDIR_PASSWORD: "pw",
        ATLASSIAN_EMAIL: "jane@example.com",
        ATLASSIAN_PASSWORD: "other",
      })
    ).toEqual({ username: "jdoe", password: "pw" });
  });

  it("falls back to the Atlassian variables, which hold the same IDIR credentials", () => {
    expect(
      resolveAutofillCredentials({ ATLASSIAN_EMAIL: "jane@example.com", ATLASSIAN_PASSWORD: "pw" })
    ).toEqual({ username: "jane@example.com", password: "pw" });
  });

  it("returns null when either half is missing", () => {
    expect(resolveAutofillCredentials({ ATLASSIAN_EMAIL: "jane@example.com" })).toBeNull();
    expect(resolveAutofillCredentials({})).toBeNull();
  });

  it("never pairs one account's username with the other account's password", () => {
    // A half-configured IDIR_* pair next to a full Atlassian pair used to
    // submit a mismatched login, which burns IDIR lockout attempts.
    expect(
      resolveAutofillCredentials({
        IDIR_USERNAME: "jdoe",
        ATLASSIAN_EMAIL: "jane@example.com",
        ATLASSIAN_PASSWORD: "atlassian-pw",
      })
    ).toEqual({ username: "jane@example.com", password: "atlassian-pw" });

    expect(
      resolveAutofillCredentials({
        IDIR_PASSWORD: "idir-pw",
        ATLASSIAN_EMAIL: "jane@example.com",
        ATLASSIAN_PASSWORD: "atlassian-pw",
      })
    ).toEqual({ username: "jane@example.com", password: "atlassian-pw" });
  });

  it("returns null rather than a mixed pair when neither account is complete", () => {
    expect(
      resolveAutofillCredentials({ IDIR_USERNAME: "jdoe", ATLASSIAN_PASSWORD: "atlassian-pw" })
    ).toBeNull();
    expect(
      resolveAutofillCredentials({ IDIR_PASSWORD: "idir-pw", ATLASSIAN_EMAIL: "jane@example.com" })
    ).toBeNull();
  });

  it.each(["off", "OFF", " Off ", "false", "FALSE", "0", "no", "disabled"])(
    "honours the off switch spelled %j",
    (value) => {
      // Only the exact lowercase "off" used to work, so the natural spellings
      // failed open and the user kept believing autofill was disabled.
      expect(
        resolveAutofillCredentials({
          RAVEN_AUTH_AUTOFILL: value,
          ATLASSIAN_EMAIL: "jane@example.com",
          ATLASSIAN_PASSWORD: "pw",
        })
      ).toBeNull();
    }
  );

  it.each(["on", "true", "1", "", "yes"])("keeps autofill on for RAVEN_AUTH_AUTOFILL=%j", (value) => {
    expect(
      resolveAutofillCredentials({
        RAVEN_AUTH_AUTOFILL: value,
        ATLASSIAN_EMAIL: "jane@example.com",
        ATLASSIAN_PASSWORD: "pw",
      })
    ).toEqual({ username: "jane@example.com", password: "pw" });
  });
});

describe("siteMinderProbeUrl", () => {
  it("targets the protected dashboard, not an anonymously readable endpoint", () => {
    // /rest/api/space answers anonymous requests, so SiteMinder never
    // challenges and no SMSESSION is minted — the probe must be protected.
    expect(siteMinderProbeUrl("https://apps.example.gov.bc.ca/int/confluence")).toBe(
      "https://apps.example.gov.bc.ca/int/confluence/index.action"
    );
  });

  it("strips trailing slashes before appending", () => {
    expect(siteMinderProbeUrl("https://apps.example.gov.bc.ca/int/confluence//")).toBe(
      "https://apps.example.gov.bc.ca/int/confluence/index.action"
    );
  });
});

describe("siteMinderWebUrl", () => {
  it("maps the BWA API host to the SiteMinder-protected apps host", () => {
    // A browser capture on the BWA host hits the IDIR Basic realm and dies
    // with ERR_INVALID_AUTH_CREDENTIALS; SMSESSION only mints on apps.
    expect(siteMinderWebUrl("https://bwa.example.gov.bc.ca")).toBe(
      "https://apps.example.gov.bc.ca"
    );
  });

  it("leaves a non-BWA host unchanged", () => {
    expect(siteMinderWebUrl("https://apps.example.gov.bc.ca")).toBe(
      "https://apps.example.gov.bc.ca"
    );
  });

  it("returns an unparseable value unchanged", () => {
    expect(siteMinderWebUrl("not a url")).toBe("not a url");
  });
});

describe("buildCaptureScript", () => {
  it("uses a persistent context on the given profile directory", () => {
    const script = buildCaptureScript({ ...baseOpts });
    expect(script).toContain("launchPersistentContext");
    expect(script).toContain(JSON.stringify("/tmp/profile dir"));
    expect(script).not.toContain("chromium.launch(");
  });

  it("polls for every requested cookie and reports them by name", () => {
    const script = buildCaptureScript({
      ...baseOpts,
      cookieNames: ["FedAuth", "rtFa"],
      cookieDomainFilter: "sharepoint.com",
    });
    expect(script).toContain(JSON.stringify(["FedAuth", "rtFa"]));
    expect(script).toContain(JSON.stringify("sharepoint.com"));
  });

  it("omits the domain filter when none is given", () => {
    const script = buildCaptureScript({ ...baseOpts });
    expect(script).toContain("const domainFilter = null");
  });

  it("embeds the target URL", () => {
    const script = buildCaptureScript({ ...baseOpts });
    expect(script).toContain(JSON.stringify(baseOpts.targetUrl));
  });

  it("does not block on networkidle — the cookie poll is the success signal", () => {
    // SSO redirect chains keep the network busy for minutes; waiting for
    // networkidle made even silent captures take the full nav timeout.
    const script = buildCaptureScript({ ...baseOpts });
    expect(script).toContain("domcontentloaded");
    expect(script).not.toContain("networkidle");
  });

  it("includes the autofill routine only when asked", () => {
    const withFill = buildCaptureScript({ ...baseOpts, autofill: true });
    const withoutFill = buildCaptureScript({ ...baseOpts, autofill: false });
    expect(withFill).toContain("RAVEN_AUTOFILL_USERNAME");
    expect(withFill).toContain("RAVEN_AUTOFILL_PASSWORD");
    expect(withoutFill).not.toContain("RAVEN_AUTOFILL_USERNAME");
  });

  it("never embeds credential values — they travel via the subprocess env", () => {
    const script = buildCaptureScript({ ...baseOpts, autofill: true });
    expect(script).not.toContain("ATLASSIAN");
    expect(script).not.toContain("IDIR_PASSWORD");
  });

  it("limits autofill to the identity-provider login pages", () => {
    const script = buildCaptureScript({ ...baseOpts, autofill: true });
    expect(script).toContain("login.microsoftonline.com");
    expect(script).toContain("logon7.gov.bc.ca");
  });
});

describe("authLockPath", () => {
  it("lives beside the browser profile, so the profile and its lock are always found together", () => {
    expect(authLockPath()).toBe(join(homedir(), ".workflow-suite", "browser-profile.lock"));
    expect(dirname(authLockPath())).toBe(dirname(authProfileDir()));
  });
});

describe("CAPTURE_TIMINGS", () => {
  it.each(Object.entries(CAPTURE_TIMINGS))(
    "%s: the script's worst case fits inside the process timeout, which stays under the lock's stale limit",
    (_name, timings) => {
      // The script's worst case is navigation plus polling, plus one probe
      // because the budget is checked only at the top of each poll. If the
      // process timeout were shorter, a stalled navigation would end in an
      // opaque ETIMEDOUT instead of the script's own message. And if the lock's
      // stale limit were shorter than the process timeout, a waiter would take
      // a live capture's lock and start a second browser on the same profile.
      const worstCase =
        CAPTURE_LAUNCH_TIMEOUT_MS + timings.navTimeoutMs + timings.pollBudgetMs + CAPTURE_PROBE_TIMEOUT_MS + CAPTURE_OVERHEAD_MS;
      expect(worstCase).toBeLessThan(timings.processTimeoutMs);
      expect(timings.processTimeoutMs).toBeLessThan(DEFAULT_STALE_MS);
    }
  );

  it("passes the browser launch the timeout the budget counts, instead of relying on Playwright's default", () => {
    expect(buildCaptureScript({ ...baseOpts })).toContain(`timeout: ${CAPTURE_LAUNCH_TIMEOUT_MS},`);
  });

  it("gives the probe inside the script exactly the timeout the budget arithmetic assumes", () => {
    const script = buildCaptureScript({ ...baseOpts, verifyUrl: "https://apps.example.gov.bc.ca/int/confluence/index.action" });
    expect(script).toContain(`timeout: ${CAPTURE_PROBE_TIMEOUT_MS} }`);
  });
});

describe("describeCaptureFailure", () => {
  it("prefers what the child wrote to stderr, which is what actually went wrong", () => {
    const err = Object.assign(new Error("Command failed: /usr/bin/node -e \nconst { chromium } = require('playwright');"), {
      stderr: "\nError: Cannot find module 'playwright'\n    at Module._resolveFilename (node:internal)\n",
    });
    expect(describeCaptureFailure(err)).toBe("Error: Cannot find module 'playwright'");
  });

  // Node prints an uncaught exception as a location header, the offending
  // source line and a caret, and only then the error. These are the shapes it
  // really prints (checked on Node 25); reading the first line gave the header.
  it.each([
    [
      "a missing module",
      "node:internal/modules/cjs/loader:1478\n  throw err;\n  ^\n\nError: Cannot find module 'playwright'\nRequire stack:\n- /repo/[eval]\n",
      "Error: Cannot find module 'playwright'",
    ],
    [
      "a syntax error",
      "[eval]:1\nconst {{\n       ^\n\nSyntaxError: Unexpected token '{'\n    at makeContextifyScript (node:internal/vm:194:14)\n",
      "SyntaxError: Unexpected token '{'",
    ],
    [
      "an error with a code",
      "node:internal/modules/esm/resolve:873\n    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);\n          ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from /repo/[eval]\n",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from /repo/[eval]",
    ],
    [
      "a thrown TypeError",
      "[eval]:1\nthrow new TypeError('boom')\n^\n\nTypeError: boom\n    at [eval]:1:7\n",
      "TypeError: boom",
    ],
    [
      "the engine running out of memory",
      "<--- Last few GCs --->\n[1:0x1] 1000 ms: Mark-Compact 4000.0 (4100.0) -> 4000.0 (4100.0) MB\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    ],
  ])("names the error, not Node's location header, for %s", (_what, stderr, expected) => {
    expect(describeCaptureFailure(Object.assign(new Error("Command failed"), { stderr }))).toBe(expected);
  });

  it("says the login ran out of time when the parent had to stop it, rather than 'spawnSync node ETIMEDOUT'", () => {
    const err = Object.assign(new Error("spawnSync /usr/local/bin/node ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM", stderr: "" });
    expect(describeCaptureFailure(err)).toBe("The browser login did not finish in time and was stopped");
  });

  it("says so when the capture process was killed by a signal and wrote nothing", () => {
    const err = Object.assign(new Error("Command failed: /usr/local/bin/node -e \nSCRIPT"), { signal: "SIGKILL", stderr: "" });
    expect(describeCaptureFailure(err)).toBe("The browser login process was stopped (SIGKILL)");
  });

  it("falls back to the first line when stderr names no error", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "\n[pid=123][err] gpu process exited unexpectedly\nsecond line\n",
    });
    expect(describeCaptureFailure(err)).toBe("[pid=123][err] gpu process exited unexpectedly");
  });

  it("is not fooled by source text in the excerpt that merely starts with the word Error", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "[eval]:1\nError.captureStackTrace(x)\n^\n\nTypeError: x is not defined\n",
    });
    expect(describeCaptureFailure(err)).toBe("TypeError: x is not defined");
  });

  it("reports a real child crash by its cause (the format Node prints today)", () => {
    let thrown: unknown;
    try {
      execFileSync(process.execPath, ["-e", "require('playwright-is-not-installed-here')"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(describeCaptureFailure(thrown)).toMatch(/^Error: Cannot find module 'playwright-is-not-installed-here'/);
  });

  it("accepts stderr as a Buffer", () => {
    const err = Object.assign(new Error("Command failed"), { stderr: Buffer.from("browserType.launch: no display\nCall log:") });
    expect(describeCaptureFailure(err)).toBe("browserType.launch: no display");
  });

  it("falls back to the first line of the message, never the whole script, when there is no stderr", () => {
    const err = new Error("Command failed: /usr/bin/node -e \nconst secret = 1;\nmore script");
    expect(describeCaptureFailure(err)).toBe("Command failed: /usr/bin/node -e ");
  });

  it("copes with values that are not errors", () => {
    expect(describeCaptureFailure("boom")).toBe("Unknown authentication error");
    expect(describeCaptureFailure(undefined)).toBe("Unknown authentication error");
  });

  it("truncates a very long line", () => {
    expect(describeCaptureFailure(Object.assign(new Error("x"), { stderr: "e".repeat(5_000) })).length).toBeLessThanOrEqual(300);
  });
});

describe("captureFailureHint", () => {
  it("tells the person how to install the browser when Playwright cannot find it", () => {
    // Only the first line of Playwright's multi-line message survives to the
    // caller, and the remedy is on a later line, so it is added back here.
    const detail = "Capture failed: browserType.launchPersistentContext: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1243/chrome";
    expect(captureFailureHint(detail)).toBe(
      'The browser is not installed: run "npx playwright install chromium" in the RAVEN folder (README, Prerequisites).'
    );
  });

  it.each([
    "Cookies not captured within 120s: SMSESSION",
    "The login window was closed before the login finished",
    "Capture failed: Cannot find module 'playwright'",
    "",
  ])("has nothing to add to %j", (detail) => {
    expect(captureFailureHint(detail)).toBeNull();
  });
});

describe("captureChildEnv", () => {
  it("tells the child which process launched it, so it can notice if that process dies before it has started", () => {
    expect(captureChildEnv({}, null)["RAVEN_CAPTURE_PARENT_PID"]).toBe(String(process.pid));
  });

  it("does not let an inherited value stand in for the launcher's own pid", () => {
    expect(captureChildEnv({ RAVEN_CAPTURE_PARENT_PID: "1" }, null)["RAVEN_CAPTURE_PARENT_PID"]).toBe(String(process.pid));
  });
});

describe("isEnvFlagOn", () => {
  it.each(["1", "true", "TRUE", "yes", "on", "verbose", "2"])("treats %j as on", (value) => {
    expect(isEnvFlagOn(value)).toBe(true);
  });

  it.each([undefined, "", "   ", "0", "false", "FALSE", "off", "OFF", "no", "disabled"])(
    "treats %j as off, so RAVEN_AUTH_DEBUG=0 no longer turns debug logging on",
    (value) => {
      expect(isEnvFlagOn(value)).toBe(false);
    }
  );
});

describe("isLoginRedirect", () => {
  it.each([
    "https://apps.example.gov.bc.ca/fedLaunch?target=jenkins",
    "https://apps.example.gov.bc.ca/int/fedLaunch/continue",
    "/fedlaunch",
  ])("recognises SiteMinder's fedLaunch hop as a path segment: %s", (location) => {
    // The Jenkins client's own tests pin this exact form as an authentication
    // redirect; matching fedLaunch only as a query parameter missed it.
    expect(isLoginRedirect(302, location)).toBe(true);
  });

  it("does not match fedLaunch inside a longer path segment", () => {
    expect(isLoginRedirect(302, "/int/jenkins/job/fedlaunch-notes/")).toBe(false);
  });

  it.each([
    [302, "https://logon7.gov.bc.ca/clp-cgi/capBceid/logon.cgi?SMAGENTNAME=x"],
    [302, "https://login.microsoftonline.com/tenant/oauth2/authorize"],
    [302, "/siteminderagent/forms/login.fcc"],
    [301, "https://apps.example.gov.bc.ca/int/x?fedLaunch=1"],
  ])("recognises a %i to the login flow: %s", (status, location) => {
    expect(isLoginRedirect(status, location)).toBe(true);
  });

  it.each([
    [200, ""],
    [302, "/int/confluence/dashboard.action"],
    [302, ""],
  ])("does not flag a live response: %i %j", (status, location) => {
    expect(isLoginRedirect(status, location)).toBe(false);
  });

  it.each([
    "/job/login-service/",
    "https://jenkins.example.gov.bc.ca/int/jenkins/job/login-service/",
    "/int/jenkins/job/logon-audit/lastBuild/",
    "/int/jenkins/job/signin-tests/",
    "https://apps.example.gov.bc.ca/int/jenkins/user/login-bot/",
  ])("does not mistake an ordinary in-app redirect for SiteMinder: %s", (location) => {
    // A substring match on "login" sent Jenkins canonical redirects such as
    // /job/login-service/ down the interactive-auth path.
    expect(isLoginRedirect(302, location)).toBe(false);
  });

  it.each([
    "https://logontest7.gov.bc.ca/clp-cgi/capBceid/logon.cgi",
    "https://loginproxy.gov.bc.ca/auth/realms/standard",
    "https://apps.example.gov.bc.ca/clp-cgi/dirSelect.cgi?x=1",
    "https://apps.example.gov.bc.ca/int/jenkins/?SMAGENTNAME=abc",
    "https://apps.example.gov.bc.ca/x?SMAUTHREASON=0",
  ])("still recognises other SiteMinder/IdP redirects: %s", (location) => {
    expect(isLoginRedirect(302, location)).toBe(true);
  });
});

/**
 * Behavioural tests: run the real generated capture script against a stub
 * `playwright` module whose cookie jar and probe answers are scripted, so the
 * poll loop is exercised without a browser, network, or SSO.
 */
describe("capture script cookie acceptance", () => {
  let dir: string;

  interface StubConfig {
    /** SMSESSION value seen at each poll (last entry repeats); null = no cookie. */
    jar: (string | null)[];
    /** Probe answer per cookie value; unlisted values answer 200. */
    probes?: Record<string, { status: number; location?: string }>;
    /** Number of leading probe calls that throw (e.g. offline). */
    probeThrows?: number;
    /** Add an unrelated host's SMSESSION to the jar, visible unless the cookie query is scoped to exactly scopedUrl. */
    unrelated?: boolean;
    /** The only URL for which an unrelated host's cookie is withheld. */
    scopedUrl?: string;
    /** URL the main frame reports on navigation (for the debug-logging test). */
    navUrl?: string;
    /** Make context.cookies reject, as it does after the user closes the login window. */
    cookiesThrow?: boolean;
    /** Full cookie jars per poll (last repeats); when set it replaces the SMSESSION-only jar. */
    rawJar?: { name: string; domain: string; value: string }[][];
    /** The first `count` browser launches reject with `message`. */
    launchFailures?: { count: number; message: string };
    /** From this many milliseconds on, the browser reports no open page (the person closed the window). */
    pagesGoneAfterMs?: number;
  }

  const STUB = `
    const cfg = JSON.parse(process.env.STUB_CONFIG);
    let polls = 0, probeCalls = 0, launches = 0, current = null;
    const startedAt = Date.now();
    const frame = { url: () => cfg.navUrl || 'about:blank' };
    const navHandlers = [];
    const dialogHandlers = [];
    const page = {
      url: () => 'about:blank',
      on(evt, cb) {
        if (evt === 'framenavigated') navHandlers.push(cb);
        if (evt === 'dialog') dialogHandlers.push(cb);
      },
      goto: async () => {
        navHandlers.forEach((cb) => cb(frame));
        dialogHandlers.forEach((cb) => cb({ accept: async () => { process.stderr.write('STUB_DIALOG_ACCEPTED\\n'); } }));
      },
      mainFrame() { return frame; },
    };
    const context = {
      pages: () => (cfg.pagesGoneAfterMs !== undefined && Date.now() - startedAt >= cfg.pagesGoneAfterMs ? [] : [page]),
      newPage: async () => page,
      close: async () => { process.stderr.write('STUB_CLOSE\\n'); },
      cookies: async (urls) => {
        if (cfg.cookiesThrow) throw new Error('Target page, context or browser has been closed\\n    at secret/stack/frame.js:1:1');
        if (cfg.rawJar) return cfg.rawJar[Math.min(polls++, cfg.rawJar.length - 1)];
        current = cfg.jar[Math.min(polls++, cfg.jar.length - 1)];
        const jar = current === null ? [] : [{ name: 'SMSESSION', domain: '.gov.bc.ca', value: current }];
        // Like Playwright: with URLs, only cookies the browser would send there.
        if (cfg.unrelated && urls !== cfg.scopedUrl) jar.push({ name: 'SMSESSION', domain: 'other.example', value: 'UNRELATED-OTHER-HOST' });
        return jar;
      },
      request: { get: async (url, opts) => {
        process.stderr.write('STUB_PROBE ' + JSON.stringify({ url, opts }) + '\\n');
        probeCalls += 1;
        if (probeCalls <= (cfg.probeThrows || 0)) throw new Error('net::ERR_INTERNET_DISCONNECTED');
        const answer = (cfg.probes || {})[current] || { status: 200 };
        return { status: () => answer.status, headers: () => (answer.location ? { location: answer.location } : {}) };
      } },
    };
    module.exports = { chromium: { launchPersistentContext: async (profile, options) => {
      launches += 1;
      process.stderr.write('STUB_LAUNCH ' + JSON.stringify({ profile, options }) + '\\n');
      if (cfg.launchFailures && launches <= cfg.launchFailures.count) throw new Error(cfg.launchFailures.message);
      return context;
    } } };
  `;

  const stubEvent = (stderr: string, name: string): unknown[] =>
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${name} `))
      .map((line) => JSON.parse(line.slice(name.length + 1)));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capture-stub-"));
    await mkdir(join(dir, "node_modules", "playwright"), { recursive: true });
    await writeFile(join(dir, "node_modules", "playwright", "index.js"), STUB);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runCapture(
    stub: StubConfig,
    opts: { verify?: boolean; pollBudgetMs?: number; debug?: boolean; scriptOpts?: Partial<CaptureScriptOptions> } = {}
  ): Promise<{ result: CaptureResult; stderr: string }> {
    const script = buildCaptureScript({
      ...baseOpts,
      profileDir: join(dir, "profile"),
      navTimeoutMs: 1000,
      pollBudgetMs: opts.pollBudgetMs ?? 5000,
      pollIntervalMs: 10,
      ...(opts.verify ? { verifyUrl: baseOpts.targetUrl } : {}),
      ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
      ...opts.scriptOpts,
    });
    const { stdout, stderr } = await execFileAsync("node", ["-e", script], {
      cwd: dir,
      env: { ...process.env, STUB_CONFIG: JSON.stringify(stub) },
    });
    return { result: JSON.parse(stdout.trim()) as CaptureResult, stderr };
  }

  async function capture(
    stub: StubConfig,
    opts: { verify?: boolean; pollBudgetMs?: number; scriptOpts?: Partial<CaptureScriptOptions> } = {}
  ): Promise<CaptureResult> {
    return (await runCapture(stub, opts)).result;
  }

  it("waits past SiteMinder's LOGGEDOFF marker for the real cookie", async () => {
    // The persistent profile already holds SMSESSION=LOGGEDOFF from the last
    // logoff/expiry. Taking it ended the capture before the user could log in
    // and cached a placeholder as a "valid" session.
    const result = await capture({ jar: ["LOGGEDOFF", "loggedoff", "real-cookie"] });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "real-cookie" } });
  });

  it("fails rather than returning LOGGEDOFF when no real login ever completes", async () => {
    const result = await capture({ jar: ["LOGGEDOFF"] }, { pollBudgetMs: 300 });
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/Cookies not captured/);
    expect(result.cookies).toBeUndefined();
  });

  it("skips a stale cookie the server no longer honours until a working one appears", async () => {
    const result = await capture(
      {
        jar: ["stale-cookie", "stale-cookie", "fresh-cookie"],
        probes: {
          "stale-cookie": { status: 302, location: "https://logon7.gov.bc.ca/clp-cgi/capBceid/logon.cgi" },
          "fresh-cookie": { status: 302, location: "/int/confluence/dashboard.action" },
        },
      },
      { verify: true }
    );
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "fresh-cookie" } });
  });

  it("never accepts a stale cookie, even after the whole poll budget", async () => {
    const result = await capture(
      {
        jar: ["stale-cookie"],
        probes: { "stale-cookie": { status: 302, location: "https://logon7.gov.bc.ca/logon.cgi" } },
      },
      { verify: true, pollBudgetMs: 300 }
    );
    expect(result.status).toBe("error");
  });

  it("accepts a cookie that is already live without waiting (silent SSO still works)", async () => {
    const result = await capture(
      { jar: ["live-cookie"], probes: { "live-cookie": { status: 302, location: "/int/confluence/dashboard.action" } } },
      { verify: true }
    );
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "live-cookie" } });
  });

  it("only considers cookies the browser would send to the target URL", async () => {
    // The persistent profile holds cookies for every host ever visited. Picking
    // by name alone could cache an unrelated host's SMSESSION/FedAuth, even
    // though the probe (which is URL-scoped) validated a different cookie.
    const result = await capture({ jar: ["target-cookie"], unrelated: true, scopedUrl: baseOpts.targetUrl });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "target-cookie" } });
  });

  it("scopes the cookie query to exactly the target URL, not just to some URL", async () => {
    // With any other argument (the profile path, an origin, an empty string) the
    // unrelated host's cookie is visible and wins.
    const result = await capture({ jar: ["target-cookie"], unrelated: true, scopedUrl: "https://elsewhere.example/" });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "UNRELATED-OTHER-HOST" } });
  });

  it("launches a headed persistent context on the given profile directory and closes it exactly once", async () => {
    const { stderr } = await runCapture({ jar: ["c"] });

    const [launch] = stubEvent(stderr, "STUB_LAUNCH") as { profile: string; options: Record<string, unknown> }[];
    expect(launch.profile).toBe(join(dir, "profile"));
    expect(launch.options).toMatchObject({ headless: false, userAgent: baseOpts.userAgent, viewport: null });
    expect(stderr.split("\n").filter((line) => line === "STUB_CLOSE")).toHaveLength(1);
  });

  it("accepts native dialogs instead of letting them stall the login invisibly", async () => {
    const { stderr } = await runCapture({ jar: ["c"] });
    expect(stderr).toContain("STUB_DIALOG_ACCEPTED");
  });

  it("probes the verify URL itself and does not follow the redirect, which is how a dead cookie shows", async () => {
    // Followed, SiteMinder's bounce lands on the logon page, answers 200 and the
    // dead cookie would read as live.
    const { stderr } = await runCapture({ jar: ["c"] }, { verify: true });

    const [probe] = stubEvent(stderr, "STUB_PROBE") as { url: string; opts: Record<string, unknown> }[];
    expect(probe.url).toBe(baseOpts.targetUrl);
    expect(probe.opts).toMatchObject({ maxRedirects: 0, failOnStatusCode: false });
  });

  it("does not reject a live cookie because an in-app redirect mentions login", async () => {
    const result = await capture(
      { jar: ["live-cookie"], probes: { "live-cookie": { status: 302, location: "/int/jenkins/job/login-service/" } } },
      { verify: true, pollBudgetMs: 400 }
    );
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "live-cookie" } });
  });

  it("treats a failed probe as unknown: it re-checks and accepts once the server answers live", async () => {
    const result = await capture({ jar: ["live-cookie"], probeThrows: 2 }, { verify: true });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "live-cookie" } });
  });

  it("does not accept a cookie merely because the probe failed: a later dead answer still rejects it", async () => {
    // Together with the test above this tells "unknown, ask again" apart from
    // "live, accept": accepting on failure would return ok here.
    const result = await capture(
      {
        jar: ["c"],
        probeThrows: 2,
        probes: { c: { status: 302, location: "https://logon7.gov.bc.ca/clp-cgi/logon.cgi" } },
      },
      { verify: true, pollBudgetMs: 500 }
    );
    expect(result.status).toBe("error");
  });

  it("skips a cookie whose probe is bounced to SiteMinder's fedLaunch hop until a working one appears", async () => {
    const result = await capture(
      {
        jar: ["stale-cookie", "stale-cookie", "fresh-cookie"],
        probes: {
          "stale-cookie": { status: 302, location: "https://apps.example.gov.bc.ca/fedLaunch?target=jenkins" },
          "fresh-cookie": { status: 302, location: "/int/confluence/dashboard.action" },
        },
      },
      { verify: true }
    );
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "fresh-cookie" } });
  });

  it("reports a failure inside the capture as the documented JSON error line, not a stack trace", async () => {
    // A closed login window makes context.cookies() reject. That used to be an
    // unhandled rejection: empty stdout and exit 1, so the caller surfaced the
    // whole script text as the error message.
    const { result } = await runCapture({ jar: ["c"], cookiesThrow: true });

    expect(result.status).toBe("error");
    expect(result.message).toBe("Capture failed: Target page, context or browser has been closed");
  });

  describe("the probe's verdicts", () => {
    const probesOf = (stderr: string) => stubEvent(stderr, "STUB_PROBE") as { opts: Record<string, unknown> }[];

    it.each([401, 403])("a %i answer means the cookie is dead: it is never accepted and is asked about once", async (status) => {
      const { result, stderr } = await runCapture(
        { jar: ["stale-cookie"], probes: { "stale-cookie": { status } } },
        { verify: true, pollBudgetMs: 400 }
      );

      expect(result.status).toBe("error");
      expect(probesOf(stderr)).toHaveLength(1);
    });

    it.each([404, 500, 502, 503])(
      "a %i answer is no answer: the cookie is never accepted on it, and it is asked about again",
      async (status) => {
        // Accepting here would cache an unverified cookie whenever the gateway is unwell.
        const { result, stderr } = await runCapture(
          { jar: ["unverified-cookie"], probes: { "unverified-cookie": { status } } },
          { verify: true, pollBudgetMs: 400 }
        );

        expect(result.status).toBe("error");
        expect(probesOf(stderr).length).toBeGreaterThan(1);
      }
    );

    it("bounds every probe with the timeout the time budget counts", async () => {
      const { stderr } = await runCapture({ jar: ["c"] }, { verify: true });

      expect(probesOf(stderr)[0].opts).toMatchObject({ timeout: CAPTURE_PROBE_TIMEOUT_MS });
    });
  });

  describe("starting the browser", () => {
    const BUSY = "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.";
    const launchesOf = (stderr: string) => stubEvent(stderr, "STUB_LAUNCH").length;

    it("tries again when the profile is still held by a browser that is shutting down, then logs in", async () => {
      // A launcher that was killed leaves its browser holding the profile for
      // a moment; a login that starts then used to fail, and the failure was
      // remembered for everyone for 30 seconds.
      const { result, stderr } = await runCapture({ jar: ["c"], launchFailures: { count: 2, message: BUSY } });

      expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "c" } });
      expect(launchesOf(stderr)).toBe(3);
    });

    it("gives up, with the real reason, if the profile stays busy", async () => {
      const { result, stderr } = await runCapture({ jar: ["c"], launchFailures: { count: 100, message: BUSY } });

      expect(result.status).toBe("error");
      expect(result.message).toMatch(/^Capture failed: browserType\.launchPersistentContext: Failed to create a ProcessSingleton/);
      expect(launchesOf(stderr)).toBe(6);
    }, 15_000);

    it("does not retry a failure that waiting cannot fix, such as a browser that is not installed", async () => {
      const { result, stderr } = await runCapture({
        jar: ["c"],
        launchFailures: { count: 100, message: "browserType.launchPersistentContext: Executable doesn't exist at /x/chrome" },
      });

      expect(result.message).toBe("Capture failed: browserType.launchPersistentContext: Executable doesn't exist at /x/chrome");
      expect(launchesOf(stderr)).toBe(1);
    });
  });

  describe("when the person closes the login window", () => {
    it("ends the capture with a message saying so, instead of holding the lock for the rest of the budget", async () => {
      // On macOS the browser keeps running with no window, so nothing else
      // notices; the poll used to run its whole 2 to 3 minutes.
      const started = Date.now();
      const { result, stderr } = await runCapture({ jar: [null], pagesGoneAfterMs: 50 }, { pollBudgetMs: 30_000 });

      expect(result).toEqual({ status: "error", message: "The login window was closed before the login finished" });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(stderr.split("\n").filter((line) => line === "STUB_CLOSE")).toHaveLength(1);
    });

    it("still takes a session that was already live when the window closed", async () => {
      const result = await capture({ jar: ["live-cookie"], pagesGoneAfterMs: 0 });

      expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "live-cookie" } });
    });
  });

  it("logs navigation URLs without their query string or fragment when debugging", async () => {
    // SiteMinder/SAML hops carry tokens and targets in the query string.
    const { stderr } = await runCapture(
      { jar: ["c"], navUrl: "https://logon.example.gov.bc.ca/clp-cgi/x?SAMLRequest=SECRET-TOKEN&TARGET=abc#frag" },
      { debug: true }
    );
    expect(stderr).toContain("https://logon.example.gov.bc.ca/clp-cgi/x");
    expect(stderr).not.toContain("SECRET-TOKEN");
    expect(stderr).not.toContain("TARGET");
    expect(stderr).not.toContain("frag");
  });

  it("logs nothing about navigation unless debugging is on", async () => {
    const { stderr } = await runCapture({ jar: ["c"], navUrl: "https://logon.example.gov.bc.ca/x" }, { debug: false });
    expect(stderr).not.toContain("[capture]");
  });

  it("never reads RAVEN_AUTH_DEBUG itself: the caller decides, so RAVEN_AUTH_DEBUG=0 cannot switch logging on", () => {
    expect(buildCaptureScript({ ...baseOpts, debug: true })).not.toContain("RAVEN_AUTH_DEBUG");
    expect(buildCaptureScript({ ...baseOpts })).not.toContain("RAVEN_AUTH_DEBUG");
  });

  it("emits only finite numeric literals, whatever the numeric options are", () => {
    // buildCaptureScript is a public export and interpolates these into code.
    const script = buildCaptureScript({
      ...baseOpts,
      navTimeoutMs: Number.NaN,
      pollBudgetMs: Number.POSITIVE_INFINITY,
      pollIntervalMs: -5,
    });
    expect(script).not.toMatch(/\bNaN\b|\bInfinity\b/);
    expect(() => new Script(script)).not.toThrow();
    // A negative or zero interval would spin the poll loop; it is clamped to a sane floor.
    const interval = /new Promise\(\(r\) => setTimeout\(r, (-?\d+(?:\.\d+)?)\)\)/.exec(script);
    expect(Number(interval?.[1])).toBeGreaterThanOrEqual(10);
  });

  it("does not probe when no verify URL is given, as for the SharePoint capture", async () => {
    const result = await capture({
      jar: ["any-cookie"],
      probes: { "any-cookie": { status: 302, location: "https://login.example/logon" } },
    });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "any-cookie" } });
  });

  describe("the SharePoint capture (FedAuth + rtFa on sharepoint.com)", () => {
    const sharePoint: Partial<CaptureScriptOptions> = {
      cookieNames: ["FedAuth", "rtFa"],
      cookieDomainFilter: "sharepoint.com",
      targetUrl: "https://example.sharepoint.com",
    };
    const fedAuth = (domain: string, value: string) => ({ name: "FedAuth", domain, value });
    const rtFa = (domain: string, value: string) => ({ name: "rtFa", domain, value });

    it("needs both cookies, and counts only those on a sharepoint.com domain", async () => {
      const result = await capture(
        {
          jar: [null],
          rawJar: [
            [fedAuth("example.sharepoint.com", "fa1")], // rtFa still missing: keep polling
            [fedAuth("other.example", "foreign-fa"), rtFa(".sharepoint.com", "rt1")], // FedAuth only from a foreign domain
            [
              fedAuth("example.sharepoint.com", "fa1"),
              rtFa(".sharepoint.com", "rt1"),
              rtFa("other.example", "foreign-rt"),
            ],
          ],
        },
        { scriptOpts: sharePoint }
      );

      expect(result).toEqual({ status: "ok", cookies: { FedAuth: "fa1", rtFa: "rt1" } });
    });

    it("fails, naming what is missing, when only one of the two ever appears", async () => {
      const result = await capture(
        { jar: [null], rawJar: [[fedAuth("example.sharepoint.com", "fa1")]] },
        { pollBudgetMs: 300, scriptOpts: sharePoint }
      );

      expect(result.status).toBe("error");
      expect(result.message).toMatch(/Cookies not captured within \d+s: rtFa/);
    });
  });

  describe("the script's own copy of the login rules agrees with isLoginRedirect", () => {
    // The script cannot import the TypeScript function, so it embeds the same
    // patterns. Running each Location through the script as a probe answer and
    // comparing with isLoginRedirect catches the two copies drifting apart.
    it.each([
      "https://logon7.gov.bc.ca/clp-cgi/capBceid/logon.cgi?SMAGENTNAME=x",
      "https://login.microsoftonline.com/tenant/oauth2/authorize",
      "https://loginproxy.gov.bc.ca/auth/realms/standard",
      "/siteminderagent/forms/login.fcc",
      "https://apps.example.gov.bc.ca/clp-cgi/dirSelect.cgi?x=1",
      "https://apps.example.gov.bc.ca/fedLaunch?target=jenkins",
      "https://apps.example.gov.bc.ca/int/x?fedLaunch=1",
      "https://apps.example.gov.bc.ca/x?SMAUTHREASON=0",
      "/int/confluence/dashboard.action",
      "/job/login-service/",
      "/int/jenkins/job/fedlaunch-notes/",
      "https://jenkins.example.gov.bc.ca/int/jenkins/job/logon-audit/lastBuild/",
    ])("treats %s the same way", async (location) => {
      const result = await capture(
        { jar: ["c"], probes: { c: { status: 302, location } } },
        { verify: true, pollBudgetMs: 300 }
      );

      // A login redirect means the cookie is dead, so it is never accepted.
      expect(result.status).toBe(isLoginRedirect(302, location) ? "error" : "ok");
    });
  });
});

/**
 * Autofill behaviour, driven through the real generated script against a stub
 * page. The stub classifies locators by the exact selector strings the script
 * uses, fires the page's "load" handlers, and reports every fill and click on
 * stderr, so the tests can assert what would have been typed and where.
 */
describe("capture script autofill", () => {
  let dir: string;

  interface Field {
    /** Milliseconds after the page loads before the field is rendered. */
    visibleAfterMs?: number;
    /** What the field already contains. */
    value?: string;
  }
  interface PageState {
    url: string;
    user?: Field;
    pass?: Field;
    kmsi?: Field;
    /** A hidden input matches the login selectors before the visible one, as a password-manager shim or decoy would. */
    hiddenFirst?: boolean;
  }
  interface Scenario {
    pages: PageState[];
    /** Number of load events to fire; later ones reuse the last page. Default: pages.length. */
    loads?: number;
    /** Pause between load events. Default 20 ms. */
    gapMs?: number;
    /** A submit click clears the password field again, as a rejected login re-renders the form. */
    rejectPassword?: boolean;
    /** How long the stub waits after the last load event before the capture may finish. Default 400 ms. */
    settleMs?: number;
    /**
     * Navigate to the second page this many milliseconds after the first one loads, as a
     * page-initiated redirect would: the first page is the only one that loads on its own.
     */
    navigateAfterMs?: number;
  }
  interface AutofillEvent {
    type: "fill" | "click";
    field?: string;
    value?: string;
    target?: string;
    timeout?: number;
  }

  const STUB = `
    const cfg = JSON.parse(process.env.STUB_CONFIG);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const USER_SEL = 'input[name="loginfmt"], input[type="email"], input[name="user"], input[name="username"], input#user';
    const PASS_SEL = 'input[type="password"]';
    const SUBMIT_SEL = '#idSIButton9, input[type="submit"], button[type="submit"]';
    const KMSI_SEL = '#idSIButton9';
    const events = [];
    const handlers = { load: [] };
    let pageIndex = 0;
    let loadedAt = Date.now();
    const current = () => cfg.pages[Math.min(pageIndex, cfg.pages.length - 1)];
    const shown = (f) => !!f && Date.now() - loadedAt >= (f.visibleAfterMs || 0);

    // Playwright calls are round trips to the browser, so each one yields: a pass
    // really is interleaved with load events that arrive while it runs.
    const roundTrip = () => sleep(3);

    function locator(sel, visibleOnly) {
      const kind = sel === USER_SEL ? 'user'
        : sel === PASS_SEL ? 'pass'
        : sel === SUBMIT_SEL ? 'submit'
        : sel === KMSI_SEL ? 'kmsi'
        : sel === USER_SEL + ', ' + PASS_SEL ? 'any'
        : 'unknown:' + sel;
      const isShown = () => {
        const p = current();
        // Unfiltered, a union locator's first match is the hidden element.
        if (kind === 'any' && p.hiddenFirst && !visibleOnly) return false;
        if (kind === 'user') return shown(p.user);
        if (kind === 'pass') return shown(p.pass);
        if (kind === 'any' || kind === 'submit') return shown(p.user) || shown(p.pass);
        if (kind === 'kmsi') return shown(p.kmsi);
        return false;
      };
      const self = {
        first: () => self,
        filter: (o) => locator(sel, !!(o && o.visible)),
        isVisible: async () => { await roundTrip(); return isShown(); },
        waitFor: async (o) => {
          const end = Date.now() + ((o && o.timeout) || 30000);
          while (Date.now() < end) { if (isShown()) return; await sleep(10); }
          throw new Error('Timeout waiting for ' + kind);
        },
        inputValue: async () => { await roundTrip(); const f = current()[kind]; return (f && f.value) || ''; },
        fill: async (v, o) => {
          await roundTrip();
          const f = current()[kind];
          events.push({ type: 'fill', field: kind, value: v, timeout: o && o.timeout });
          if (f) f.value = v;
        },
        click: async () => {
          await roundTrip();
          events.push({ type: 'click', target: kind });
          if (kind === 'submit' && cfg.rejectPassword && current().pass) current().pass.value = '';
        },
      };
      return self;
    }

    const frame = { url: () => cfg.pages[0].url };
    const page = {
      url: () => current().url,
      on(evt, cb) { if (handlers[evt]) handlers[evt].push(cb); },
      mainFrame() { return frame; },
      locator,
      goto: async () => {
        const redirects = cfg.navigateAfterMs !== undefined;
        const loads = redirects ? 1 : cfg.loads || cfg.pages.length;
        for (let i = 0; i < loads; i += 1) {
          pageIndex = i;
          loadedAt = Date.now();
          handlers.load.forEach((cb) => cb());
          await sleep(cfg.gapMs === undefined ? 20 : cfg.gapMs);
        }
        if (redirects) {
          // The page navigates itself while an autofill pass is still waiting for a field.
          await sleep(cfg.navigateAfterMs);
          pageIndex = 1;
          loadedAt = Date.now();
          handlers.load.forEach((cb) => cb());
        }
        await sleep(cfg.settleMs || 400);
      },
    };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      close: async () => { process.stderr.write('STUB_EVENTS ' + JSON.stringify(events) + '\\n'); },
      cookies: async () => [{ name: 'SMSESSION', domain: '.gov.bc.ca', value: 'real-cookie' }],
      request: { get: async () => ({ status: () => 200, headers: () => ({}) }) },
    };
    module.exports = { chromium: { launchPersistentContext: async () => context } };
  `;

  const USER = "jdoe@example.gov.bc.ca";
  const PASSWORD = "correct-horse-battery";
  const IDP = "https://logon7.gov.bc.ca/clp-cgi/capBceid/logon.cgi";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capture-autofill-"));
    await mkdir(join(dir, "node_modules", "playwright"), { recursive: true });
    await writeFile(join(dir, "node_modules", "playwright", "index.js"), STUB);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function autofill(
    scenario: Scenario,
    env: Record<string, string | undefined> = { RAVEN_AUTOFILL_USERNAME: USER, RAVEN_AUTOFILL_PASSWORD: PASSWORD }
  ): Promise<AutofillEvent[]> {
    const script = buildCaptureScript({
      ...baseOpts,
      profileDir: join(dir, "profile"),
      navTimeoutMs: 2000,
      pollBudgetMs: 3000,
      pollIntervalMs: 10,
      autofill: true,
    });
    const { stderr } = await execFileAsync("node", ["-e", script], {
      cwd: dir,
      env: { ...process.env, ...env, STUB_CONFIG: JSON.stringify(scenario) } as NodeJS.ProcessEnv,
    });
    const line = stderr.split("\n").find((l) => l.startsWith("STUB_EVENTS "));
    return JSON.parse((line ?? "STUB_EVENTS []").slice("STUB_EVENTS ".length)) as AutofillEvent[];
  }

  const fills = (events: AutofillEvent[], field: string) => events.filter((e) => e.type === "fill" && e.field === field);
  const clicks = (events: AutofillEvent[]) => events.filter((e) => e.type === "click");

  it("fills the username and the password once each on a normal login form", async () => {
    const events = await autofill({ pages: [{ url: IDP, user: {}, pass: {} }] });

    expect(fills(events, "user").map((e) => e.value)).toEqual([USER]);
    expect(fills(events, "pass").map((e) => e.value)).toEqual([PASSWORD]);
    expect(clicks(events)).toHaveLength(1);
  });

  it("walks a two-step login: username page first, then the password page", async () => {
    const events = await autofill({
      pages: [
        { url: "https://login.microsoftonline.com/common/login", user: {} },
        { url: "https://login.microsoftonline.com/common/login", pass: {} },
      ],
    });

    expect(fills(events, "user")).toHaveLength(1);
    expect(fills(events, "pass")).toHaveLength(1);
    expect(clicks(events)).toHaveLength(2);
  });

  it("submits the password only once per capture, even if the form comes back because it was rejected", async () => {
    // Every further submit of a rejected password is another failed IDIR
    // login; a handful of them locks the account.
    const events = await autofill({
      pages: [{ url: IDP, pass: {} }],
      loads: 5,
      rejectPassword: true,
    });

    expect(fills(events, "pass")).toHaveLength(1);
    expect(clicks(events)).toHaveLength(1);
  });

  it("never types into a page that is not https", async () => {
    const events = await autofill({ pages: [{ url: "http://logon7.gov.bc.ca/clp-cgi/logon.cgi", user: {}, pass: {} }] });
    expect(events).toEqual([]);
  });

  it.each([
    "https://logon7.gov.bc.ca.evil.example/login",
    "https://evil-logon7.gov.bc.ca/login",
    "https://login.microsoftonline.com.evil.example/login",
    "https://example.com/login",
  ])("never types into a look-alike or unrelated host: %s", async (url) => {
    const events = await autofill({ pages: [{ url, user: {}, pass: {} }] });
    expect(events).toEqual([]);
  });

  it("does not type the configured password for a different account the form is already showing", async () => {
    const events = await autofill({
      pages: [{ url: IDP, user: { value: "someone.else@example.gov.bc.ca" }, pass: {} }],
    });
    expect(events).toEqual([]);
  });

  it("carries on when the form is pre-filled with the same account, whatever its case", async () => {
    const events = await autofill({
      pages: [{ url: IDP, user: { value: USER.toUpperCase() }, pass: {} }],
    });
    expect(fills(events, "pass")).toHaveLength(1);
  });

  it("waits for a form that is rendered after the load event", async () => {
    // locator.isVisible({ timeout }) ignores the timeout and answers at once, so a
    // form a script renders shortly after load was never filled.
    const events = await autofill({
      pages: [{ url: IDP, user: { visibleAfterMs: 300 }, pass: { visibleAfterMs: 300 } }],
    });

    expect(fills(events, "user")).toHaveLength(1);
    expect(fills(events, "pass")).toHaveLength(1);
  });

  it("does not run two autofill passes at once when load events overlap", async () => {
    const events = await autofill({
      pages: [{ url: IDP, user: { visibleAfterMs: 150 }, pass: { visibleAfterMs: 150 } }],
      loads: 4,
      gapMs: 0,
    });

    expect(fills(events, "user")).toHaveLength(1);
    expect(fills(events, "pass")).toHaveLength(1);
  });

  it("answers Entra's Stay signed in prompt", async () => {
    // The page has no login fields, so the pass first waits out its field
    // timeout before looking for the prompt; give the stub time to let it.
    const events = await autofill({
      pages: [{ url: "https://login.microsoftonline.com/common/kmsi", kmsi: {} }],
      settleMs: 2500,
    });
    expect(clicks(events)).toEqual([{ type: "click", target: "kmsi" }]);
  });

  it("does nothing without credentials in the environment", async () => {
    const events = await autofill(
      { pages: [{ url: IDP, user: {}, pass: {} }] },
      { RAVEN_AUTOFILL_USERNAME: undefined, RAVEN_AUTOFILL_PASSWORD: undefined }
    );
    expect(events).toEqual([]);
  });

  it("fills a form whose visible field comes after a hidden one that matches the same selectors", async () => {
    // Waiting on the first match in the page, visible or not, timed out here
    // and typed nothing (and on Entra then clicked Sign in with the field empty).
    const events = await autofill({ pages: [{ url: IDP, pass: {}, hiddenFirst: true }] });

    expect(fills(events, "pass").map((e) => e.value)).toEqual([PASSWORD]);
    expect(clicks(events)).toHaveLength(1);
  });

  it("gives every fill a short timeout, so a field that cannot be edited does not hold the pass for 30 seconds", async () => {
    const events = await autofill({ pages: [{ url: IDP, user: {}, pass: {} }] });

    expect(events.filter((e) => e.type === "fill").map((e) => e.timeout)).toEqual([3000, 3000]);
  });

  it("does not click the Stay signed in button while a login form is showing: it is the same button as Next and Sign in", async () => {
    // The form renders after the first wait gives up, so the pass looks for the
    // prompt and finds the form's own button.
    const events = await autofill({
      pages: [{ url: "https://login.microsoftonline.com/common/login", user: { visibleAfterMs: 1700 }, kmsi: { visibleAfterMs: 1700 } }],
      settleMs: 4000,
    });

    expect(clicks(events)).toEqual([]);
  });

  it.each([
    ["a bare id and the same id as an address", "jdoe", "jdoe@gov.bc.ca", true],
    ["an address and the same id with a DOMAIN\\ prefix", "jdoe@gov.bc.ca", "IDIR\\JDOE", true],
    ["a DOMAIN\\ prefix and a bare id", "idir\\jdoe", "JDOE", true],
    ["the same address in another case", "JDoe@Gov.BC.ca", "jdoe@gov.bc.ca", true],
    ["a bare id and a different id", "jdoe", "asmith", false],
    ["a short id and a differently built address", "jdoe", "jane.doe@gov.bc.ca", false],
    ["two addresses on different domains", "jdoe@gov.bc.ca", "jdoe@contractor.example", false],
  ])("treats %s as the same account: %s configured, %s shown", async (_what, configured, shown, same) => {
    const events = await autofill(
      { pages: [{ url: IDP, user: { value: shown as string }, pass: {} }] },
      { RAVEN_AUTOFILL_USERNAME: configured as string, RAVEN_AUTOFILL_PASSWORD: PASSWORD }
    );

    expect(fills(events, "pass")).toHaveLength(same ? 1 : 0);
    expect(fills(events, "user")).toHaveLength(0); // already filled in, never overwritten
  });

  describe("when the page navigates while a pass is waiting for a field", () => {
    // The host is vetted when a pass starts, but the pass then waits, and
    // locators follow the page rather than the document: a redirect during the
    // wait would otherwise have the credentials typed into the new page.
    const STILL_LOADING = { visibleAfterMs: 60_000 };

    it("does not type into a page on a host that is not allowed", async () => {
      const events = await autofill({
        pages: [
          { url: IDP, user: STILL_LOADING },
          { url: "https://other-site.example/login", user: {}, pass: {} },
        ],
        navigateAfterMs: 120,
        settleMs: 800,
      });

      expect(events).toEqual([]);
    });

    it("does not type into a page that is not https", async () => {
      const events = await autofill({
        pages: [
          { url: IDP, user: STILL_LOADING },
          { url: "http://logon7.gov.bc.ca/clp-cgi/logon.cgi", user: {}, pass: {} },
        ],
        navigateAfterMs: 120,
        settleMs: 800,
      });

      expect(events).toEqual([]);
    });

    it("leaves the Stay signed in prompt of a page that is not allowed unanswered", async () => {
      const events = await autofill({
        pages: [
          { url: "https://login.microsoftonline.com/common/login" },
          { url: "https://other-site.example/kmsi", kmsi: {} },
        ],
        navigateAfterMs: 120,
        settleMs: 3000,
      });

      expect(events).toEqual([]);
    });

    it("hands over to the pass for the new page when that page is an allowed one, and fills it exactly once", async () => {
      const events = await autofill({
        pages: [
          { url: "https://login.microsoftonline.com/common/login", user: STILL_LOADING },
          { url: "https://login.microsoftonline.com/common/password", pass: {} },
        ],
        navigateAfterMs: 120,
        settleMs: 1200,
      });

      expect(fills(events, "user")).toHaveLength(0);
      expect(fills(events, "pass").map((e) => e.value)).toEqual([PASSWORD]);
      expect(clicks(events)).toHaveLength(1);
    });
  });
});

describe("capture script when Playwright cannot be loaded", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capture-noplaywright-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("still prints its one JSON error line and exits 0, naming the missing module", async () => {
    // The require() used to sit outside the script's catch-all, so a broken
    // install ended in an uncaught exception and a stack trace on stderr.
    const script = buildCaptureScript({ ...baseOpts, profileDir: join(dir, "profile"), autofill: false });

    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", script], {
      cwd: dir,
      env: { ...process.env, NODE_PATH: "" },
    });

    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      status: "error",
      message: expect.stringMatching(/^Capture failed: Cannot find module 'playwright'/),
    });
    expect(stderr).toBe("");
  });
});

describe("capture script parent watchdog", () => {
  // A stub Playwright that records the capture child's pid when the launch
  // starts, optionally takes a long time to launch, and records a clean close.
  const STUB = `
    const fs = require('node:fs');
    const context = {
      pages: () => [{ url: () => 'about:blank', on() {}, goto: async () => {}, mainFrame() {} }],
      newPage: async () => ({}),
      close: async () => { fs.writeFileSync(process.env.CLOSED_FILE, '1'); },
      cookies: async () => [{ name: 'SMSESSION', domain: '.gov.bc.ca', value: 'LOGGEDOFF' }],
      request: { get: async () => ({ status: () => 200, headers: () => ({}) }) },
    };
    module.exports = { chromium: { launchPersistentContext: async () => {
      fs.writeFileSync(process.env.PID_FILE, String(process.pid));
      if (process.env.LAUNCH_MS) await new Promise((r) => setTimeout(r, Number(process.env.LAUNCH_MS)));
      return context;
    } } };
  `;

  let dir: string;
  let pidFile: string;
  let closedFile: string;
  let childPid = 0;
  let parent: ReturnType<typeof spawn> | undefined;

  const until = async (predicate: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return predicate();
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capture-watchdog-"));
    pidFile = join(dir, "child.pid");
    closedFile = join(dir, "closed");
    childPid = 0;
    await mkdir(join(dir, "node_modules", "playwright"), { recursive: true });
    await writeFile(join(dir, "node_modules", "playwright", "index.js"), STUB);
  });

  afterEach(async () => {
    parent?.kill("SIGKILL");
    if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  const script = () =>
    buildCaptureScript({ ...baseOpts, profileDir: join(dir, "profile"), navTimeoutMs: 1000, pollBudgetMs: 60_000, pollIntervalMs: 50 });

  /**
   * Run the capture the way SessionManager does (a Node process that execFileSync's
   * the script), wait for the child to reach the browser launch, and return its pid.
   */
  async function startLauncher(opts: { launchMs?: number; announceParent: boolean }): Promise<number> {
    await writeFile(
      join(dir, "parent.mjs"),
      `import { execFileSync } from "node:child_process";\n` +
        `const env = { ...process.env${opts.announceParent ? ", RAVEN_CAPTURE_PARENT_PID: String(process.pid)" : ""} };\n` +
        `execFileSync(process.execPath, ["-e", ${JSON.stringify(script())}], { cwd: ${JSON.stringify(dir)}, stdio: "ignore", env });\n`
    );
    parent = spawn(process.execPath, [join(dir, "parent.mjs")], {
      env: {
        ...process.env,
        PID_FILE: pidFile,
        CLOSED_FILE: closedFile,
        ...(opts.launchMs ? { LAUNCH_MS: String(opts.launchMs) } : {}),
      },
      stdio: "ignore",
    });
    expect(await until(() => existsSync(pidFile), 10_000)).toBe(true);
    childPid = Number((await import("node:fs")).readFileSync(pidFile, "utf-8"));
    return childPid;
  }

  it.each([
    ["the launcher announces its pid, as SessionManager does", true],
    ["it only has its parent process to go by", false],
  ])("exits when the process that launched it dies, so an orphan cannot keep the browser profile: %s", async (_how, announceParent) => {
    // The lock names only the Node process that called execFileSync. If that
    // process is killed mid-capture the capture child survives it and keeps
    // the Chromium profile, so the next owner's launch fails on the profile
    // lock. The child therefore watches its parent and shuts down with it.
    await startLauncher({ announceParent });

    parent?.kill("SIGKILL");

    expect(await until(() => !alive(childPid), 8_000)).toBe(true);
    expect(existsSync(closedFile)).toBe(true); // it closed the browser context on the way out
  }, 30_000);

  it("exits when the launcher dies while the browser is still starting, not only after the launch has finished", async () => {
    // A launch can take 20 seconds or more on a loaded machine. The watchdog
    // used to be armed only once it had finished, so a launcher killed in that
    // window left a capture that ran on for minutes, holding the profile.
    await startLauncher({ launchMs: 60_000, announceParent: true });

    parent?.kill("SIGKILL");

    expect(await until(() => !alive(childPid), 8_000)).toBe(true);
  }, 30_000);

  it("does not start at all when its launcher is already gone", async () => {
    // The launcher can die between spawning the child and the child's first
    // line; by then the child has been adopted by init and has no parent to watch.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;

    const { code } = await new Promise<{ code: number | null }>((resolve) => {
      const child = spawn(process.execPath, ["-e", script()], {
        cwd: dir,
        env: { ...process.env, PID_FILE: pidFile, CLOSED_FILE: closedFile, RAVEN_CAPTURE_PARENT_PID: String(gone) },
        stdio: "ignore",
      });
      child.on("exit", (exitCode) => resolve({ code: exitCode }));
    });

    expect(code).toBe(1);
    expect(existsSync(pidFile)).toBe(false); // it never reached the browser launch
  }, 20_000);
});
