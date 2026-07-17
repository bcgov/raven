import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SessionManager,
  createAuthenticatedFetch,
  createBasicAuthFetch,
  PiScrubber,
  authCliPath,
} from "@nrs/auth";
import type { AuthenticatedFetch } from "@nrs/auth";
import { JenkinsClient, normalizeJenkinsBaseUrl } from "./jenkins-client.js";
import { registerExtendedJenkinsTools } from "./extended-tools.js";
import type { JenkinsBuild, JenkinsJob, JenkinsParameter, JenkinsQueueItem } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const MAX_CONSOLE_CHARS = 20000;

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

function configuredBaseUrl(): string {
  const baseUrl = process.env["JENKINS_URL"] ?? process.env["JENKINS_BASE_URL"];
  if (!baseUrl) {
    throw new Error("JENKINS_URL or JENKINS_BASE_URL is not set. Add the Jenkins base URL to ~/.raven/.env.");
  }
  return normalizeJenkinsBaseUrl(baseUrl);
}

export function configuredBasicAuthCredentials(
  env: NodeJS.ProcessEnv = process.env
): { user: string; password: string } | null {
  const jenkinsUser = env["JENKINS_USER"];
  const jenkinsPassword =
    env["JENKINS_TOKEN"] ??
    env["JENKINS_API_TOKEN"] ??
    env["JENKINS_PASSWORD"];
  if (jenkinsUser && jenkinsPassword) {
    return { user: jenkinsUser, password: jenkinsPassword };
  }

  return null;
}

export interface JenkinsFetchFactories {
  createBasicFetch: (user: string, password: string) => AuthenticatedFetch;
  createSessionFetch: () => Promise<AuthenticatedFetch>;
}

function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const combined = headers.get("set-cookie");
  return combined?.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) ?? [];
}

function mergeCookieHeader(headers: Headers, cookies: Map<string, string>): void {
  const merged = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) merged.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  for (const [name, value] of cookies) merged.set(name, value);
  if (merged.size) {
    headers.set("Cookie", [...merged].map(([name, value]) => `${name}=${value}`).join("; "));
  }
}

/**
 * Retain Jenkins servlet-session cookies only for requests beneath the configured
 * controller URL. This keeps CSRF crumbs bound to the same Jenkins session while
 * preventing controller cookies from being sent to another origin or context path.
 */
export function withJenkinsSessionCookies(fetchFn: AuthenticatedFetch, baseUrl: string): AuthenticatedFetch {
  const base = new URL(`${normalizeJenkinsBaseUrl(baseUrl)}/`);
  const cookies = new Map<string, string>();
  const isControllerUrl = (url: string): boolean => {
    const target = new URL(url);
    return target.origin === base.origin && target.pathname.startsWith(base.pathname);
  };

  return async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (isControllerUrl(url)) mergeCookieHeader(headers, cookies);
    const response = await fetchFn(url, { ...init, headers });
    if (isControllerUrl(url)) {
      for (const setCookie of setCookieValues(response.headers)) {
        const match = /^\s*([^=;\s]+)=([^;]*)/.exec(setCookie);
        if (!match || !/^JSESSIONID(?:[._-].+)?$/i.test(match[1])) continue;
        if (!match[2] || /;\s*max-age=0(?:;|$)/i.test(setCookie)) {
          cookies.delete(match[1]);
        } else {
          cookies.set(match[1], match[2]);
        }
      }
    }
    return response;
  };
}

/** Create the configured Jenkins authentication transport with session-cookie retention. */
export async function createJenkinsFetch(
  baseUrl: string,
  basicAuth: { user: string; password: string } | null,
  factories?: JenkinsFetchFactories,
): Promise<AuthenticatedFetch> {
  const resolvedFactories = factories ?? {
    createBasicFetch: createBasicAuthFetch,
    createSessionFetch: async () => createAuthenticatedFetch(new SessionManager()),
  };

  const authFetch = basicAuth
    ? resolvedFactories.createBasicFetch(basicAuth.user, basicAuth.password)
    : await resolvedFactories.createSessionFetch();
  const redirectSafeFetch: AuthenticatedFetch = basicAuth
    ? (url, init) => authFetch(url, { ...init, redirect: "manual" })
    : authFetch;
  return withJenkinsSessionCookies(redirectSafeFetch, baseUrl);
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toISOString();
}

function formatDuration(duration?: number): string {
  if (!duration) return "unknown";
  const seconds = Math.round(duration / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function redactParameter(param: JenkinsParameter): string {
  const sensitive = /password|passwd|token|secret|key|credential|auth/i.test(param.name);
  const value = sensitive ? "[REDACTED]" : String(param.value ?? "");
  return `${param.name}=${pi.scrubText(value)}`;
}

function buildParameters(build: JenkinsBuild): string[] {
  return (build.actions ?? [])
    .flatMap((action) => action.parameters ?? [])
    .map(redactParameter);
}

function formatJob(job: JenkinsJob): string {
  const fullName = job.fullName ?? job.name;
  const state = job.color ?? "unknown";
  const buildable = job.buildable === false ? "not buildable" : "buildable";
  const queued = job.inQueue ? " | queued" : "";
  const last = job.lastBuild ? ` | last build: #${job.lastBuild.number}` : "";
  return `- **${fullName}** (${state}, ${buildable}${queued}${last})${job.url ? `\n  ${job.url}` : ""}`;
}

function formatJobTree(jobs: JenkinsJob[], depth: number = 0): string[] {
  const lines: string[] = [];
  for (const job of jobs) {
    const prefix = "  ".repeat(depth);
    lines.push(`${prefix}${formatJob(job)}`);
    if (job.jobs?.length) {
      lines.push(...formatJobTree(job.jobs, depth + 1));
    }
  }
  return lines;
}

function formatBuild(build: JenkinsBuild): string {
  const result = build.building ? "BUILDING" : build.result ?? "UNKNOWN";
  const params = buildParameters(build);
  const lines = [
    `### Build #${build.number} — ${result}`,
    build.url ? `**URL:** ${build.url}` : "",
    `**Started:** ${formatDate(build.timestamp)} | **Duration:** ${formatDuration(build.duration)}`,
    build.description ? `**Description:** ${pi.scrubText(build.description)}` : "",
    params.length ? `**Parameters:** ${params.join(", ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function formatQueueItem(item: JenkinsQueueItem): string {
  const task = item.task?.fullName ?? item.task?.name ?? "unknown task";
  const queuedAt = item.inQueueSince ? formatDate(item.inQueueSince) : "unknown";
  const executable = item.executable ? ` | executable: #${item.executable.number}` : "";
  const reason = item.why ? `\n  Why: ${pi.scrubText(item.why)}` : "";
  return `- **${task}** (queue id: ${item.id}, queued: ${queuedAt}${executable})${reason}`;
}

export function createJenkinsServer(clientOverride?: JenkinsClient): McpServer {
  const server = new McpServer(
    { name: "RAVEN Jenkins", version: "0.1.0" },
    {
      instructions:
        "You have access to Jenkins tools for the configured BC Gov NRS Jenkins controller. " +
        "Tools expose generic Jenkins controller, job, build, queue, artifact, test, change, promotion, and credential operations. " +
        "Write tools modify live CI state or protected local files — always confirm with the user before calling them. " +
        "Job configs use protected files and expected SHA-256 values; credential secrets must come from protected files or environment variables and are never returned. " +
        "Set JENKINS_URL or JENKINS_BASE_URL for the Jenkins base URL. The server uses JENKINS_USER plus JENKINS_PASSWORD, JENKINS_TOKEN, or JENKINS_API_TOKEN when set, then falls back to SMSESSION authentication. " +
        `If authentication fails, tell the user to check JENKINS_URL and their dedicated Jenkins credentials, or re-authenticate via SMSESSION by running: node ${authCliPath}${WORKAROUND_NOTE}`,
    }
  );

  let client: JenkinsClient | null = clientOverride ?? null;

  async function getClient(): Promise<JenkinsClient> {
    if (!client) {
      const baseUrl = configuredBaseUrl();
      const basicAuth = configuredBasicAuthCredentials();

      const authFetch = await createJenkinsFetch(baseUrl, basicAuth);
      client = new JenkinsClient(authFetch, baseUrl);
    }
    return client;
  }

  server.tool(
    "list_jobs",
    "List Jenkins jobs at the root or inside a folder. For folder jobs, pass a slash-separated path such as 'Folder/Subfolder'.",
    {
      folderPath: z.string().optional().describe("Optional slash-separated folder/job path to list"),
      depth: z.number().int().min(0).max(3).default(1).describe("Nested job levels to return: 0 lists only jobs directly at the target; each additional level includes child jobs"),
    },
    { readOnlyHint: true },
    async ({ folderPath, depth }) => {
      try {
        const jobs = await (await getClient()).listJobs(folderPath, depth);
        if (jobs.length === 0) {
          return { content: [{ type: "text", text: `No Jenkins jobs found${folderPath ? ` under ${folderPath}` : ""}.` }] };
        }
        return { content: [{ type: "text", text: `Found ${jobs.length} Jenkins job(s):\n\n${formatJobTree(jobs).join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing Jenkins jobs: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_job",
    "Get Jenkins job details, including last build references and child jobs if it is a folder.",
    { jobPath: z.string().describe("Slash-separated Jenkins job path") },
    { readOnlyHint: true },
    async ({ jobPath }) => {
      try {
        const job = await (await getClient()).getJob(jobPath);
        const lines = [
          `## ${job.fullName ?? job.name}`,
          job.url ? `**URL:** ${job.url}` : "",
          `**State:** ${job.color ?? "unknown"} | **Buildable:** ${job.buildable === false ? "no" : "yes"} | **In queue:** ${job.inQueue ? "yes" : "no"}`,
          job.description ? `\n${pi.scrubText(job.description)}` : "",
          job.lastBuild ? `**Last build:** #${job.lastBuild.number}` : "**Last build:** none",
          job.lastSuccessfulBuild ? `**Last successful:** #${job.lastSuccessfulBuild.number}` : "",
          job.lastFailedBuild ? `**Last failed:** #${job.lastFailedBuild.number}` : "",
          job.jobs?.length ? `\n### Child jobs\n${formatJobTree(job.jobs).join("\n")}` : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading Jenkins job: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_builds",
    "List recent builds for a Jenkins job.",
    {
      jobPath: z.string().describe("Slash-separated Jenkins job path"),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum builds to return"),
    },
    { readOnlyHint: true },
    async ({ jobPath, limit }) => {
      try {
        const builds = await (await getClient()).listBuilds(jobPath, limit);
        if (builds.length === 0) return { content: [{ type: "text", text: `No builds found for ${jobPath}.` }] };
        return { content: [{ type: "text", text: builds.map(formatBuild).join("\n\n---\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing Jenkins builds: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_build",
    "Get details for a Jenkins build, including result, timing, artifacts, causes, and redacted parameters.",
    {
      jobPath: z.string().describe("Slash-separated Jenkins job path"),
      buildNumber: z.number().int().min(1).describe("Build number"),
    },
    { readOnlyHint: true },
    async ({ jobPath, buildNumber }) => {
      try {
        const build = await (await getClient()).getBuild(jobPath, buildNumber);
        const artifacts = build.artifacts?.length
          ? `\n\n### Artifacts\n${build.artifacts.map((a) => `- ${a.relativePath}`).join("\n")}`
          : "";
        return { content: [{ type: "text", text: formatBuild(build) + artifacts }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading Jenkins build: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_build_console",
    "Read the plain-text console output for a Jenkins build. Output is truncated by default to avoid flooding context.",
    {
      jobPath: z.string().describe("Slash-separated Jenkins job path"),
      buildNumber: z.number().int().min(1).describe("Build number"),
      maxChars: z.number().int().min(1000).max(100000).default(MAX_CONSOLE_CHARS).describe("Maximum console characters to return"),
    },
    { readOnlyHint: true },
    async ({ jobPath, buildNumber, maxChars }) => {
      try {
        const consoleText = pi.scrubText(await (await getClient()).getBuildConsole(jobPath, buildNumber));
        const truncated = consoleText.length > maxChars
          ? `${consoleText.slice(-maxChars)}\n\n... [TRUNCATED to last ${maxChars} of ${consoleText.length} chars]`
          : consoleText;
        return { content: [{ type: "text", text: `### ${jobPath} #${buildNumber} console\n\n\`\`\`\n${truncated}\n\`\`\`` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading Jenkins console: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_queue",
    "List current Jenkins build queue items and why they are waiting.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const queue = await (await getClient()).getQueue();
        if (queue.items.length === 0) return { content: [{ type: "text", text: "Jenkins queue is empty." }] };
        return { content: [{ type: "text", text: `Jenkins queue (${queue.items.length} item(s)):\n\n${queue.items.map(formatQueueItem).join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading Jenkins queue: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_agents",
    "List Jenkins controller and agent/executor status.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const agents = await (await getClient()).listAgents();
        const lines = agents.map((agent) => {
          const labels = agent.assignedLabels?.map((l) => l.name).filter(Boolean).join(", ") || "no labels";
          return `- **${agent.displayName}** — ${agent.offline ? "offline" : "online"}, ${agent.idle ? "idle" : "busy"}, executors: ${agent.numExecutors ?? "?"}, labels: ${labels}`;
        });
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No Jenkins agents returned." }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing Jenkins agents: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_plugins",
    "List installed Jenkins plugins and their versions. Use this to check old Jenkins compatibility or plugin availability.",
    { limit: z.number().int().min(1).max(500).default(100).describe("Maximum plugins to return") },
    { readOnlyHint: true },
    async ({ limit }) => {
      try {
        const plugins = await (await getClient()).listPlugins(limit);
        const lines = plugins.map((plugin) => `- **${plugin.shortName}** ${plugin.version ?? "unknown"} — ${plugin.active === false ? "inactive" : "active"}${plugin.hasUpdate ? " (update available)" : ""}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No Jenkins plugins returned." }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing Jenkins plugins: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "trigger_build",
    "Trigger a Jenkins build. Confirm with the user before invoking because this starts live CI work.",
    {
      jobPath: z.string().describe("Slash-separated Jenkins job path"),
      parameters: z.record(z.string()).optional().describe("Optional build parameters as key/value strings"),
      delay: z.string().optional().describe("Optional Jenkins quiet-period delay, e.g. '0sec'"),
    },
    { readOnlyHint: false },
    async ({ jobPath, parameters, delay }) => {
      try {
        const result = await (await getClient()).triggerBuild(jobPath, parameters, delay);
        const queue = result.queueId ? ` Queue item: ${result.queueId}.` : "";
        const url = result.queueUrl ? `\n${result.queueUrl}` : "";
        return { content: [{ type: "text", text: `Triggered Jenkins build for ${jobPath}.${queue}${url}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error triggering Jenkins build: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "stop_build",
    "Stop a running Jenkins build. Confirm with the user before invoking because this interrupts live CI work.",
    {
      jobPath: z.string().describe("Slash-separated Jenkins job path"),
      buildNumber: z.number().int().min(1).describe("Build number to stop"),
    },
    { readOnlyHint: false },
    async ({ jobPath, buildNumber }) => {
      try {
        await (await getClient()).stopBuild(jobPath, buildNumber);
        return { content: [{ type: "text", text: `Stop requested for ${jobPath} #${buildNumber}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error stopping Jenkins build: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "set_keep_build_forever",
    "Set or clear 'Keep this build forever' on a Jenkins build. When kept, the build (its record and archived artifacts) is exempt from the job's discard/log-rotation policy — use this to preserve a build before a migration so it stays available for rollback. " +
      "Idempotent: reads the current state and only changes it when needed. Requires the Jenkins account to have Run/Delete on the job. " +
      "Confirm with the user before invoking because it changes retention of a live build.",
    {
      jobPath: z.string().describe("Slash-separated Jenkins job path (e.g. 'ARTS/arts-client-war')"),
      buildNumber: z.number().int().min(1).describe("Build number to keep or release"),
      keep: z
        .boolean()
        .default(true)
        .describe("true = keep this build forever (default); false = clear keep-forever and allow discarding"),
    },
    { readOnlyHint: false },
    async ({ jobPath, buildNumber, keep }) => {
      try {
        const result = await (await getClient()).setKeepBuildForever(jobPath, buildNumber, keep);
        const state = result.keepLog ? "kept forever" : "not kept (eligible for discard)";
        const action = result.changed
          ? `${jobPath} #${buildNumber} is now ${state}.`
          : `${jobPath} #${buildNumber} was already ${state}; no change made.`;
        return { content: [{ type: "text", text: action }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error setting keep-forever on Jenkins build: ${safeErr(err)}` }], isError: true };
      }
    }
  );

  registerExtendedJenkinsTools(server, getClient);

  return server;
}
