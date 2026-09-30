import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  authProfileDir,
  buildCaptureScript,
  ensureProfileDir,
  isLoginRedirect,
  resolveAutofillCredentials,
  siteMinderProbeUrl,
  siteMinderWebUrl,
  type CaptureResult,
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

  it("creates the directory with mode 0700", async () => {
    const target = join(dir, "profile");
    await ensureProfileDir(target);
    expect((await stat(target)).mode & 0o777).toBe(0o700);
  });

  it("re-tightens a pre-existing looser directory to 0700", async () => {
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

  it("honours the off switch", () => {
    expect(
      resolveAutofillCredentials({
        RAVEN_AUTH_AUTOFILL: "off",
        ATLASSIAN_EMAIL: "jane@example.com",
        ATLASSIAN_PASSWORD: "pw",
      })
    ).toBeNull();
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

describe("isLoginRedirect", () => {
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
  }

  const STUB = `
    const cfg = JSON.parse(process.env.STUB_CONFIG);
    let polls = 0, probeCalls = 0, current = null;
    const page = { url: () => 'about:blank', on() {}, goto: async () => {}, mainFrame() {} };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
      cookies: async () => {
        current = cfg.jar[Math.min(polls++, cfg.jar.length - 1)];
        return current === null ? [] : [{ name: 'SMSESSION', domain: '.gov.bc.ca', value: current }];
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

  async function capture(
    stub: StubConfig,
    opts: { verify?: boolean; pollBudgetMs?: number } = {}
  ): Promise<CaptureResult> {
    const script = buildCaptureScript({
      ...baseOpts,
      profileDir: join(dir, "profile"),
      navTimeoutMs: 1000,
      pollBudgetMs: opts.pollBudgetMs ?? 5000,
      pollIntervalMs: 10,
      ...(opts.verify ? { verifyUrl: baseOpts.targetUrl } : {}),
    });
    const { stdout } = await execFileAsync("node", ["-e", script], {
      cwd: dir,
      env: { ...process.env, STUB_CONFIG: JSON.stringify(stub) },
    });
    return JSON.parse(stdout.trim()) as CaptureResult;
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

  it("treats a failed probe as unknown and re-checks instead of accepting or rejecting", async () => {
    const result = await capture({ jar: ["live-cookie"], probeThrows: 2 }, { verify: true });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "live-cookie" } });
  });

  it("does not probe when no verify URL is given (SharePoint capture is unchanged)", async () => {
    const result = await capture({
      jar: ["any-cookie"],
      probes: { "any-cookie": { status: 302, location: "https://login.example/logon" } },
    });
    expect(result).toEqual({ status: "ok", cookies: { SMSESSION: "any-cookie" } });
  });
});
