import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Script } from "node:vm";
import {
  CAPTURE_TIMINGS,
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

describe("CAPTURE_TIMINGS", () => {
  const PROBE_OVERRUN_MS = 15_000; // the budget is checked only at the top of each poll, so one probe can overrun it
  const DEFAULT_LOCK_STALE_MS = 300_000;

  it.each(Object.entries(CAPTURE_TIMINGS))(
    "%s: the script's worst case fits inside the process timeout, which stays under the lock's stale limit",
    (_name, timings) => {
      // The script's worst case is navigation plus polling. If the process
      // timeout were shorter, a stalled navigation would end in an opaque
      // ETIMEDOUT instead of the script's own message.
      expect(timings.navTimeoutMs + timings.pollBudgetMs + PROBE_OVERRUN_MS).toBeLessThan(timings.processTimeoutMs);
      expect(timings.processTimeoutMs).toBeLessThan(DEFAULT_LOCK_STALE_MS);
    }
  );
});

describe("describeCaptureFailure", () => {
  it("prefers the first line the child wrote to stderr, which is what actually went wrong", () => {
    const err = Object.assign(new Error("Command failed: /usr/bin/node -e \nconst { chromium } = require('playwright');"), {
      stderr: "\nError: Cannot find module 'playwright'\n    at Module._resolveFilename (node:internal)\n",
    });
    expect(describeCaptureFailure(err)).toBe("Error: Cannot find module 'playwright'");
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
    /** Add an unrelated host's SMSESSION to the jar, visible only to an unscoped cookie query. */
    unrelated?: boolean;
    /** URL the main frame reports on navigation (for the debug-logging test). */
    navUrl?: string;
    /** Make context.cookies reject, as it does after the user closes the login window. */
    cookiesThrow?: boolean;
    /** Full cookie jars per poll (last repeats); when set it replaces the SMSESSION-only jar. */
    rawJar?: { name: string; domain: string; value: string }[][];
  }

  const STUB = `
    const cfg = JSON.parse(process.env.STUB_CONFIG);
    let polls = 0, probeCalls = 0, current = null;
    const frame = { url: () => cfg.navUrl || 'about:blank' };
    const navHandlers = [];
    const page = {
      url: () => 'about:blank',
      on(evt, cb) { if (evt === 'framenavigated') navHandlers.push(cb); },
      goto: async () => { navHandlers.forEach((cb) => cb(frame)); },
      mainFrame() { return frame; },
    };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
      cookies: async (urls) => {
        if (cfg.cookiesThrow) throw new Error('Target page, context or browser has been closed\\n    at secret/stack/frame.js:1:1');
        if (cfg.rawJar) return cfg.rawJar[Math.min(polls++, cfg.rawJar.length - 1)];
        current = cfg.jar[Math.min(polls++, cfg.jar.length - 1)];
        const jar = current === null ? [] : [{ name: 'SMSESSION', domain: '.gov.bc.ca', value: current }];
        // Like Playwright: with URLs, only cookies the browser would send there.
        if (cfg.unrelated && !urls) jar.push({ name: 'SMSESSION', domain: 'other.example', value: 'UNRELATED-OTHER-HOST' });
        return jar;
      },
      request: { get: async () => {
        probeCalls += 1;
        if (probeCalls <= (cfg.probeThrows || 0)) throw new Error('net::ERR_INTERNET_DISCONNECTED');
        const answer = (cfg.probes || {})[current] || { status: 200 };
        return { status: () => answer.status, headers: () => (answer.location ? { location: answer.location } : {}) };
      } },
    };
    module.exports = { chromium: { launchPersistentContext: async () => context } };
  `;

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
    const result = await capture({ jar: ["target-cookie"], unrelated: true });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "target-cookie" } });
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
  }
  interface AutofillEvent {
    type: "fill" | "click";
    field?: string;
    value?: string;
    target?: string;
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

    function locator(sel) {
      const kind = sel === USER_SEL ? 'user'
        : sel === PASS_SEL ? 'pass'
        : sel === SUBMIT_SEL ? 'submit'
        : sel === KMSI_SEL ? 'kmsi'
        : sel === USER_SEL + ', ' + PASS_SEL ? 'any'
        : 'unknown:' + sel;
      const isShown = () => {
        const p = current();
        if (kind === 'user') return shown(p.user);
        if (kind === 'pass') return shown(p.pass);
        if (kind === 'any' || kind === 'submit') return shown(p.user) || shown(p.pass);
        if (kind === 'kmsi') return shown(p.kmsi);
        return false;
      };
      const self = {
        first: () => self,
        isVisible: async () => isShown(),
        waitFor: async (o) => {
          const end = Date.now() + ((o && o.timeout) || 30000);
          while (Date.now() < end) { if (isShown()) return; await sleep(10); }
          throw new Error('Timeout waiting for ' + kind);
        },
        inputValue: async () => { const f = current()[kind]; return (f && f.value) || ''; },
        fill: async (v) => { const f = current()[kind]; events.push({ type: 'fill', field: kind, value: v }); if (f) f.value = v; },
        click: async () => {
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
        const loads = cfg.loads || cfg.pages.length;
        for (let i = 0; i < loads; i += 1) {
          pageIndex = i;
          loadedAt = Date.now();
          handlers.load.forEach((cb) => cb());
          await sleep(cfg.gapMs === undefined ? 20 : cfg.gapMs);
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
});

describe("capture script parent watchdog", () => {
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
      return context;
    } } };
  `;

  it("exits when the process that launched it dies, so an orphan cannot keep the browser profile", async () => {
    // The lock names only the Node process that called execFileSync. If that
    // process is killed mid-capture the capture child survives it and keeps
    // the Chromium profile, so the next owner's launch fails on the profile
    // lock. The child therefore watches its parent and shuts down with it.
    const dir = await mkdtemp(join(tmpdir(), "capture-watchdog-"));
    const pidFile = join(dir, "child.pid");
    const closedFile = join(dir, "closed");
    let childPid = 0;
    let parent: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(join(dir, "node_modules", "playwright"), { recursive: true });
      await writeFile(join(dir, "node_modules", "playwright", "index.js"), STUB);
      const script = buildCaptureScript({
        ...baseOpts,
        profileDir: join(dir, "profile"),
        navTimeoutMs: 1000,
        pollBudgetMs: 60_000,
        pollIntervalMs: 50,
      });
      await writeFile(
        join(dir, "parent.mjs"),
        `import { execFileSync } from "node:child_process";\n` +
          `execFileSync(process.execPath, ["-e", ${JSON.stringify(script)}], { cwd: ${JSON.stringify(dir)}, stdio: "ignore" });\n`
      );

      parent = spawn(process.execPath, [join(dir, "parent.mjs")], {
        env: { ...process.env, PID_FILE: pidFile, CLOSED_FILE: closedFile },
        stdio: "ignore",
      });
      const until = async (predicate: () => boolean, ms: number) => {
        const end = Date.now() + ms;
        while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
        return predicate();
      };
      expect(await until(() => existsSync(pidFile), 10_000)).toBe(true);
      childPid = Number((await import("node:fs")).readFileSync(pidFile, "utf-8"));

      parent.kill("SIGKILL");

      const alive = () => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(await until(() => !alive(), 8_000)).toBe(true);
      expect(existsSync(closedFile)).toBe(true); // it closed the browser context on the way out
    } finally {
      parent?.kill("SIGKILL");
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
