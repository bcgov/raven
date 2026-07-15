import { createHash, randomUUID } from "node:crypto";
import { constants, openAsBlob } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createBasicAuthFetch, PiScrubber } from "@nrs/auth";
import {
  ARTIFACTORY_PROPERTY_KEY,
  ARTIFACTORY_REPOSITORY_KEY,
  ArtifactoryClient,
  ArtifactoryHttpError,
  DEFAULT_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS,
  MAX_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS,
  encodeArtifactoryPath,
  normalizeArtifactoryBaseUrl,
  validateArtifactoryProperties,
} from "./artifactory-client.js";

const pi = new PiScrubber();
const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
const repositorySchema = z.string().min(1).regex(
  ARTIFACTORY_REPOSITORY_KEY,
  "Repository keys may contain only letters, numbers, periods, underscores, and hyphens.",
);
function validItemPath(value: string, allowEmpty = false): boolean {
  if (value.startsWith("/") || value.endsWith("/")) return false;
  try {
    encodeArtifactoryPath(value, allowEmpty);
    return true;
  } catch {
    return false;
  }
}
const itemPathSchema = z.string().min(1).max(8192).refine(
  (value) => validItemPath(value),
  "Item paths cannot contain leading or trailing slashes, traversal, empty segments, backslashes, or NUL bytes.",
);
const folderPathSchema = z.string().max(8192).refine(
  (value) => validItemPath(value, true),
  "Folder paths cannot contain leading or trailing slashes, traversal, empty segments, backslashes, or NUL bytes.",
);

const safeErr = (error: unknown): string => pi.scrubText(error instanceof Error ? error.message : String(error));
const safeJson = (value: unknown): string => {
  const text = pi.scrubText(JSON.stringify(value, null, 2));
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated]`;
};
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errorResult = (context: string, error: unknown) => ({
  content: [{ type: "text" as const, text: `${context}: ${safeErr(error)}` }],
  isError: true as const,
});

export function configuredArtifactoryCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { email: string; password: string } | null {
  const email = env["ARTIFACTORY_EMAIL"];
  const password = env["ARTIFACTORY_PASSWORD"];
  return email && password ? { email, password } : null;
}

function configuredBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env["ARTIFACTORY_URL"];
  if (!value) throw new Error("ARTIFACTORY_URL is not set. Add it to ~/.raven/.env.");
  return normalizeArtifactoryBaseUrl(value);
}

function configuredDownloadRedirectHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env["RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS"] ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function maxTransferBytes(): number {
  const value = Number(process.env["RAVEN_ARTIFACTORY_MAX_TRANSFER_BYTES"] ?? DEFAULT_MAX_TRANSFER_BYTES);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("RAVEN_ARTIFACTORY_MAX_TRANSFER_BYTES must be a positive integer.");
  return value;
}

function downloadTimeoutMs(): number {
  const value = Number(
    process.env["RAVEN_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS"] ?? DEFAULT_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS,
  );
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS) {
    throw new Error("RAVEN_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS must be an integer between 1 and 86400000.");
  }
  return value;
}

function resolveConfiguredPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function uploadRoot(): string {
  return resolveConfiguredPath(process.env["RAVEN_ARTIFACTORY_UPLOAD_DIR"] ?? join(homedir(), ".raven", "artifactory-uploads"));
}

function downloadRoot(): string {
  return resolveConfiguredPath(process.env["RAVEN_ARTIFACTORY_DOWNLOAD_DIR"] ?? join(homedir(), ".raven", "artifactory-downloads"));
}

function safeRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    throw new Error("Protected file paths must be non-empty relative paths using forward slashes.");
  }
  const normalized = value.split("/");
  if (normalized.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Protected file path contains traversal or empty segments.");
  }
  return normalized.join(sep);
}

function assertInside(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    if (!fromRoot) return;
    throw new Error("Protected file path escapes its configured directory.");
  }
}

async function assertRestrictedDirectory(root: string, create: boolean): Promise<string> {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const resolvedRoot = await realpath(root);
  const rootStat = await stat(resolvedRoot);
  if (!rootStat.isDirectory()) throw new Error("Configured Artifactory transfer directory is not a directory.");
  if (process.platform !== "win32" && (rootStat.mode & 0o077) !== 0) {
    throw new Error("Configured Artifactory transfer directory must not be accessible by group or other users (chmod 700).");
  }
  return resolvedRoot;
}

async function ensureSafeDirectoryTree(root: string, target: string): Promise<string> {
  assertInside(root, target);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    const next = join(current, part);
    try {
      const info = await lstat(next);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Download path contains a symbolic link or non-directory component.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(next, { mode: 0o700 });
    }
    current = await realpath(next);
    assertInside(root, current);
  }
  return current;
}

async function readProtectedUpload(relativePath: string): Promise<{ data: Blob; absolutePath: string }> {
  const root = await assertRestrictedDirectory(uploadRoot(), false);
  const candidate = resolve(root, safeRelativePath(relativePath));
  assertInside(root, candidate);
  const canonical = await realpath(candidate);
  assertInside(root, canonical);
  const fileInfo = await lstat(candidate);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Upload source must be a regular, non-symbolic-link file.");
  if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
    throw new Error("Upload source file must not be accessible by group or other users (chmod 600).");
  }
  if (fileInfo.size > maxTransferBytes()) throw new Error("Upload source exceeds the configured transfer limit.");
  const data = await openAsBlob(canonical);
  if (data.size !== fileInfo.size) throw new Error("Upload source changed while it was being opened.");
  return { data, absolutePath: canonical };
}

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onChunk?: (chunk: Uint8Array) => Promise<void>,
): Promise<{ bytes: number; sha1: string; sha256: string }> {
  const sha1 = createHash("sha1");
  const sha256 = createHash("sha256");
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Artifact exceeds the configured transfer limit of ${maxBytes} bytes.`);
      }
      sha1.update(value);
      sha256.update(value);
      await onChunk?.(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* preserve the original transfer error */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return { bytes, sha1: sha1.digest("hex"), sha256: sha256.digest("hex") };
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Unable to make progress writing the downloaded artifact.");
    offset += bytesWritten;
  }
}

async function writeProtectedDownload(
  repository: string,
  itemPath: string,
  stream: ReadableStream<Uint8Array>,
  overwrite: boolean,
  expected: { sha1?: string; sha256?: string },
  maxBytes: number,
): Promise<{ destination: string; bytes: number; sha1: string; sha256: string }> {
  let temporaryPath: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await assertRestrictedDirectory(downloadRoot(), true);
    const destination = resolve(root, safeRelativePath(`${repository}/${itemPath}`));
    assertInside(root, destination);
    const canonicalParent = await ensureSafeDirectoryTree(root, dirname(destination));
    const canonicalDestination = join(canonicalParent, basename(destination));
    temporaryPath = join(canonicalParent, `.${basename(destination)}.${randomUUID()}.tmp`);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(temporaryPath, flags, 0o600);
    const digests = await consumeStream(stream, maxBytes, (chunk) => writeAll(handle!, chunk));
    await handle.close();
    handle = undefined;

    if (expected.sha256 && expected.sha256.toLowerCase() !== digests.sha256) {
      throw new Error("Downloaded artifact SHA-256 does not match Artifactory metadata.");
    }
    if (!expected.sha256 && expected.sha1?.toLowerCase() !== digests.sha1) {
      throw new Error("Downloaded artifact SHA-1 does not match Artifactory metadata.");
    }

    if (overwrite) {
      try {
        const existing = await lstat(canonicalDestination);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error("Download destination is not a regular file.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(temporaryPath, canonicalDestination);
      temporaryPath = undefined;
    } else {
      await link(temporaryPath, canonicalDestination);
    }
    return { destination: canonicalDestination, ...digests };
  } catch (error) {
    if (!stream.locked) {
      try { await stream.cancel(); } catch { /* preserve the original transfer error */ }
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createArtifactoryServer(clientOverride?: ArtifactoryClient): McpServer {
  const server = new McpServer(
    { name: "RAVEN Artifactory", version: "0.1.0" },
    {
      instructions:
        "Generic JFrog Artifactory tools compatible with the configured Artifactory 6.x server. " +
        "The server URL must use HTTPS and credentials come only from ARTIFACTORY_EMAIL and ARTIFACTORY_PASSWORD. " +
        "Write tools modify live artifacts or protected local files; obtain user approval before calling them. " +
        "Copy and move default to dry-run. Uploads read only from the protected upload directory, downloads write only to the protected download directory, and deletion requires the current SHA-256 plus an exact path confirmation.",
    },
  );

  let client = clientOverride ?? null;
  function getClient(): ArtifactoryClient {
    if (!client) {
      const credentials = configuredArtifactoryCredentials();
      if (!credentials) {
        throw new Error("ARTIFACTORY_EMAIL and ARTIFACTORY_PASSWORD are required in ~/.raven/.env; Atlassian credentials are not reused implicitly.");
      }
      const baseUrl = configuredBaseUrl();
      client = new ArtifactoryClient(createBasicAuthFetch(credentials.email, credentials.password), baseUrl, {
        allowedDownloadRedirectHosts: configuredDownloadRedirectHosts(),
        downloadTimeoutMs: downloadTimeoutMs(),
      });
    }
    return client;
  }

  server.tool("artifactory_ping", "Check whether the configured Artifactory service is reachable and authenticated.", {}, { readOnlyHint: true }, async () => {
    try { return textResult(await getClient().ping()); } catch (error) { return errorResult("Artifactory ping failed", error); }
  });

  server.tool("artifactory_get_version", "Get the Artifactory version, revision, and installed add-ons.", {}, { readOnlyHint: true }, async () => {
    try { return textResult(safeJson(await getClient().getVersion())); } catch (error) { return errorResult("Unable to read Artifactory version", error); }
  });

  server.tool("artifactory_list_repositories", "List repositories visible to the authenticated user, optionally filtered by repository or package type.", {
    type: z.enum(["local", "remote", "virtual"]).optional(),
    packageType: z.string().min(1).optional(),
  }, { readOnlyHint: true }, async (args) => {
    try { return textResult(safeJson(await getClient().listRepositories(args))); } catch (error) { return errorResult("Unable to list Artifactory repositories", error); }
  });

  const itemSchema = {
    repository: repositorySchema.describe("Repository key"),
    itemPath: itemPathSchema.describe("Path within the repository, without a leading slash"),
  };

  server.tool("artifactory_get_item_info", "Get artifact or folder metadata, including checksums and download URI.", itemSchema, { readOnlyHint: true }, async ({ repository, itemPath }) => {
    try { return textResult(safeJson(await getClient().getItemInfo(repository, itemPath))); } catch (error) { return errorResult("Unable to read Artifactory item", error); }
  });

  server.tool("artifactory_list_folder", "List files and folders beneath a repository path using the Artifactory 6 storage API.", {
    repository: repositorySchema,
    itemPath: folderPathSchema.default(""),
    deep: z.boolean().default(false),
    depth: z.number().int().min(1).max(20).optional(),
    includeFolders: z.boolean().default(true),
  }, { readOnlyHint: true }, async ({ repository, itemPath, deep, depth, includeFolders }) => {
    try { return textResult(safeJson(await getClient().listFolder(repository, itemPath, { deep, depth, includeFolders }))); } catch (error) { return errorResult("Unable to list Artifactory folder", error); }
  });

  server.tool("artifactory_get_item_properties", "Get properties attached to an artifact or folder.", itemSchema, { readOnlyHint: true }, async ({ repository, itemPath }) => {
    try { return textResult(safeJson(await getClient().getItemProperties(repository, itemPath))); } catch (error) { return errorResult("Unable to read Artifactory properties", error); }
  });

  server.tool("artifactory_get_item_stats", "Get artifact download statistics, including counts and last-download details.", itemSchema, { readOnlyHint: true }, async ({ repository, itemPath }) => {
    try { return textResult(safeJson(await getClient().getItemStats(repository, itemPath))); } catch (error) { return errorResult("Unable to read Artifactory statistics", error); }
  });

  server.tool("artifactory_search_artifacts", "Search artifacts by partial file name, optionally limited to repository keys.", {
    name: z.string().min(1),
    repositories: z.array(repositorySchema).max(50).default([]),
  }, { readOnlyHint: true }, async ({ name, repositories }) => {
    try { return textResult(safeJson(await getClient().searchArtifacts(name, repositories))); } catch (error) { return errorResult("Artifactory artifact search failed", error); }
  });

  server.tool("artifactory_search_items", "Run a bounded, structured Artifactory Query Language item search. This does not accept arbitrary AQL.", {
    repository: repositorySchema,
    pathPattern: z.string().optional(),
    namePattern: z.string().optional(),
    type: z.enum(["file", "folder", "any"]).default("any"),
    properties: z.record(z.string(), z.string()).default({}),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).max(100_000).default(0),
  }, { readOnlyHint: true }, async (args) => {
    try { return textResult(safeJson(await getClient().searchItems(args))); } catch (error) { return errorResult("Artifactory item search failed", error); }
  });

  server.tool("artifactory_list_builds", "List build-info names available in Artifactory.", {}, { readOnlyHint: true }, async () => {
    try { return textResult(safeJson(await getClient().listBuilds())); } catch (error) { return errorResult("Unable to list Artifactory builds", error); }
  });

  server.tool("artifactory_list_build_runs", "List published build numbers for one Artifactory build-info name.", {
    buildName: z.string().min(1),
  }, { readOnlyHint: true }, async ({ buildName }) => {
    try { return textResult(safeJson(await getClient().listBuildRuns(buildName))); } catch (error) { return errorResult("Unable to list Artifactory build runs", error); }
  });

  server.tool("artifactory_get_build_info", "Get published build-info for a build name and number.", {
    buildName: z.string().min(1),
    buildNumber: z.string().min(1),
  }, { readOnlyHint: true }, async ({ buildName, buildNumber }) => {
    try { return textResult(safeJson(await getClient().getBuildInfo(buildName, buildNumber))); } catch (error) { return errorResult("Unable to read Artifactory build-info", error); }
  });

  server.tool("artifactory_download_artifact", "Download an artifact into the protected local download directory and verify its server-provided checksum.", {
    ...itemSchema,
    overwrite: z.boolean().default(false).describe("Replace an existing protected download on non-Windows platforms; disabled on Windows"),
  }, { readOnlyHint: false }, async ({ repository, itemPath, overwrite }) => {
    try {
      if (overwrite && process.platform === "win32") {
        throw new Error("Download overwrite is disabled on Windows to prevent reparse-point races; remove the existing protected file first.");
      }
      const info = await getClient().getItemInfo(repository, itemPath);
      if (!info.checksums?.sha256 && !info.checksums?.sha1) throw new Error("Artifactory did not provide a checksum for this item.");
      const limit = maxTransferBytes();
      const download = await getClient().downloadArtifact(repository, itemPath, limit);
      return textResult(safeJson(await writeProtectedDownload(
        repository,
        itemPath,
        download.body,
        overwrite,
        info.checksums,
        limit,
      )));
    } catch (error) { return errorResult("Unable to download Artifactory artifact", error); }
  });

  server.tool("artifactory_upload_artifact", "Upload a regular file from the protected local upload directory, with SHA-1 and SHA-256 verification headers.", {
    sourceFile: z.string().min(1).describe("Relative path beneath RAVEN_ARTIFACTORY_UPLOAD_DIR"),
    repository: repositorySchema,
    itemPath: itemPathSchema,
    overwrite: z.boolean().default(false),
  }, { readOnlyHint: false }, async ({ sourceFile, repository, itemPath, overwrite }) => {
    try {
      if (!overwrite) {
        try {
          await getClient().getItemInfo(repository, itemPath);
          throw new Error("Destination already exists; set overwrite=true only after explicit user approval.");
        } catch (error) {
          if (!(error instanceof ArtifactoryHttpError) || error.status !== 404) throw error;
        }
      }
      const { data, absolutePath } = await readProtectedUpload(sourceFile);
      const { bytes, sha1, sha256 } = await consumeStream(data.stream(), maxTransferBytes());
      if (bytes !== data.size) throw new Error("Upload source changed while its checksums were being calculated.");
      // The file-backed Blob is read again for upload; Artifactory verifies these
      // checksum headers and rejects any concurrent content change rather than storing it.
      const result = await getClient().uploadArtifact(repository, itemPath, data, { sha1, sha256 });
      return textResult(safeJson({ source: absolutePath, bytes, sha1, sha256, result }));
    } catch (error) { return errorResult("Unable to upload Artifactory artifact", error); }
  });

  const transferSchema = {
    sourceRepository: repositorySchema,
    sourcePath: itemPathSchema,
    targetRepository: repositorySchema,
    targetPath: itemPathSchema,
    execute: z.boolean().default(false).describe("False performs a dry-run; true performs the live operation"),
    confirmation: z.string().optional().describe("For execution, exact target or source path required by the tool"),
  };

  server.tool("artifactory_copy_item", "Dry-run or copy an artifact/folder. Live execution requires confirmation equal to targetRepository/targetPath.", transferSchema, { readOnlyHint: false }, async (args) => {
    try {
      const target = `${args.targetRepository}/${args.targetPath}`;
      if (args.execute && args.confirmation !== target) throw new Error(`Live copy confirmation must exactly equal ${target}`);
      return textResult(safeJson(await getClient().copyItem(args.sourceRepository, args.sourcePath, args.targetRepository, args.targetPath, !args.execute)));
    } catch (error) { return errorResult("Artifactory copy failed", error); }
  });

  server.tool("artifactory_move_item", "Dry-run or move an artifact/folder. Live execution requires confirmation equal to sourceRepository/sourcePath.", transferSchema, { readOnlyHint: false }, async (args) => {
    try {
      const source = `${args.sourceRepository}/${args.sourcePath}`;
      if (args.execute && args.confirmation !== source) throw new Error(`Live move confirmation must exactly equal ${source}`);
      return textResult(safeJson(await getClient().moveItem(args.sourceRepository, args.sourcePath, args.targetRepository, args.targetPath, !args.execute)));
    } catch (error) { return errorResult("Artifactory move failed", error); }
  });

  server.tool("artifactory_delete_item", "Delete one artifact after verifying its current SHA-256. Folder deletion is refused.", {
    ...itemSchema,
    expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    confirmation: z.string().min(1).describe("Must exactly equal repository/itemPath"),
  }, { readOnlyHint: false }, async ({ repository, itemPath, expectedSha256, confirmation }) => {
    try {
      const target = `${repository}/${itemPath}`;
      if (confirmation !== target) throw new Error(`Delete confirmation must exactly equal ${target}`);
      const info = await getClient().getItemInfo(repository, itemPath);
      if (info.children || !info.checksums?.sha256) throw new Error("Deletion is limited to files with a server-provided SHA-256; folders are refused.");
      if (info.checksums.sha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error("Expected SHA-256 does not match the current Artifactory item.");
      await getClient().deleteItem(repository, itemPath);
      return textResult(`Deleted ${target} after SHA-256 verification.`);
    } catch (error) { return errorResult("Artifactory delete failed", error); }
  });

  server.tool("artifactory_set_item_properties", "Set properties on an artifact or folder. Recursive updates default off and require exact path confirmation.", {
    ...itemSchema,
    properties: z.record(z.string(), z.array(z.string().min(1)).min(1)),
    recursive: z.boolean().default(false),
    confirmation: z.string().min(1).describe("Must exactly equal repository/itemPath"),
  }, { readOnlyHint: false }, async ({ repository, itemPath, properties, recursive, confirmation }) => {
    try {
      const target = `${repository}/${itemPath}`;
      if (confirmation !== target) throw new Error(`Property confirmation must exactly equal ${target}`);
      validateArtifactoryProperties(properties);
      await getClient().setItemProperties(repository, itemPath, properties, recursive);
      return textResult(`Updated properties on ${target}${recursive ? " recursively" : ""}.`);
    } catch (error) { return errorResult("Unable to set Artifactory properties", error); }
  });

  server.tool("artifactory_delete_item_properties", "Delete named properties from an artifact or folder. Recursive updates default off and require exact path confirmation.", {
    ...itemSchema,
    propertyKeys: z.array(z.string().regex(ARTIFACTORY_PROPERTY_KEY)).min(1).max(50),
    recursive: z.boolean().default(false),
    confirmation: z.string().min(1).describe("Must exactly equal repository/itemPath"),
  }, { readOnlyHint: false }, async ({ repository, itemPath, propertyKeys, recursive, confirmation }) => {
    try {
      const target = `${repository}/${itemPath}`;
      if (confirmation !== target) throw new Error(`Property confirmation must exactly equal ${target}`);
      await getClient().deleteItemProperties(repository, itemPath, propertyKeys, recursive);
      return textResult(`Deleted ${propertyKeys.length} propert${propertyKeys.length === 1 ? "y" : "ies"} from ${target}${recursive ? " recursively" : ""}.`);
    } catch (error) { return errorResult("Unable to delete Artifactory properties", error); }
  });

  return server;
}
