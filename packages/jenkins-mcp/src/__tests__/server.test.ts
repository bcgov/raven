import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createBasicAuthFetch, type AuthenticatedFetch } from "@nrs/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JenkinsClient } from "../jenkins-client.js";
import {
  configuredBasicAuthCredentials,
  createJenkinsFetch,
  createJenkinsServer,
  withJenkinsSessionCookies,
} from "../server.js";

async function connectedClient(clientOverride: JenkinsClient) {
  const server = createJenkinsServer(clientOverride);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "jenkins-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const openConnections: Array<Awaited<ReturnType<typeof connectedClient>>> = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
  vi.unstubAllEnvs();
});

describe("Jenkins MCP server", () => {
  it("uses dedicated Jenkins credentials", () => {
    expect(configuredBasicAuthCredentials({
      JENKINS_USER: "jenkins-bot",
      JENKINS_PASSWORD: "jenkins-password",
      ATLASSIAN_EMAIL: "person@example.com",
      ATLASSIAN_PASSWORD: "atlassian-password",
    })).toEqual({ user: "jenkins-bot", password: "jenkins-password" });
  });

  it("retains Jenkins session cookies between the crumb request and write", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        crumbRequestField: "Jenkins-Crumb",
        crumb: "crumb-value",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "JSESSIONID=jenkins-session; Path=/jenkins; HttpOnly, BCGOVFlags=external-login-cookie; Path=/",
        },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const wrapped = withJenkinsSessionCookies(fetch, "https://jenkins.example.gov.bc.ca/jenkins");
    const client = new JenkinsClient(wrapped, "https://jenkins.example.gov.bc.ca/jenkins");

    await client.triggerBuild("Job");

    const headers = new Headers(fetch.mock.calls[1][1]?.headers);
    expect(headers.get("Cookie")).toBe("JSESSIONID=jenkins-session");
    expect(headers.get("Jenkins-Crumb")).toBe("crumb-value");
  });

  it("never sends retained Jenkins cookies outside the configured controller path", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("ok", {
        headers: { "Set-Cookie": "JSESSIONID=jenkins-session; Path=/jenkins; HttpOnly" },
      }))
      .mockResolvedValue(new Response("ok"));
    const wrapped = withJenkinsSessionCookies(fetch, "https://jenkins.example.gov.bc.ca/jenkins");

    await wrapped("https://jenkins.example.gov.bc.ca/jenkins/api/json");
    await wrapped("https://jenkins.example.gov.bc.ca/unrelated/api/json");
    await wrapped("https://other.example.gov.bc.ca/jenkins/api/json");

    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("Cookie")).toBeNull();
    expect(new Headers(fetch.mock.calls[2][1]?.headers).get("Cookie")).toBeNull();
  });

  it("does not replay Basic-Auth HTML errors through interactive session authentication", async () => {
    const basicFetch = vi.fn().mockResolvedValue(new Response("permission denied", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    }));
    const sessionFetch = vi.fn();
    const fetch = await createJenkinsFetch(
      "https://jenkins.example.gov.bc.ca/jenkins",
      { user: "jenkins-bot", password: "api-token" },
      {
        createBasicFetch: () => basicFetch,
        createSessionFetch: sessionFetch,
      },
    );

    const response = await fetch("https://jenkins.example.gov.bc.ca/jenkins/job/Missing/api/json");

    expect(response.status).toBe(403);
    expect(sessionFetch).not.toHaveBeenCalled();
    expect(basicFetch).toHaveBeenCalledTimes(1);
    expect(basicFetch.mock.calls[0][1]?.redirect).toBe("manual");
  });

  describe("Basic credentials sent to a SiteMinder-protected host", () => {
    const BASE = "https://apps.example.gov.bc.ca/int/jenkins";
    const SITEMINDER_REDIRECT = () =>
      new Response("<title>302 Found</title>", {
        status: 302,
        headers: { Location: "https://logon7.gov.bc.ca/clp-cgi/dirSelect.cgi?partner=fed67" },
      });
    const factoriesFor = (basicFetch: AuthenticatedFetch, sessionFetch: AuthenticatedFetch) => ({
      createBasicFetch: () => basicFetch,
      createSessionFetch: vi.fn().mockResolvedValue(sessionFetch),
    });

    // The switch prints a notice to stderr; capture it instead of letting it
    // spill into the test output, and so it can be asserted on.
    let stderrWrites: string[];
    beforeEach(() => {
      stderrWrites = [];
      vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("never forwards the Basic Authorization header to the session transport after the switch", async () => {
      // The security-critical negative: the credentials go to the SiteMinder
      // host once, are refused, and must not follow the request to the session.
      const wire = vi.fn().mockResolvedValue(SITEMINDER_REDIRECT());
      vi.stubGlobal("fetch", wire);
      const sessionFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const fetch = await createJenkinsFetch(
        BASE,
        { user: "jenkins-bot", password: "api-token-value" },
        { createBasicFetch: createBasicAuthFetch, createSessionFetch: vi.fn().mockResolvedValue(sessionFetch) },
      );

      await fetch(`${BASE}/api/json`, { headers: { Accept: "application/json" } });

      expect(new Headers(wire.mock.calls[0][1]?.headers).get("Authorization")).toMatch(/^Basic /);
      const replayed = sessionFetch.mock.calls[0][1] as RequestInit | undefined;
      expect(new Headers(replayed?.headers).get("Authorization")).toBeNull();
      expect(new Headers(replayed?.headers).get("Accept")).toBe("application/json");
    });

    it("prints one notice per switch, and it never contains the credentials", async () => {
      const basicFetch = vi.fn().mockImplementation(async () => SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
      const fetch = await createJenkinsFetch(
        BASE,
        { user: "jenkins-bot", password: "api-token-value" },
        factoriesFor(basicFetch, sessionFetch),
      );

      await fetch(`${BASE}/api/json`);
      await fetch(`${BASE}/job/A/api/json`);

      const notices = stderrWrites.filter((line) => line.includes("[raven-jenkins]"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).not.toContain("api-token-value");
      expect(notices[0]).not.toContain("jenkins-bot");
    });

    it.each([
      [301, "https://logon7.gov.bc.ca/clp-cgi/dirSelect.cgi"],
      [303, "https://logon7.gov.bc.ca/clp-cgi/dirSelect.cgi"],
      [307, "https://logon7.gov.bc.ca/clp-cgi/dirSelect.cgi"],
      [308, "https://logon7.gov.bc.ca/clp-cgi/dirSelect.cgi"],
      [302, "/siteminderagent/forms/login.fcc"],
      [302, "https://apps.example.gov.bc.ca/fedLaunch?target=jenkins"],
    ])("switches for a %i redirect to %s", async (status, location) => {
      const basicFetch = vi.fn().mockResolvedValue(new Response(null, { status, headers: { Location: location } }));
      const sessionFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const fetch = await createJenkinsFetch(
        BASE,
        { user: "jenkins-bot", password: "api-token" },
        factoriesFor(basicFetch, sessionFetch),
      );

      expect((await fetch(`${BASE}/api/json`)).status).toBe(200);
      expect(sessionFetch).toHaveBeenCalledTimes(1);
    });

    it("does not switch for a redirect that carries no Location", async () => {
      const basicFetch = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
      const factories = factoriesFor(basicFetch, vi.fn());
      const fetch = await createJenkinsFetch(BASE, { user: "jenkins-bot", password: "api-token" }, factories);

      expect((await fetch(`${BASE}/api/json`)).status).toBe(302);
      expect(factories.createSessionFetch).not.toHaveBeenCalled();
    });

    it("returns the session transport's own login redirect as-is rather than looping (a dead cached cookie)", async () => {
      const basicFetch = vi.fn().mockImplementation(async () => SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockImplementation(async () => SITEMINDER_REDIRECT());
      const fetch = await createJenkinsFetch(
        BASE,
        { user: "jenkins-bot", password: "api-token" },
        factoriesFor(basicFetch, sessionFetch),
      );

      const response = await fetch(`${BASE}/api/json`);

      expect(response.status).toBe(302);
      expect(basicFetch).toHaveBeenCalledTimes(1);
      expect(sessionFetch).toHaveBeenCalledTimes(1);
    });

    it("uses the session transport directly, never creating a Basic one, when no Basic credentials are configured", async () => {
      const sessionFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const createBasicFetch = vi.fn();
      const fetch = await createJenkinsFetch(BASE, null, {
        createBasicFetch,
        createSessionFetch: vi.fn().mockResolvedValue(sessionFetch),
      });

      expect((await fetch(`${BASE}/api/json`)).status).toBe(200);
      expect(createBasicFetch).not.toHaveBeenCalled();
      expect(stderrWrites.filter((line) => line.includes("[raven-jenkins]"))).toEqual([]);
    });

    it("falls back to the SiteMinder session when Basic auth is redirected to the login page", async () => {
      // SiteMinder intercepts before Jenkins can look at the Authorization header,
      // so Basic credentials can never succeed on that host: every call used to
      // fail with "Jenkins request failed (302)".
      const basicFetch = vi.fn().mockResolvedValue(SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const factories = factoriesFor(basicFetch, sessionFetch);
      const fetch = await createJenkinsFetch(BASE, { user: "jenkins-bot", password: "api-token" }, factories);

      const response = await fetch(`${BASE}/api/json`);

      expect(response.status).toBe(200);
      expect(factories.createSessionFetch).toHaveBeenCalledTimes(1);
      expect(sessionFetch).toHaveBeenCalledTimes(1);
    });

    it("stays on the session after the first redirect instead of retrying Basic on every call", async () => {
      const basicFetch = vi.fn().mockResolvedValue(SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const factories = factoriesFor(basicFetch, sessionFetch);
      const fetch = await createJenkinsFetch(BASE, { user: "jenkins-bot", password: "api-token" }, factories);

      await fetch(`${BASE}/api/json`);
      await fetch(`${BASE}/job/A/api/json`);
      await fetch(`${BASE}/job/B/api/json`);

      expect(basicFetch).toHaveBeenCalledTimes(1);
      expect(sessionFetch).toHaveBeenCalledTimes(3);
      expect(factories.createSessionFetch).toHaveBeenCalledTimes(1);
    });

    it("replays a POST body through the session after the redirect", async () => {
      const basicFetch = vi.fn().mockResolvedValue(SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
      const fetch = await createJenkinsFetch(
        BASE,
        { user: "jenkins-bot", password: "api-token" },
        factoriesFor(basicFetch, sessionFetch),
      );

      await fetch(`${BASE}/job/A/build`, { method: "POST", body: "a=1" });

      const init = sessionFetch.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(init.body).toBe("a=1");
    });

    it("creates the session once when calls race on the first redirect", async () => {
      const basicFetch = vi.fn().mockImplementation(async () => SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
      const factories = factoriesFor(basicFetch, sessionFetch);
      const fetch = await createJenkinsFetch(BASE, { user: "jenkins-bot", password: "api-token" }, factories);

      await Promise.all([fetch(`${BASE}/api/json`), fetch(`${BASE}/job/A/api/json`)]);

      expect(factories.createSessionFetch).toHaveBeenCalledTimes(1);
    });

    it("retries session creation on the next call if it failed (e.g. login window closed)", async () => {
      const basicFetch = vi.fn().mockImplementation(async () => SITEMINDER_REDIRECT());
      const sessionFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const createSessionFetch = vi.fn()
        .mockRejectedValueOnce(new Error("Browser auth failed"))
        .mockResolvedValue(sessionFetch);
      const fetch = await createJenkinsFetch(
        BASE,
        { user: "jenkins-bot", password: "api-token" },
        { createBasicFetch: () => basicFetch, createSessionFetch },
      );

      await expect(fetch(`${BASE}/api/json`)).rejects.toThrow("Browser auth failed");
      const response = await fetch(`${BASE}/api/json`);

      expect(response.status).toBe(200);
      expect(createSessionFetch).toHaveBeenCalledTimes(2);
    });

    it.each([
      [401, "Unauthorized"],
      [403, "Forbidden"],
    ])("does not fall back on a %i from the controller itself", async (status, body) => {
      const basicFetch = vi.fn().mockResolvedValue(new Response(body, { status }));
      const sessionFetch = vi.fn();
      const factories = factoriesFor(basicFetch, sessionFetch);
      const fetch = await createJenkinsFetch(BASE, { user: "jenkins-bot", password: "api-token" }, factories);

      const response = await fetch(`${BASE}/api/json`);

      expect(response.status).toBe(status);
      expect(factories.createSessionFetch).not.toHaveBeenCalled();
    });

    it.each([
      `${BASE}/job/A/`,
      `${BASE}/job/login-service/`,
      `${BASE}/job/logon-audit/lastBuild/`,
      "/int/jenkins/job/signin-tests/",
    ])("does not fall back on an ordinary redirect inside Jenkins: %s", async (location) => {
      // A job named login-service must not flip the whole process off valid
      // Basic credentials and into interactive authentication.
      const basicFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: location } }),
      );
      const factories = factoriesFor(basicFetch, vi.fn());
      const fetch = await createJenkinsFetch(BASE, { user: "jenkins-bot", password: "api-token" }, factories);

      const response = await fetch(`${BASE}/job/A`);

      expect(response.status).toBe(302);
      expect(factories.createSessionFetch).not.toHaveBeenCalled();
    });
  });

  it("does not reuse Atlassian credentials", () => {
    expect(configuredBasicAuthCredentials({
      ATLASSIAN_EMAIL: "person@example.com",
      ATLASSIAN_PASSWORD: "atlassian-password",
    })).toBeNull();
  });

  it("includes Jenkins credentials in the Windows DPAPI setup script", async () => {
    const script = await readFile(new URL("../../../../scripts/setup-credentials.ps1", import.meta.url), "utf8");

    for (const key of ["JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN", "JENKINS_PASSWORD"]) {
      expect(script).toContain(`Prompt-Value "${key}"`);
      expect(script).toContain(`$creds["${key}"]`);
    }
  });

  it("advertises the complete generic Jenkins tool surface with read/write annotations", async () => {
    const connection = await connectedClient({} as JenkinsClient);
    openConnections.push(connection);

    const { tools } = await connection.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_queue_item",
      "copy_job",
      "create_credential",
      "create_job",
      "delete_credential",
      "disable_job",
      "download_build_artifact",
      "enable_job",
      "get_build",
      "get_build_changes",
      "get_build_console",
      "get_build_test_report",
      "get_controller_info",
      "get_credential_metadata",
      "get_job",
      "get_job_config",
      "get_job_parameters",
      "get_progressive_console",
      "get_promotion",
      "get_queue",
      "get_queue_item",
      "list_agents",
      "list_build_artifacts",
      "list_builds",
      "list_credentials",
      "list_jobs",
      "list_plugins",
      "list_promotions",
      "set_keep_build_forever",
      "stop_build",
      "trigger_build",
      "trigger_promotion",
      "update_credential",
      "update_job_config",
    ]);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint)).toHaveLength(19);
    expect(tools.filter((tool) => !tool.annotations?.readOnlyHint)).toHaveLength(15);
    expect(tools.find((tool) => tool.name === "trigger_build")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "stop_build")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "set_keep_build_forever")?.annotations?.readOnlyHint).toBe(false);
  });

  it("accepts zero depth for direct jobs only", async () => {
    const listJobs = vi.fn().mockResolvedValue([{ name: "DMS" }]);
    const connection = await connectedClient({ listJobs } as unknown as JenkinsClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "list_jobs",
      arguments: { depth: 0 },
    });

    expect(result.isError).not.toBe(true);
    expect(listJobs).toHaveBeenCalledWith(undefined, 0);
  });

  it("defaults job listings to one nested level", async () => {
    const listJobs = vi.fn().mockResolvedValue([{ name: "DMS" }]);
    const connection = await connectedClient({ listJobs } as unknown as JenkinsClient);
    openConnections.push(connection);

    await connection.client.callTool({
      name: "list_jobs",
      arguments: {},
    });

    expect(listJobs).toHaveBeenCalledWith(undefined, 1);
  });

  it("rejects negative job-listing depth", async () => {
    const listJobs = vi.fn();
    const connection = await connectedClient({ listJobs } as unknown as JenkinsClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "list_jobs",
      arguments: { depth: -1 },
    });

    expect(result.isError).toBe(true);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("redacts secret parameters and personal information from build output", async () => {
    const clientOverride = {
      getBuild: async () => ({
        number: 8,
        result: "SUCCESS",
        timestamp: Date.UTC(2026, 6, 14),
        duration: 2500,
        description: "Requested by person@example.com",
        actions: [{ parameters: [
          { name: "branch", value: "main" },
          { name: "API_TOKEN", value: "super-secret-value" },
        ] }],
      }),
    } as unknown as JenkinsClient;
    const connection = await connectedClient(clientOverride);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "get_build",
      arguments: { jobPath: "Folder/Job", buildNumber: 8 },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).not.toBe(true);
    expect(text).toContain("branch=main");
    expect(text).toContain("API_TOKEN=[REDACTED]");
    expect(text).toContain("Requested by [EMAIL]");
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("person@example.com");
  });

  it("returns only the requested tail of long console output", async () => {
    const clientOverride = {
      getBuildConsole: async () => `prefix-${"x".repeat(1200)}-tail`,
    } as unknown as JenkinsClient;
    const connection = await connectedClient(clientOverride);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "get_build_console",
      arguments: { jobPath: "Job", buildNumber: 1, maxChars: 1000 },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text")?.text ?? "";

    expect(text).toContain("[TRUNCATED to last 1000 of 1212 chars]");
    expect(text).toContain("-tail");
    expect(text).not.toContain("prefix-");
  });

  it("redacts secret XML while returning a concurrency SHA", async () => {
    const clientOverride = {
      getJobConfig: async () => "<project><password>top-secret</password><authToken>trigger-secret</authToken><hudson.model.BuildAuthorizationToken><token>legacy-trigger-secret</token></hudson.model.BuildAuthorizationToken><description>person@example.com</description></project>",
    } as unknown as JenkinsClient;
    const connection = await connectedClient(clientOverride);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "get_job_config",
      arguments: { jobPath: "Folder/Job" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).not.toBe(true);
    expect(text).toMatch(/SHA-256: [a-f0-9]{64}/);
    expect(text).toContain("<password>[REDACTED]</password>");
    expect(text).toContain("<authToken>[REDACTED]</authToken>");
    expect(text).toContain("<hudson.model.BuildAuthorizationToken>[REDACTED]</hudson.model.BuildAuthorizationToken>");
    expect(text).toContain("[EMAIL]");
    expect(text).not.toContain("top-secret");
    expect(text).not.toContain("trigger-secret");
    expect(text).not.toContain("legacy-trigger-secret");
    expect(text).not.toContain("person@example.com");
  });

  it("refuses config updates when the expected SHA is stale", async () => {
    const updateJobConfig = vi.fn();
    const clientOverride = {
      getJobConfig: vi.fn().mockResolvedValue("<project/>") ,
      updateJobConfig,
    } as unknown as JenkinsClient;
    const connection = await connectedClient(clientOverride);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "update_job_config",
      arguments: { jobPath: "Job", configFile: "job.xml", expectedSha256: "0".repeat(64) },
    });

    expect(result.isError).toBe(true);
    expect(updateJobConfig).not.toHaveBeenCalled();
  });

  it("backs up, updates, and re-reads a job config after a matching SHA", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jenkins-config-update-"));
    const root = join(temp, "configs");
    await mkdir(root, { mode: 0o700 });
    const current = "<project><disabled>true</disabled></project>";
    const next = "<project><disabled>false</disabled></project>";
    await writeFile(join(root, "next.xml"), next, { mode: 0o600 });
    vi.stubEnv("RAVEN_JENKINS_CONFIG_DIR", root);
    const expectedSha256 = createHash("sha256").update(current).digest("hex");
    const getJobConfig = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(next);
    const updateJobConfig = vi.fn().mockResolvedValue(undefined);
    const connection = await connectedClient({ getJobConfig, updateJobConfig } as unknown as JenkinsClient);
    openConnections.push(connection);

    try {
      const result = await connection.client.callTool({
        name: "update_job_config",
        arguments: { jobPath: "Folder/Job", configFile: "next.xml", expectedSha256 },
      });

      expect(result.isError).not.toBe(true);
      expect(updateJobConfig).toHaveBeenCalledWith("Folder/Job", next);
      const backup = join(root, "backups", "Folder__Job-" + expectedSha256 + ".xml");
      await expect(readFile(backup, "utf8")).resolves.toBe(current);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("refuses protected config exports through a symlinked directory", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jenkins-mcp-"));
    const root = join(temp, "configs");
    const outside = join(temp, "outside");
    await mkdir(root, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(root, "escape"));
    vi.stubEnv("RAVEN_JENKINS_CONFIG_DIR", root);
    const connection = await connectedClient({
      getJobConfig: vi.fn().mockResolvedValue("<project/>"),
    } as unknown as JenkinsClient);
    openConnections.push(connection);

    try {
      const result = await connection.client.callTool({
        name: "get_job_config",
        arguments: { jobPath: "Job", outputFile: "escape/job.xml" },
      });

      expect(result.isError).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("expands a tilde in the protected config directory", async () => {
    const directoryName = `jenkins-config-tilde-${process.pid}-${Date.now()}`;
    const root = join(homedir(), ".raven", directoryName);
    vi.stubEnv("RAVEN_JENKINS_CONFIG_DIR", `~/.raven/${directoryName}`);
    const connection = await connectedClient({
      getJobConfig: vi.fn().mockResolvedValue("<project/>"),
    } as unknown as JenkinsClient);
    openConnections.push(connection);

    try {
      const result = await connection.client.callTool({
        name: "get_job_config",
        arguments: { jobPath: "Job", outputFile: "job.xml" },
      });

      expect(result.isError).not.toBe(true);
      await expect(readFile(join(root, "job.xml"), "utf8")).resolves.toBe("<project/>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates credentials from an environment reference without returning the secret", async () => {
    vi.stubEnv("JENKINS_TEST_SECRET", "credential-secret-value");
    const createCredential = vi.fn().mockResolvedValue(undefined);
    const connection = await connectedClient({ createCredential } as unknown as JenkinsClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "create_credential",
      arguments: {
        credentialId: "deploy-user",
        kind: "usernamePassword",
        username: "deploy",
        secretSource: { envVar: "JENKINS_TEST_SECRET" },
      },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text")?.text ?? "";

    expect(result.isError).not.toBe(true);
    expect(createCredential).toHaveBeenCalledWith(expect.objectContaining({
      id: "deploy-user",
      username: "deploy",
      password: "credential-secret-value",
      $class: "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl",
    }), "system", "_");
    expect(text).not.toContain("credential-secret-value");
  });

  it("rejects raw credential values instead of accepting secrets in tool arguments", async () => {
    const createCredential = vi.fn();
    const connection = await connectedClient({ createCredential } as unknown as JenkinsClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "create_credential",
      arguments: {
        credentialId: "deploy-user",
        kind: "secretText",
        secret: "must-not-be-accepted",
      },
    });

    expect(result.isError).toBe(true);
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("rejects credential environment references outside the JENKINS_ namespace", async () => {
    vi.stubEnv("ATLASSIAN_PASSWORD", "must-not-be-imported");
    const createCredential = vi.fn();
    const connection = await connectedClient({ createCredential } as unknown as JenkinsClient);
    openConnections.push(connection);

    const result = await connection.client.callTool({
      name: "create_credential",
      arguments: {
        credentialId: "deploy-user",
        kind: "secretText",
        secretSource: { envVar: "ATLASSIAN_PASSWORD" },
      },
    });

    expect(result.isError).toBe(true);
    expect(createCredential).not.toHaveBeenCalled();
  });
});
