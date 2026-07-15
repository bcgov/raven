import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PiScrubber } from "@nrs/auth";
import { z } from "zod";
import type { JenkinsClient } from "./jenkins-client.js";
import type { JenkinsParameterDefinition, JenkinsQueueItem, JenkinsTestCase } from "./types.js";

const pi = new PiScrubber();
const sensitiveName = /password|passwd|token|secret|key|credential|auth/i;
const readAnnotations = { readOnlyHint: true } as const;
const writeAnnotations = { readOnlyHint: false } as const;

type GetClient = () => Promise<JenkinsClient>;
type SecretSource = { envVar: string } | { file: string };
type CredentialKind = "secretText" | "usernamePassword" | "sshPrivateKey";

interface CredentialInput {
  credentialId: string;
  kind: CredentialKind;
  description?: string;
  scope: "GLOBAL" | "SYSTEM";
  username?: string;
  secretSource: SecretSource;
  passphraseSource?: SecretSource;
}

const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const failure = (label: string, err: unknown) => ({
  content: [{ type: "text" as const, text: label + ": " + safeErr(err) }],
  isError: true,
});

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function resolveConfiguredPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function configuredRoot(envName: string, fallbackName: string): string {
  return resolveConfiguredPath(process.env[envName] ?? resolve(homedir(), ".raven", fallbackName));
}

function assertInsideRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("File must be inside protected directory " + root + ".");
  }
}

async function ensureProtectedRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
}

async function protectedPath(root: string, requested: string): Promise<string> {
  await ensureProtectedRoot(root);
  const candidate = resolve(root, requested);
  assertInsideRoot(root, candidate);
  return candidate;
}

async function writeProtectedFile(
  root: string,
  requested: string,
  content: string | Uint8Array,
  overwrite: boolean
): Promise<string> {
  const target = await protectedPath(root, requested);
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(dirname(target));
  assertInsideRoot(realRoot, realParent);
  try {
    const targetInfo = await fs.lstat(target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new Error("Protected output must be a regular file, not a symlink.");
    }
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  }
  await fs.writeFile(target, content, { mode: 0o600, flag: overwrite ? "w" : "wx" });
  await fs.chmod(target, 0o600);
  return target;
}

async function readProtectedFile(root: string, requested: string): Promise<Buffer> {
  const candidate = await protectedPath(root, requested);
  const fileInfo = await fs.lstat(candidate);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error("Protected input must be a regular file, not a symlink.");
  }
  if ((fileInfo.mode & 0o077) !== 0) {
    throw new Error("Protected input " + candidate + " must not be accessible by group or other users.");
  }
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(candidate);
  assertInsideRoot(realRoot, realFile);
  return fs.readFile(realFile);
}

async function writeConfigBackup(root: string, jobPath: string, xml: string, digest: string): Promise<string> {
  const safeJob = jobPath.replace(/[^A-Za-z0-9._-]+/g, "__");
  const backupFile = "backups/" + safeJob + "-" + digest + ".xml";
  try {
    return await writeProtectedFile(root, backupFile, xml, false);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    const existing = await readProtectedFile(root, backupFile);
    if (sha256(existing) !== digest) {
      throw new Error("Existing config backup does not match current Jenkins config.");
    }
    return protectedPath(root, backupFile);
  }
}

function redactXml(xml: string): string {
  let redacted = xml;
  for (const tag of [
    "password",
    "passphrase",
    "secret",
    "secretBytes",
    "clientSecret",
    "privateKey",
    "apiToken",
    "authToken",
    "token",
    "hudson.model.BuildAuthorizationToken",
  ]) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("(<" + escapedTag + "(?:\\s[^>]*)?>)[\\s\\S]*?(<\\/" + escapedTag + ">)", "gi");
    redacted = redacted.replace(pattern, "$1[REDACTED]$2");
  }
  return pi.scrubText(redacted);
}

async function readSecret(source: SecretSource): Promise<string> {
  if ("envVar" in source) {
    if (!/^JENKINS_[A-Z0-9_]+$/.test(source.envVar)) {
      throw new Error("Secret environment variables must use the JENKINS_ prefix.");
    }
    const value = process.env[source.envVar];
    if (value === undefined) {
      throw new Error("Secret environment variable " + source.envVar + " is not set.");
    }
    return value;
  }
  const root = configuredRoot("RAVEN_JENKINS_SECRET_DIR", "jenkins-secrets");
  const value = await readProtectedFile(root, source.file);
  return value.toString("utf8").replace(/\r?\n$/, "");
}

async function credentialPayload(input: CredentialInput): Promise<Record<string, unknown>> {
  const secret = await readSecret(input.secretSource);
  const common = {
    scope: input.scope,
    id: input.credentialId,
    description: input.description ?? "",
  };
  if (input.kind === "secretText") {
    return {
      ...common,
      secret,
      $class: "org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl",
    };
  }
  if (!input.username) throw new Error(input.kind + " credentials require username.");
  if (input.kind === "usernamePassword") {
    return {
      ...common,
      username: input.username,
      password: secret,
      $class: "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl",
    };
  }
  return {
    ...common,
    username: input.username,
    passphrase: input.passphraseSource ? await readSecret(input.passphraseSource) : "",
    privateKeySource: {
      privateKey: secret,
      $class: "com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey$DirectEntryPrivateKeySource",
    },
    $class: "com.cloudbees.jenkins.plugins.sshcredentials.impl.BasicSSHUserPrivateKey",
  };
}

function formatParameter(definition: JenkinsParameterDefinition): string {
  const defaultValue = definition.defaultParameterValue?.value;
  const renderedDefault = defaultValue === undefined
    ? ""
    : " | default: " + (sensitiveName.test(definition.name) ? "[REDACTED]" : pi.scrubText(String(defaultValue)));
  const choices = definition.choices?.length
    ? " | choices: " + definition.choices.map((choice) => pi.scrubText(choice)).join(", ")
    : "";
  const description = definition.description ? "\n  " + pi.scrubText(definition.description) : "";
  return "- **" + definition.name + "** (" + (definition.type ?? "unknown") + ")" + renderedDefault + choices + description;
}

function formatQueueItem(item: JenkinsQueueItem): string {
  const task = item.task?.fullName ?? item.task?.name ?? "unknown task";
  const executable = item.executable ? " | executable #" + item.executable.number : "";
  const reason = item.why ? "\n" + pi.scrubText(item.why) : "";
  return "**" + task + "** - queue " + item.id + executable + (item.cancelled ? " | cancelled" : "") + reason;
}

function failedTests(cases: JenkinsTestCase[]): JenkinsTestCase[] {
  return cases.filter((test) => test.status === "FAILED" || Boolean(test.errorDetails) || Boolean(test.errorStackTrace));
}

const secretSourceSchema = z.union([
  z.object({ envVar: z.string().regex(/^JENKINS_[A-Z0-9_]+$/) }),
  z.object({ file: z.string().min(1) }),
]);

const credentialFields = {
  credentialId: z.string().min(1).describe("Stable Jenkins credential ID"),
  kind: z.enum(["secretText", "usernamePassword", "sshPrivateKey"]),
  description: z.string().optional(),
  scope: z.enum(["GLOBAL", "SYSTEM"]).default("GLOBAL"),
  username: z.string().optional().describe("Required for username/password and SSH credentials"),
  secretSource: secretSourceSchema.describe("JENKINS_-prefixed environment variable or protected secret file; raw secrets are not accepted"),
  passphraseSource: secretSourceSchema.optional().describe("JENKINS_-prefixed environment variable or protected passphrase file"),
  store: z.string().default("system"),
  domain: z.string().default("_"),
};

export function registerExtendedJenkinsTools(server: McpServer, getClient: GetClient): void {
  server.tool(
    "get_controller_info",
    "Get Jenkins controller identity, version, executor mode, security, crumb, and quiet-down status.",
    {},
    readAnnotations,
    async () => {
      try {
        const info = await (await getClient()).getControllerInfo();
        return ok([
          "**Version:** " + (info.version ?? "unknown"),
          "**Node:** " + (info.nodeName ?? "unknown"),
          "**Mode:** " + (info.mode ?? "unknown") + " | **Executors:** " + (info.numExecutors ?? "unknown"),
          "**Security:** " + (info.useSecurity ? "enabled" : "disabled") +
            " | **Crumbs:** " + (info.useCrumbs ? "enabled" : "disabled") +
            " | **Quieting down:** " + (info.quietingDown ? "yes" : "no"),
          info.nodeDescription ? "**Description:** " + pi.scrubText(info.nodeDescription) : "",
        ].filter(Boolean).join("\n"));
      } catch (err) {
        return failure("Error reading Jenkins controller", err);
      }
    }
  );

  server.tool(
    "get_job_parameters",
    "List configured Jenkins build parameter definitions. Secret-like defaults are redacted.",
    { jobPath: z.string().min(1) },
    readAnnotations,
    async ({ jobPath }) => {
      try {
        const parameters = await (await getClient()).getJobParameters(jobPath);
        return ok(parameters.length ? parameters.map(formatParameter).join("\n") : jobPath + " has no configured build parameters.");
      } catch (err) {
        return failure("Error reading Jenkins job parameters", err);
      }
    }
  );

  server.tool(
    "get_job_config",
    "Read config.xml with secrets redacted, or export exact XML to the protected local config directory.",
    {
      jobPath: z.string().min(1),
      outputFile: z.string().optional().describe("Relative file under RAVEN_JENKINS_CONFIG_DIR"),
      overwrite: z.boolean().default(false),
      maxChars: z.number().int().min(1000).max(100000).default(30000),
    },
    writeAnnotations,
    async ({ jobPath, outputFile, overwrite, maxChars }) => {
      try {
        const xml = await (await getClient()).getJobConfig(jobPath);
        const digest = sha256(xml);
        if (outputFile) {
          const root = configuredRoot("RAVEN_JENKINS_CONFIG_DIR", "jenkins-configs");
          const target = await writeProtectedFile(root, outputFile, xml, overwrite);
          return ok("Exported exact config for " + jobPath + " to " + target + "\nSHA-256: " + digest);
        }
        const redacted = redactXml(xml);
        const rendered = redacted.length > maxChars
          ? redacted.slice(0, maxChars) + "\n... [TRUNCATED at " + maxChars + " of " + redacted.length + " chars]"
          : redacted;
        return ok("SHA-256: " + digest + "\n\n" + rendered);
      } catch (err) {
        return failure("Error reading Jenkins job config", err);
      }
    }
  );

  server.tool(
    "create_job",
    "Create a Jenkins job from config.xml in the protected local config directory.",
    { jobName: z.string().min(1).regex(/^[^/]+$/), folderPath: z.string().optional(), configFile: z.string().min(1) },
    writeAnnotations,
    async ({ jobName, folderPath, configFile }) => {
      try {
        const root = configuredRoot("RAVEN_JENKINS_CONFIG_DIR", "jenkins-configs");
        const xml = (await readProtectedFile(root, configFile)).toString("utf8");
        await (await getClient()).createJob(jobName, xml, folderPath);
        return ok("Created Jenkins job " + (folderPath ? folderPath + "/" : "") + jobName + ".");
      } catch (err) {
        return failure("Error creating Jenkins job", err);
      }
    }
  );

  server.tool(
    "copy_job",
    "Copy an existing Jenkins job into the root or a target folder.",
    { sourceJobPath: z.string().min(1), newJobName: z.string().min(1).regex(/^[^/]+$/), folderPath: z.string().optional() },
    writeAnnotations,
    async ({ sourceJobPath, newJobName, folderPath }) => {
      try {
        await (await getClient()).copyJob(sourceJobPath, newJobName, folderPath);
        return ok("Copied " + sourceJobPath + " to " + (folderPath ? folderPath + "/" : "") + newJobName + ".");
      } catch (err) {
        return failure("Error copying Jenkins job", err);
      }
    }
  );

  server.tool(
    "update_job_config",
    "Replace a job config from protected XML only when the current config SHA-256 matches expectedSha256.",
    { jobPath: z.string().min(1), configFile: z.string().min(1), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) },
    writeAnnotations,
    async ({ jobPath, configFile, expectedSha256 }) => {
      try {
        const client = await getClient();
        const current = await client.getJobConfig(jobPath);
        const actualSha = sha256(current);
        if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
          throw new Error(
            "Config changed concurrently: expected " + expectedSha256 + ", current " + actualSha + ". Export a fresh config before updating."
          );
        }
        const root = configuredRoot("RAVEN_JENKINS_CONFIG_DIR", "jenkins-configs");
        const backup = await writeConfigBackup(root, jobPath, current, actualSha);
        const next = (await readProtectedFile(root, configFile)).toString("utf8");
        await client.updateJobConfig(jobPath, next);
        const verified = await client.getJobConfig(jobPath);
        return ok(
          "Updated " + jobPath + " config. New SHA-256: " + sha256(verified) +
          "\nPrevious config backup: " + backup
        );
      } catch (err) {
        return failure("Error updating Jenkins job config", err);
      }
    }
  );

  server.tool(
    "enable_job",
    "Enable a Jenkins job.",
    { jobPath: z.string().min(1) },
    writeAnnotations,
    async ({ jobPath }) => {
      try {
        await (await getClient()).enableJob(jobPath);
        return ok("Enabled " + jobPath + ".");
      } catch (err) {
        return failure("Error enabling Jenkins job", err);
      }
    }
  );

  server.tool(
    "disable_job",
    "Disable a Jenkins job.",
    { jobPath: z.string().min(1) },
    writeAnnotations,
    async ({ jobPath }) => {
      try {
        await (await getClient()).disableJob(jobPath);
        return ok("Disabled " + jobPath + ".");
      } catch (err) {
        return failure("Error disabling Jenkins job", err);
      }
    }
  );

  server.tool(
    "get_queue_item",
    "Get one Jenkins queue item, including blockage reason and assigned executable.",
    { queueId: z.number().int().min(1) },
    readAnnotations,
    async ({ queueId }) => {
      try {
        return ok(formatQueueItem(await (await getClient()).getQueueItem(queueId)));
      } catch (err) {
        return failure("Error reading Jenkins queue item", err);
      }
    }
  );

  server.tool(
    "cancel_queue_item",
    "Cancel a queued Jenkins item before it starts.",
    { queueId: z.number().int().min(1) },
    writeAnnotations,
    async ({ queueId }) => {
      try {
        await (await getClient()).cancelQueueItem(queueId);
        return ok("Cancellation requested for Jenkins queue item " + queueId + ".");
      } catch (err) {
        return failure("Error cancelling Jenkins queue item", err);
      }
    }
  );

  server.tool(
    "get_progressive_console",
    "Read console output incrementally using the byte offset returned by the previous call.",
    {
      jobPath: z.string().min(1),
      buildNumber: z.number().int().min(1),
      start: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(1000).max(100000).default(20000),
    },
    readAnnotations,
    async ({ jobPath, buildNumber, start, maxChars }) => {
      try {
        const result = await (await getClient()).getProgressiveConsole(jobPath, buildNumber, start);
        const scrubbed = pi.scrubText(result.text);
        const output = scrubbed.length > maxChars ? scrubbed.slice(0, maxChars) + "\n... [TRUNCATED]" : scrubbed;
        return ok("Next start: " + result.nextStart + "\nMore data: " + (result.moreData ? "yes" : "no") + "\n\n" + output);
      } catch (err) {
        return failure("Error reading progressive Jenkins console", err);
      }
    }
  );

  server.tool(
    "list_build_artifacts",
    "List artifacts archived by a Jenkins build.",
    { jobPath: z.string().min(1), buildNumber: z.number().int().min(1) },
    readAnnotations,
    async ({ jobPath, buildNumber }) => {
      try {
        const artifacts = await (await getClient()).listBuildArtifacts(jobPath, buildNumber);
        return ok(artifacts.length ? artifacts.map((artifact) => "- " + artifact.relativePath).join("\n") : "No archived artifacts.");
      } catch (err) {
        return failure("Error listing Jenkins artifacts", err);
      }
    }
  );

  server.tool(
    "download_build_artifact",
    "Download one build artifact to the protected local download directory.",
    {
      jobPath: z.string().min(1),
      buildNumber: z.number().int().min(1),
      artifactPath: z.string().min(1),
      outputFile: z.string().optional(),
      overwrite: z.boolean().default(false),
    },
    writeAnnotations,
    async ({ jobPath, buildNumber, artifactPath, outputFile, overwrite }) => {
      try {
        const download = await (await getClient()).downloadBuildArtifact(jobPath, buildNumber, artifactPath);
        const root = configuredRoot("RAVEN_JENKINS_DOWNLOAD_DIR", "jenkins-downloads");
        const target = await writeProtectedFile(root, outputFile ?? basename(artifactPath), download.bytes, overwrite);
        return ok(
          "Downloaded " + artifactPath + " to " + target +
          "\nBytes: " + download.bytes.byteLength +
          "\nSHA-256: " + sha256(download.bytes) +
          (download.contentType ? "\nContent-Type: " + download.contentType : "")
        );
      } catch (err) {
        return failure("Error downloading Jenkins artifact", err);
      }
    }
  );

  server.tool(
    "get_build_test_report",
    "Get test totals and a bounded list of failed tests for a build.",
    {
      jobPath: z.string().min(1),
      buildNumber: z.number().int().min(1),
      maxFailures: z.number().int().min(0).max(100).default(20),
    },
    readAnnotations,
    async ({ jobPath, buildNumber, maxFailures }) => {
      try {
        const report = await (await getClient()).getBuildTestReport(jobPath, buildNumber);
        const failures = failedTests((report.suites ?? []).flatMap((suite) => suite.cases ?? [])).slice(0, maxFailures);
        const lines = [
          "Passed: " + report.passCount + " | Failed: " + report.failCount + " | Skipped: " + report.skipCount +
            " | Total: " + (report.totalCount ?? report.passCount + report.failCount + report.skipCount),
          ...failures.map((test) =>
            "- **" + (test.className ? test.className + "." : "") + test.name + "**" +
            (test.errorDetails ? " - " + pi.scrubText(test.errorDetails) : "")
          ),
        ];
        return ok(lines.join("\n"));
      } catch (err) {
        return failure("Error reading Jenkins test report", err);
      }
    }
  );

  server.tool(
    "get_build_changes",
    "Get SCM changes associated with a Jenkins build.",
    {
      jobPath: z.string().min(1),
      buildNumber: z.number().int().min(1),
      limit: z.number().int().min(1).max(200).default(50),
    },
    readAnnotations,
    async ({ jobPath, buildNumber, limit }) => {
      try {
        const changeSets = await (await getClient()).getBuildChanges(jobPath, buildNumber);
        const changes = changeSets.flatMap((set) => set.items ?? []).slice(0, limit);
        const lines = changes.map((change) =>
          "- " + (change.id ? change.id.slice(0, 12) + " " : "") +
          pi.scrubText(change.msg ?? "No message") +
          (change.author?.fullName ? " - " + pi.scrubText(change.author.fullName) : "")
        );
        return ok(lines.length ? lines.join("\n") : "No SCM changes recorded for this build.");
      } catch (err) {
        return failure("Error reading Jenkins build changes", err);
      }
    }
  );

  server.tool(
    "list_promotions",
    "List promotion processes configured by the Promoted Builds plugin.",
    { jobPath: z.string().min(1) },
    readAnnotations,
    async ({ jobPath }) => {
      try {
        const promotions = await (await getClient()).listPromotions(jobPath);
        const lines = promotions.map((promotion) =>
          "- **" + promotion.name + "**" +
          (promotion.description ? " - " + pi.scrubText(promotion.description) : "") +
          (promotion.lastBuild ? " | last #" + promotion.lastBuild.number : "") +
          (promotion.url ? "\n  " + promotion.url : "")
        );
        return ok(lines.length ? lines.join("\n") : jobPath + " has no promotion processes.");
      } catch (err) {
        return failure("Error listing Jenkins promotions", err);
      }
    }
  );

  server.tool(
    "get_promotion",
    "Get promotion status for one build and promotion process.",
    { jobPath: z.string().min(1), buildNumber: z.number().int().min(1), promotionName: z.string().min(1) },
    readAnnotations,
    async ({ jobPath, buildNumber, promotionName }) => {
      try {
        const promotion = await (await getClient()).getPromotion(jobPath, buildNumber, promotionName);
        return ok(pi.scrubText(JSON.stringify(promotion, null, 2)));
      } catch (err) {
        return failure("Error reading Jenkins promotion", err);
      }
    }
  );

  server.tool(
    "trigger_promotion",
    "Force a configured Jenkins promotion for a specific build.",
    { jobPath: z.string().min(1), buildNumber: z.number().int().min(1), promotionName: z.string().min(1) },
    writeAnnotations,
    async ({ jobPath, buildNumber, promotionName }) => {
      try {
        await (await getClient()).triggerPromotion(jobPath, buildNumber, promotionName);
        return ok("Triggered promotion " + promotionName + " for " + jobPath + " #" + buildNumber + ".");
      } catch (err) {
        return failure("Error triggering Jenkins promotion", err);
      }
    }
  );

  server.tool(
    "list_credentials",
    "List credential metadata only. Secret values are never returned.",
    { store: z.string().default("system"), domain: z.string().default("_") },
    readAnnotations,
    async ({ store, domain }) => {
      try {
        const credentials = await (await getClient()).listCredentials(store, domain);
        const lines = credentials.map((credential) =>
          "- **" + credential.id + "** (" + (credential.typeName ?? "unknown") + ")" +
          (credential.description ? " - " + pi.scrubText(credential.description) : "")
        );
        return ok(lines.length ? lines.join("\n") : "No credentials returned for this store/domain.");
      } catch (err) {
        return failure("Error listing Jenkins credentials", err);
      }
    }
  );

  server.tool(
    "get_credential_metadata",
    "Get metadata for one credential without exposing its secret value.",
    { credentialId: z.string().min(1), store: z.string().default("system"), domain: z.string().default("_") },
    readAnnotations,
    async ({ credentialId, store, domain }) => {
      try {
        const credential = await (await getClient()).getCredentialMetadata(credentialId, store, domain);
        return ok(
          "**" + credential.id + "**\nType: " + (credential.typeName ?? "unknown") +
          "\nDescription: " + (credential.description ? pi.scrubText(credential.description) : "none")
        );
      } catch (err) {
        return failure("Error reading Jenkins credential metadata", err);
      }
    }
  );

  server.tool(
    "create_credential",
    "Create a secret-text, username/password, or SSH private-key credential from a protected secret source.",
    credentialFields,
    writeAnnotations,
    async ({ credentialId, kind, description, scope, username, secretSource, passphraseSource, store, domain }) => {
      try {
        const payload = await credentialPayload({
          credentialId, kind, description, scope, username, secretSource, passphraseSource,
        });
        await (await getClient()).createCredential(payload, store, domain);
        return ok("Created Jenkins credential " + credentialId + "; no secret value was returned.");
      } catch (err) {
        return failure("Error creating Jenkins credential", err);
      }
    }
  );

  server.tool(
    "update_credential",
    "Replace a credential in place using a protected secret source.",
    credentialFields,
    writeAnnotations,
    async ({ credentialId, kind, description, scope, username, secretSource, passphraseSource, store, domain }) => {
      try {
        const payload = await credentialPayload({
          credentialId, kind, description, scope, username, secretSource, passphraseSource,
        });
        await (await getClient()).updateCredential(credentialId, payload, store, domain);
        return ok("Updated Jenkins credential " + credentialId + "; no secret value was returned.");
      } catch (err) {
        return failure("Error updating Jenkins credential", err);
      }
    }
  );

  server.tool(
    "delete_credential",
    "Delete one credential by ID.",
    { credentialId: z.string().min(1), store: z.string().default("system"), domain: z.string().default("_") },
    writeAnnotations,
    async ({ credentialId, store, domain }) => {
      try {
        await (await getClient()).deleteCredential(credentialId, store, domain);
        return ok("Deleted Jenkins credential " + credentialId + ".");
      } catch (err) {
        return failure("Error deleting Jenkins credential", err);
      }
    }
  );
}
