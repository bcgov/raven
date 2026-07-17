import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
