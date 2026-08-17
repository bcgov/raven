import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  authProfileDir,
  buildCaptureScript,
  ensureProfileDir,
  resolveAutofillCredentials,
  siteMinderProbeUrl,
  siteMinderWebUrl,
} from "../capture-script.js";

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
