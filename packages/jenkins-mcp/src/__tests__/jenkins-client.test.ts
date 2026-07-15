import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedFetch } from "@nrs/auth";
import {
  JenkinsClient,
  artifactPathToUrlPath,
  jobsTree,
  jobPathToUrlPath,
  normalizeJenkinsBaseUrl,
} from "../jenkins-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("JenkinsClient helpers", () => {
  it("normalizes trailing slashes from Jenkins base URLs", () => {
    expect(normalizeJenkinsBaseUrl("https://jenkins.example.gov.bc.ca/jenkins///")).toBe(
      "https://jenkins.example.gov.bc.ca/jenkins"
    );
  });

  it("rejects insecure or malformed Jenkins base URLs", () => {
    expect(() => normalizeJenkinsBaseUrl("http://jenkins.example.gov.bc.ca/jenkins"))
      .toThrow("must use HTTPS");
    expect(() => normalizeJenkinsBaseUrl("jenkins.example.gov.bc.ca"))
      .toThrow("valid absolute HTTPS URL");
    expect(() => new JenkinsClient(vi.fn<AuthenticatedFetch>(), "http://jenkins.example.gov.bc.ca"))
      .toThrow("must use HTTPS");
  });

  it("converts slash-separated job paths to Jenkins job URL paths", () => {
    expect(jobPathToUrlPath("Folder/Sub Folder/build-main")).toBe(
      "/job/Folder/job/Sub%20Folder/job/build-main"
    );
  });

  it("rejects traversal segments in Jenkins job paths", () => {
    expect(() => jobPathToUrlPath("Folder/../script")).toThrow("cannot contain");
    expect(() => jobPathToUrlPath("./Job")).toThrow("cannot contain");
  });

  it("returns an empty URL path for the Jenkins root", () => {
    expect(jobPathToUrlPath()).toBe("");
    expect(jobPathToUrlPath("  ")).toBe("");
  });

  it("encodes safe artifact paths and rejects traversal", () => {
    expect(artifactPathToUrlPath("dist/release app.war")).toBe("dist/release%20app.war");
    expect(() => artifactPathToUrlPath("../credentials.xml")).toThrow("cannot contain");
  });

  it("builds a Jenkins tree matching the requested nesting depth", () => {
    expect(jobsTree(0).match(/jobs\[/g)).toHaveLength(1);
    expect(jobsTree(1).match(/jobs\[/g)).toHaveLength(2);
    expect(jobsTree(3).match(/jobs\[/g)).toHaveLength(4);
  });
});

describe("JenkinsClient read operations", () => {
  it("reads controller details and Jenkins version headers", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(jsonResponse(
      { nodeName: "built-in", useSecurity: true },
      { headers: { "Content-Type": "application/json", "X-Jenkins": "2.73.2" } }
    ));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getControllerInfo()).resolves.toEqual({
      nodeName: "built-in",
      useSecurity: true,
      version: "2.73.2",
    });
  });

  it("extracts parameter definitions from Jenkins actions", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(jsonResponse({
      actions: [{}, { parameterDefinitions: [{ name: "BRANCH", type: "StringParameterDefinition" }] }],
    }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getJobParameters("Folder/Job")).resolves.toEqual([
      { name: "BRANCH", type: "StringParameterDefinition" },
    ]);
  });
  it("lists only direct jobs when depth is zero", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(jsonResponse({ jobs: [{ name: "main" }] }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca/jenkins/");

    const jobs = await client.listJobs("Team Folder/Service", 0);

    expect(jobs).toEqual([{ name: "main" }]);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/jenkins/job/Team%20Folder/job/Service/api/json");
    expect(url.searchParams.get("depth")).toBe("0");
    expect(url.searchParams.get("tree")).toContain("lastSuccessfulBuild");
    expect(url.searchParams.get("tree")?.match(/jobs\[/g)).toHaveLength(1);
  });

  it("defaults job listings to one nested level", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(jsonResponse({ jobs: [] }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await client.listJobs();

    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get("depth")).toBe("1");
  });

  it("bounds build history requests to Jenkins' supported range", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(jsonResponse({ builds: [] }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await client.listBuilds("Folder/Job", 500);

    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get("tree")).toContain("{0,100}");
  });

  it("returns plain-text console output", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(new Response("build output", { status: 200 }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getBuildConsole("Folder/Job", 12)).resolves.toBe("build output");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://jenkins.example.gov.bc.ca/job/Folder/job/Job/12/consoleText"
    );
  });

  it("reads progressive console offsets from response headers", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(new Response("next chunk", {
      status: 200,
      headers: { "X-Text-Size": "125", "X-More-Data": "true" },
    }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getProgressiveConsole("Job", 3, 100)).resolves.toEqual({
      text: "next chunk",
      nextStart: 125,
      moreData: true,
    });
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("start")).toBe("100");
  });

  it("uses UTF-8 byte length for progressive console offsets when Jenkins omits the header", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(new Response("café", { status: 200 }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getProgressiveConsole("Job", 3, 100)).resolves.toEqual({
      text: "café",
      nextStart: 105,
      moreData: false,
    });
  });

  it("reads artifacts, tests, changes, promotions, and credential metadata", async () => {
    const fetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(jsonResponse({ artifacts: [{ relativePath: "app.war", fileName: "app.war", displayPath: "app.war" }] }))
      .mockResolvedValueOnce(jsonResponse({ passCount: 4, failCount: 0, skipCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ changeSet: { kind: "git", items: [{ id: "abc", msg: "change" }] } }))
      .mockResolvedValueOnce(jsonResponse({ processes: [{ name: "INT" }] }))
      .mockResolvedValueOnce(jsonResponse({ credentials: [{ id: "deploy", typeName: "Username with password" }] }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.listBuildArtifacts("Job", 1)).resolves.toHaveLength(1);
    await expect(client.getBuildTestReport("Job", 1)).resolves.toMatchObject({ passCount: 4 });
    await expect(client.getBuildChanges("Job", 1)).resolves.toEqual([{ kind: "git", items: [{ id: "abc", msg: "change" }] }]);
    await expect(client.listPromotions("Job")).resolves.toEqual([{ name: "INT" }]);
    await expect(client.listCredentials()).resolves.toEqual([{ id: "deploy", typeName: "Username with password" }]);
  });

  it("reads queue items, artifact bytes, promotion status, and one credential record", async () => {
    const fetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 17, task: { fullName: "Folder/Job" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/java-archive" },
      }))
      .mockResolvedValueOnce(jsonResponse({ name: "Deploy INT", promotionSuccessful: true }))
      .mockResolvedValueOnce(jsonResponse({ id: "deploy", typeName: "Secret text" }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getQueueItem(17)).resolves.toMatchObject({ id: 17 });
    const artifact = await client.downloadBuildArtifact("Folder/Job", 8, "dist/app release.war");
    expect([...artifact.bytes]).toEqual([1, 2, 3]);
    expect(artifact.contentType).toBe("application/java-archive");
    await expect(client.getPromotion("Folder/Job", 8, "Deploy INT")).resolves.toMatchObject({ promotionSuccessful: true });
    await expect(client.getCredentialMetadata("deploy")).resolves.toEqual({ id: "deploy", typeName: "Secret text" });

    expect(fetch.mock.calls[0][0]).toContain("/queue/item/17/api/json");
    expect(fetch.mock.calls[1][0]).toContain("/job/Folder/job/Job/8/artifact/dist/app%20release.war");
    expect(fetch.mock.calls[2][0]).toContain("/8/promotion/Deploy%20INT/api/json");
    expect(fetch.mock.calls[3][0]).toContain("/credential/deploy/api/json");
  });

  it("surfaces the Jenkins status and response body on read failures", async () => {
    const fetch = vi.fn<AuthenticatedFetch>().mockResolvedValue(
      new Response("permission denied", { status: 403 })
    );
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.getQueue()).rejects.toThrow(
      "Jenkins request failed (403): permission denied"
    );
  });
});

describe("JenkinsClient write operations", () => {
  it("uses Jenkins core endpoints for job config, queue, and promotion mutations", async () => {
    const fetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    for (let i = 0; i < 8; i++) fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await client.createJob("New Job", "<project/>", "Folder");
    await client.copyJob("Source/Job", "Copy", "Folder");
    await client.updateJobConfig("Folder/Copy", "<project><disabled>false</disabled></project>");
    await client.enableJob("Folder/Copy");
    await client.disableJob("Folder/Copy");
    await client.cancelQueueItem(42);
    await client.triggerPromotion("Folder/Copy", 9, "Deploy INT");

    expect(fetch).toHaveBeenCalledTimes(8);
    expect(fetch.mock.calls[1][0]).toContain("/job/Folder/createItem?name=New+Job");
    expect(fetch.mock.calls[2][0]).toContain("mode=copy");
    expect(fetch.mock.calls[2][0]).toContain("from=%2FSource%2FJob");
    expect(fetch.mock.calls[3][0]).toBe("https://jenkins.example.gov.bc.ca/job/Folder/job/Copy/config.xml");
    expect(fetch.mock.calls[6][0]).toBe("https://jenkins.example.gov.bc.ca/queue/cancelItem?id=42");
    expect(fetch.mock.calls[7][0]).toBe("https://jenkins.example.gov.bc.ca/job/Folder/job/Copy/9/promotion/forcePromotion");
    expect(new URLSearchParams((fetch.mock.calls[7][1] as RequestInit).body as string).get("name")).toBe("Deploy INT");
  });

  it("uses credential plugin form endpoints and detects logical errors", async () => {
    const fetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ notificationType: "SUCCESS", message: "created" }))
      .mockResolvedValueOnce(jsonResponse({ notificationType: "SUCCESS", message: "updated" }))
      .mockResolvedValueOnce(jsonResponse({ notificationType: "SUCCESS", message: "deleted" }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");
    const payload = { id: "deploy", $class: "example.Credential" };

    await client.createCredential(payload);
    await client.updateCredential("deploy", payload);
    await client.deleteCredential("deploy");

    expect(fetch.mock.calls[1][0]).toContain("/credentials/store/system/domain/_/createCredentials");
    expect(fetch.mock.calls[2][0]).toContain("/credential/deploy/updateSubmit");
    expect(fetch.mock.calls[3][0]).toContain("/credential/deploy/doDelete");
    const createJson = JSON.parse(new URLSearchParams((fetch.mock.calls[1][1] as RequestInit).body as string).get("json") ?? "{}");
    expect(createJson).toEqual({ credentials: payload });

    const failedFetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ notificationType: "ERROR", message: "duplicate id" }));
    const failedClient = new JenkinsClient(failedFetch, "https://jenkins.example.gov.bc.ca");
    await expect(failedClient.createCredential(payload)).rejects.toThrow("duplicate id");

    const httpFailedFetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("echoed-secret-must-not-escape", { status: 500 }));
    const httpFailedClient = new JenkinsClient(httpFailedFetch, "https://jenkins.example.gov.bc.ca");
    const rejection = httpFailedClient.createCredential(payload);
    await expect(rejection).rejects.toThrow("Jenkins POST failed (500)");
    await expect(rejection).rejects.not.toThrow("echoed-secret-must-not-escape");
  });

  it("fetches and caches a crumb, encodes parameters, and returns the queue id", async () => {
    const fetch = vi
      .fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(jsonResponse({ crumbRequestField: "Jenkins-Crumb", crumb: "crumb-value" }))
      .mockResolvedValueOnce(new Response(null, {
        status: 201,
        headers: { Location: "https://jenkins.example.gov.bc.ca/queue/item/42/" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.triggerBuild("Folder/Job", { branch: "feature/a b", mode: "safe" }, "0sec"))
      .resolves.toEqual({
        queueUrl: "https://jenkins.example.gov.bc.ca/queue/item/42/",
        queueId: 42,
      });
    await client.stopBuild("Folder/Job", 9);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe("https://jenkins.example.gov.bc.ca/crumbIssuer/api/json");

    const triggerUrl = new URL(fetch.mock.calls[1][0]);
    const triggerInit = fetch.mock.calls[1][1] as RequestInit;
    expect(triggerUrl.pathname).toBe("/job/Folder/job/Job/buildWithParameters");
    expect(triggerUrl.searchParams.get("delay")).toBe("0sec");
    expect(triggerInit.method).toBe("POST");
    expect(triggerInit.redirect).toBe("manual");
    expect(new Headers(triggerInit.headers).get("Jenkins-Crumb")).toBe("crumb-value");
    expect(new URLSearchParams(triggerInit.body as string).get("branch")).toBe("feature/a b");

    const stopInit = fetch.mock.calls[2][1] as RequestInit;
    expect(fetch.mock.calls[2][0]).toBe("https://jenkins.example.gov.bc.ca/job/Folder/job/Job/9/stop");
    expect(new Headers(stopInit.headers).get("Jenkins-Crumb")).toBe("crumb-value");
  });

  it("supports Jenkins controllers with CSRF crumbs disabled", async () => {
    const fetch = vi
      .fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await client.triggerBuild("Job");

    const headers = new Headers((fetch.mock.calls[1][1] as RequestInit).headers);
    expect([...headers.keys()]).toEqual([]);
  });

  it("rejects unsuccessful Jenkins POST responses", async () => {
    const fetch = vi
      .fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.stopBuild("Job", 3)).rejects.toThrow(
      "Jenkins POST failed (403): forbidden"
    );
  });

  it("does not treat authentication redirects as successful writes", async () => {
    const fetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://jenkins.example.gov.bc.ca/login?from=%2Fjob%2FJob%2Fbuild" },
      }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.triggerBuild("Job")).rejects.toThrow("redirected to authentication");
  });

  it.each([
    "https://logon.example.gov.bc.ca/clp-cgi/logon",
    "https://apps.example.gov.bc.ca/fedLaunch?target=jenkins",
  ])("rejects BC Gov authentication redirect %s", async (location) => {
    const fetch = vi.fn<AuthenticatedFetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: location },
      }));
    const client = new JenkinsClient(fetch, "https://jenkins.example.gov.bc.ca");

    await expect(client.triggerBuild("Job")).rejects.toThrow("redirected to authentication");
  });
});
