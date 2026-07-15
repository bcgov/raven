import { isSessionExpired } from "@nrs/auth";
import type { AuthenticatedFetch } from "@nrs/auth";
import type {
  JenkinsAgent,
  JenkinsArtifact,
  JenkinsArtifactDownload,
  JenkinsBuild,
  JenkinsChangeSet,
  JenkinsControllerInfo,
  JenkinsCredentialMetadata,
  JenkinsJob,
  JenkinsParameterDefinition,
  JenkinsPlugin,
  JenkinsProgressiveConsole,
  JenkinsPromotionProcess,
  JenkinsPromotionStatus,
  JenkinsQueueItem,
  JenkinsQueueResponse,
  JenkinsTestReport,
} from "./types.js";

interface JenkinsCrumb {
  crumbRequestField: string;
  crumb: string;
}

const ROOT_JOB_FIELDS = "name,fullName,url,color,buildable,inQueue,lastBuild[number,url],lastSuccessfulBuild[number,url],lastFailedBuild[number,url]";
const CHILD_JOB_FIELDS = "name,fullName,url,color,buildable,inQueue,lastBuild[number,url]";

function childJobTree(depth: number): string {
  return `${CHILD_JOB_FIELDS}${depth > 0 ? `,jobs[${childJobTree(depth - 1)}]` : ""}`;
}

/** Build the Jenkins tree query used to retrieve nested jobs to a bounded depth. */
export function jobsTree(depth: number): string {
  return `jobs[${ROOT_JOB_FIELDS}${depth > 0 ? `,jobs[${childJobTree(depth - 1)}]` : ""}]`;
}

/** Normalize and require an absolute HTTPS Jenkins controller URL. */
export function normalizeJenkinsBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Jenkins base URL must be a valid absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Jenkins base URL must use HTTPS; refusing to send authentication or secrets over an insecure connection.");
  }
  return normalized;
}

function jobPathParts(jobPath?: string): string[] {
  const parts = (jobPath ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("Jenkins job paths cannot contain '.' or '..' segments.");
  }
  return parts;
}

/** Convert a slash-separated Jenkins full job name to its nested `/job/` URL path. */
export function jobPathToUrlPath(jobPath?: string): string {
  const parts = jobPathParts(jobPath);
  if (parts.length === 0) return "";
  return parts.map((part) => `/job/${encodeURIComponent(part)}`).join("");
}

/** Encode an archived artifact path while rejecting URL traversal segments. */
export function artifactPathToUrlPath(artifactPath: string): string {
  const parts = artifactPath.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Artifact path must identify a file and cannot contain '.' or '..' segments.");
  }
  return parts.map(encodeURIComponent).join("/");
}

function credentialDomainPath(store: string, domain: string): string {
  return `/credentials/store/${encodeURIComponent(store)}/domain/${encodeURIComponent(domain)}`;
}

/**
 * Bounded Jenkins REST client used by the MCP server for generic controller,
 * job, build, promotion, artifact, and credential operations.
 */
export class JenkinsClient {
  private baseUrl: string;
  private fetch: AuthenticatedFetch;
  private crumb: JenkinsCrumb | null | undefined;

  constructor(fetch: AuthenticatedFetch, baseUrl?: string) {
    this.fetch = fetch;
    const configuredBaseUrl = baseUrl ?? process.env["JENKINS_URL"] ?? process.env["JENKINS_BASE_URL"];
    if (!configuredBaseUrl) {
      throw new Error("JENKINS_URL or JENKINS_BASE_URL is not set. Add the Jenkins base URL to ~/.raven/.env.");
    }
    this.baseUrl = normalizeJenkinsBaseUrl(
      configuredBaseUrl
    );
  }

  async getControllerInfo(): Promise<JenkinsControllerInfo> {
    const params = new URLSearchParams({
      tree: "nodeName,nodeDescription,mode,numExecutors,quietingDown,useCrumbs,useSecurity",
    });
    const response = await this.getResponse(`/api/json?${params}`);
    const info = (await response.json()) as JenkinsControllerInfo;
    return { ...info, version: response.headers.get("x-jenkins") ?? undefined };
  }

  async listJobs(folderPath?: string, depth: number = 1): Promise<JenkinsJob[]> {
    const params = new URLSearchParams({
      depth: String(depth),
      tree: jobsTree(depth),
    });
    const data = await this.getJson<{ jobs?: JenkinsJob[] }>(`${jobPathToUrlPath(folderPath)}/api/json?${params}`);
    return data.jobs ?? [];
  }

  async getJob(jobPath: string): Promise<JenkinsJob> {
    const params = new URLSearchParams({
      tree: "name,fullName,url,description,color,buildable,inQueue,lastBuild[number,url],lastCompletedBuild[number,url],lastFailedBuild[number,url],lastStableBuild[number,url],lastSuccessfulBuild[number,url],lastUnstableBuild[number,url],jobs[name,fullName,url,color]",
    });
    return this.getJson<JenkinsJob>(`${jobPathToUrlPath(jobPath)}/api/json?${params}`);
  }

  async getJobParameters(jobPath: string): Promise<JenkinsParameterDefinition[]> {
    const params = new URLSearchParams({
      tree: "actions[parameterDefinitions[name,type,description,defaultParameterValue[name,value],choices]]",
    });
    const data = await this.getJson<{ actions?: Array<{ parameterDefinitions?: JenkinsParameterDefinition[] }> }>(
      `${jobPathToUrlPath(jobPath)}/api/json?${params}`
    );
    return (data.actions ?? []).flatMap((action) => action.parameterDefinitions ?? []);
  }

  async getJobConfig(jobPath: string): Promise<string> {
    return this.getText(`${jobPathToUrlPath(jobPath)}/config.xml`);
  }

  async createJob(jobName: string, configXml: string, folderPath?: string): Promise<void> {
    const params = new URLSearchParams({ name: jobName });
    const headers = new Headers({ "Content-Type": "application/xml; charset=utf-8" });
    await this.post(`${jobPathToUrlPath(folderPath)}/createItem?${params}`, { headers, body: configXml });
  }

  async copyJob(sourceJobPath: string, newJobName: string, folderPath?: string): Promise<void> {
    const sourceParts = jobPathParts(sourceJobPath);
    if (sourceParts.length === 0) throw new Error("Source Jenkins job path is required.");
    const source = `/${sourceParts.join("/")}`;
    const params = new URLSearchParams({ name: newJobName, mode: "copy", from: source });
    await this.post(`${jobPathToUrlPath(folderPath)}/createItem?${params}`);
  }

  async updateJobConfig(jobPath: string, configXml: string): Promise<void> {
    const headers = new Headers({ "Content-Type": "application/xml; charset=utf-8" });
    await this.post(`${jobPathToUrlPath(jobPath)}/config.xml`, { headers, body: configXml });
  }

  async enableJob(jobPath: string): Promise<void> {
    await this.post(`${jobPathToUrlPath(jobPath)}/enable`);
  }

  async disableJob(jobPath: string): Promise<void> {
    await this.post(`${jobPathToUrlPath(jobPath)}/disable`);
  }

  async listBuilds(jobPath: string, limit: number = 20): Promise<JenkinsBuild[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const params = new URLSearchParams({
      tree: `builds[number,url,result,timestamp,duration,building,displayName,description]{0,${boundedLimit}}`,
    });
    const data = await this.getJson<{ builds?: JenkinsBuild[] }>(`${jobPathToUrlPath(jobPath)}/api/json?${params}`);
    return data.builds ?? [];
  }

  async getBuild(jobPath: string, buildNumber: number): Promise<JenkinsBuild> {
    const params = new URLSearchParams({
      tree: "number,url,result,timestamp,duration,estimatedDuration,building,displayName,fullDisplayName,description,keepLog,artifacts[displayPath,fileName,relativePath],actions[parameters[name,value],causes[shortDescription,userId,userName]]",
    });
    return this.getJson<JenkinsBuild>(`${jobPathToUrlPath(jobPath)}/${buildNumber}/api/json?${params}`);
  }

  async getBuildConsole(jobPath: string, buildNumber: number): Promise<string> {
    return this.getText(`${jobPathToUrlPath(jobPath)}/${buildNumber}/consoleText`);
  }

  async getProgressiveConsole(
    jobPath: string,
    buildNumber: number,
    start: number = 0
  ): Promise<JenkinsProgressiveConsole> {
    const params = new URLSearchParams({ start: String(Math.max(0, start)) });
    const response = await this.getResponse(
      `${jobPathToUrlPath(jobPath)}/${buildNumber}/logText/progressiveText?${params}`
    );
    const text = await response.text();
    const fallbackNextStart = start + Buffer.byteLength(text, "utf8");
    const nextStart = Number(response.headers.get("x-text-size") ?? fallbackNextStart);
    return {
      text,
      nextStart: Number.isFinite(nextStart) ? nextStart : fallbackNextStart,
      moreData: response.headers.get("x-more-data")?.toLowerCase() === "true",
    };
  }

  async listBuildArtifacts(jobPath: string, buildNumber: number): Promise<JenkinsArtifact[]> {
    const params = new URLSearchParams({ tree: "artifacts[displayPath,fileName,relativePath]" });
    const data = await this.getJson<{ artifacts?: JenkinsArtifact[] }>(
      `${jobPathToUrlPath(jobPath)}/${buildNumber}/api/json?${params}`
    );
    return data.artifacts ?? [];
  }

  async downloadBuildArtifact(
    jobPath: string,
    buildNumber: number,
    artifactPath: string
  ): Promise<JenkinsArtifactDownload> {
    const response = await this.getResponse(
      `${jobPathToUrlPath(jobPath)}/${buildNumber}/artifact/${artifactPathToUrlPath(artifactPath)}`
    );
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  async getBuildTestReport(jobPath: string, buildNumber: number): Promise<JenkinsTestReport> {
    const params = new URLSearchParams({
      tree: "failCount,skipCount,passCount,totalCount,duration,suites[name,duration,cases[className,name,status,duration,age,errorDetails,errorStackTrace]]",
    });
    return this.getJson<JenkinsTestReport>(
      `${jobPathToUrlPath(jobPath)}/${buildNumber}/testReport/api/json?${params}`
    );
  }

  async getBuildChanges(jobPath: string, buildNumber: number): Promise<JenkinsChangeSet[]> {
    const params = new URLSearchParams({
      tree: "changeSet[kind,items[id,msg,timestamp,author[fullName,absoluteUrl],affectedPaths]],changeSets[kind,items[id,msg,timestamp,author[fullName,absoluteUrl],affectedPaths]]",
    });
    const data = await this.getJson<{
      changeSet?: JenkinsChangeSet;
      changeSets?: JenkinsChangeSet[];
    }>(`${jobPathToUrlPath(jobPath)}/${buildNumber}/api/json?${params}`);
    if (data.changeSets?.length) return data.changeSets;
    return data.changeSet ? [data.changeSet] : [];
  }

  async getQueue(): Promise<JenkinsQueueResponse> {
    const params = new URLSearchParams({
      tree: "items[id,task[name,fullName,url],why,blocked,buildable,stuck,inQueueSince,params,actions[parameters[name,value]],executable[number,url]]",
    });
    return this.getJson<JenkinsQueueResponse>(`/queue/api/json?${params}`);
  }

  async getQueueItem(queueId: number): Promise<JenkinsQueueItem> {
    const params = new URLSearchParams({
      tree: "id,task[name,fullName,url],why,blocked,buildable,stuck,inQueueSince,params,actions[parameters[name,value]],executable[number,url],cancelled",
    });
    return this.getJson<JenkinsQueueItem>(`/queue/item/${queueId}/api/json?${params}`);
  }

  async cancelQueueItem(queueId: number): Promise<void> {
    const params = new URLSearchParams({ id: String(queueId) });
    await this.post(`/queue/cancelItem?${params}`);
  }

  async listAgents(): Promise<JenkinsAgent[]> {
    const params = new URLSearchParams({
      tree: "computer[displayName,offline,temporarilyOffline,idle,numExecutors,assignedLabels[name],monitorData]",
    });
    const data = await this.getJson<{ computer?: JenkinsAgent[] }>(`/computer/api/json?${params}`);
    return data.computer ?? [];
  }

  async listPlugins(limit: number = 100): Promise<JenkinsPlugin[]> {
    const params = new URLSearchParams({
      depth: "1",
      tree: "plugins[shortName,longName,version,enabled,active,hasUpdate]",
    });
    const data = await this.getJson<{ plugins?: JenkinsPlugin[] }>(`/pluginManager/api/json?${params}`);
    return (data.plugins ?? []).slice(0, Math.min(Math.max(limit, 1), 500));
  }

  async listPromotions(jobPath: string): Promise<JenkinsPromotionProcess[]> {
    const params = new URLSearchParams({
      tree: "processes[name,url,displayName,description,buildable,inQueue,lastBuild[number,url]]",
    });
    const data = await this.getJson<{ processes?: JenkinsPromotionProcess[] }>(
      `${jobPathToUrlPath(jobPath)}/promotion/api/json?${params}`
    );
    return data.processes ?? [];
  }

  async getPromotion(
    jobPath: string,
    buildNumber: number,
    promotionName: string
  ): Promise<JenkinsPromotionStatus> {
    const params = new URLSearchParams({
      tree: "name,timestamp,manuallyApproved,promotionAttempted,promotionSuccessful,lastAnError,promotionBuilds[number,url,result,timestamp,duration]",
    });
    return this.getJson<JenkinsPromotionStatus>(
      `${jobPathToUrlPath(jobPath)}/${buildNumber}/promotion/${encodeURIComponent(promotionName)}/api/json?${params}`
    );
  }

  async triggerPromotion(jobPath: string, buildNumber: number, promotionName: string): Promise<void> {
    const form = new URLSearchParams({ name: promotionName });
    await this.post(`${jobPathToUrlPath(jobPath)}/${buildNumber}/promotion/forcePromotion`, {
      headers: new Headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: form.toString(),
    });
  }

  async listCredentials(store: string = "system", domain: string = "_"): Promise<JenkinsCredentialMetadata[]> {
    const params = new URLSearchParams({
      tree: "credentials[id,displayName,description,typeName]",
    });
    const data = await this.getJson<{ credentials?: JenkinsCredentialMetadata[] }>(
      `${credentialDomainPath(store, domain)}/api/json?${params}`
    );
    return data.credentials ?? [];
  }

  async getCredentialMetadata(
    credentialId: string,
    store: string = "system",
    domain: string = "_"
  ): Promise<JenkinsCredentialMetadata> {
    const params = new URLSearchParams({ tree: "id,displayName,description,typeName" });
    return this.getJson<JenkinsCredentialMetadata>(
      `${credentialDomainPath(store, domain)}/credential/${encodeURIComponent(credentialId)}/api/json?${params}`
    );
  }

  async createCredential(
    credential: Record<string, unknown>,
    store: string = "system",
    domain: string = "_"
  ): Promise<void> {
    await this.postCredentialForm(
      `${credentialDomainPath(store, domain)}/createCredentials`,
      { credentials: credential }
    );
  }

  async updateCredential(
    credentialId: string,
    credential: Record<string, unknown>,
    store: string = "system",
    domain: string = "_"
  ): Promise<void> {
    await this.postCredentialForm(
      `${credentialDomainPath(store, domain)}/credential/${encodeURIComponent(credentialId)}/updateSubmit`,
      credential
    );
  }

  async deleteCredential(
    credentialId: string,
    store: string = "system",
    domain: string = "_"
  ): Promise<void> {
    await this.postCredentialForm(
      `${credentialDomainPath(store, domain)}/credential/${encodeURIComponent(credentialId)}/doDelete`,
      {}
    );
  }

  async triggerBuild(
    jobPath: string,
    parameters?: Record<string, string>,
    delay?: string
  ): Promise<{ queueUrl?: string; queueId?: number }> {
    const hasParameters = parameters && Object.keys(parameters).length > 0;
    const params = new URLSearchParams();
    if (delay) params.set("delay", delay);
    const query = params.toString() ? `?${params}` : "";
    const endpoint = hasParameters ? "buildWithParameters" : "build";

    const headers = new Headers();
    let body: string | undefined;
    if (hasParameters) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(parameters)) {
        form.set(key, value);
      }
      body = form.toString();
    }

    const response = await this.post(`${jobPathToUrlPath(jobPath)}/${endpoint}${query}`, { headers, body });
    const queueUrl = response.headers.get("location") ?? undefined;
    return { queueUrl, queueId: queueUrl ? this.queueIdFromUrl(queueUrl) : undefined };
  }

  async stopBuild(jobPath: string, buildNumber: number): Promise<void> {
    await this.post(`${jobPathToUrlPath(jobPath)}/${buildNumber}/stop`);
  }

  private async getResponse(path: string): Promise<Response> {
    const response = await this.fetch(this.url(path));
    if (!response.ok) {
      throw new Error(`Jenkins request failed (${response.status}): ${await response.text()}`);
    }
    return response;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.getResponse(path);
    return (await response.json()) as T;
  }

  private async getText(path: string): Promise<string> {
    const response = await this.getResponse(path);
    return response.text();
  }

  private async postCredentialForm(path: string, payload: Record<string, unknown>): Promise<void> {
    const form = new URLSearchParams({ json: JSON.stringify(payload) });
    const response = await this.post(path, {
      headers: new Headers({
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body: form.toString(),
    }, false);
    if (response.headers.get("content-type")?.includes("application/json")) {
      const result = (await response.json()) as { notificationType?: string; message?: string };
      if (result.notificationType === "ERROR") {
        throw new Error(`Jenkins credential operation failed: ${result.message ?? "unknown error"}`);
      }
    }
  }

  private async post(path: string, init?: RequestInit, includeErrorBody: boolean = true): Promise<Response> {
    const headers = new Headers(init?.headers);
    const crumb = await this.getCrumb();
    if (crumb) {
      headers.set(crumb.crumbRequestField, crumb.crumb);
    }

    const response = await this.fetch(this.url(path), {
      ...init,
      method: "POST",
      headers,
      redirect: "manual",
    });
    const redirectLocation = response.headers.get("location") ?? "";
    const authenticationRedirect = response.status >= 300 && response.status < 400 && (
      isSessionExpired(response) || /(?:login|logon|signin|siteminder|fedlaunch|auth)/i.test(redirectLocation)
    );
    if (authenticationRedirect) {
      throw new Error(`Jenkins POST redirected to authentication (${response.status}).`);
    }
    if (!response.ok && (response.status < 300 || response.status >= 400)) {
      const detail = includeErrorBody ? `: ${await response.text()}` : "";
      throw new Error(`Jenkins POST failed (${response.status})${detail}`);
    }
    return response;
  }

  private async getCrumb(): Promise<JenkinsCrumb | null> {
    if (this.crumb !== undefined) return this.crumb;

    const response = await this.fetch(this.url("/crumbIssuer/api/json"));
    if (response.status === 404) {
      this.crumb = null;
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch Jenkins crumb (${response.status}): ${await response.text()}`);
    }
    this.crumb = (await response.json()) as JenkinsCrumb;
    return this.crumb;
  }

  private queueIdFromUrl(queueUrl: string): number | undefined {
    const match = queueUrl.match(/\/queue\/item\/(\d+)\/?$/);
    return match ? Number(match[1]) : undefined;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }
}
