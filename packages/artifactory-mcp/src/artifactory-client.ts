import { isSessionExpired } from "@nrs/auth";
import type { AuthenticatedFetch } from "@nrs/auth";
import type {
  ArtifactoryFolderList,
  ArtifactoryItemInfo,
  ArtifactoryItemSearch,
  ArtifactoryRepository,
  ArtifactorySearchResult,
  ArtifactoryVersion,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;
/** Supported characters for Artifactory repository keys. */
export const ARTIFACTORY_REPOSITORY_KEY = /^[A-Za-z0-9._-]+$/;
/** Supported characters for Artifactory property keys. */
export const ARTIFACTORY_PROPERTY_KEY = /^[A-Za-z0-9._-]+$/;
const ARTIFACTORY_PROPERTY_VALUE = /^[^,;|=\\\0\r\n]+$/;

/** Options controlling narrowly-scoped direct-download redirect handling. */
export interface ArtifactoryClientOptions {
  /** Exact HTTPS hostname or hostname:port entries approved for direct downloads. */
  allowedDownloadRedirectHosts?: Iterable<string>;
  /** Maximum time allowed for an artifact download, including streaming the body. */
  downloadTimeoutMs?: number;
  /** Credential-free transport used only for approved external storage downloads. */
  unauthenticatedFetch?: AuthenticatedFetch;
}

/** HTTP error containing only bounded Artifactory status metadata. */
export class ArtifactoryHttpError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
    operation: string,
  ) {
    super(`Artifactory API error ${status} ${statusText} on ${operation}`);
  }
}

/** Normalize and require an absolute HTTPS Artifactory base URL without credentials. */
export function normalizeArtifactoryBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Artifactory base URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Artifactory base URL must use HTTPS; refusing to send credentials over an insecure connection.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Artifactory base URL must not contain embedded credentials.");
  }
  if (parsed.search) throw new Error("Artifactory base URL must not contain a query string.");
  if (parsed.hash) throw new Error("Artifactory base URL must not contain a fragment.");
  return parsed.toString().replace(/\/+$/, "");
}

/** Validate and encode one Artifactory repository key. */
export function encodeRepositoryKey(repository: string): string {
  if (!ARTIFACTORY_REPOSITORY_KEY.test(repository)) {
    throw new Error("Artifactory repository key contains unsupported characters.");
  }
  return encodeURIComponent(repository);
}

/** Encode a slash-separated Artifactory item path while rejecting traversal and ambiguous separators. */
export function encodeArtifactoryPath(itemPath: string, allowEmpty = false): string {
  if (itemPath.includes("\\")) throw new Error("Artifactory item paths cannot contain backslashes.");
  if (itemPath.includes("\0")) throw new Error("Artifactory item paths cannot contain NUL bytes.");
  let start = 0;
  let end = itemPath.length;
  while (start < end && itemPath[start] === "/") start++;
  while (end > start && itemPath[end - 1] === "/") end--;
  const trimmed = itemPath.slice(start, end);
  if (!trimmed) {
    if (allowEmpty) return "";
    throw new Error("Artifactory item path cannot be empty.");
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Artifactory item path contains traversal or empty segments.");
  }
  return segments.map(encodeURIComponent).join("/");
}

/** Validate property keys and values before they are encoded as Artifactory matrix parameters. */
export function validateArtifactoryProperties(properties: Record<string, string[]>): void {
  if (Object.keys(properties).length === 0) throw new Error("At least one property is required.");
  for (const [key, values] of Object.entries(properties)) {
    if (!ARTIFACTORY_PROPERTY_KEY.test(key)) throw new Error(`Invalid Artifactory property key: ${key}`);
    if (!values.length || values.some((value) => !ARTIFACTORY_PROPERTY_VALUE.test(value))) {
      throw new Error(`Property ${key} has an empty value or an unsupported reserved character.`);
    }
  }
}

function normalizeRedirectHost(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(`https://${trimmed}`);
  } catch {
    throw new Error("Artifactory download redirect hosts must be valid hostnames.");
  }
  if (!trimmed || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Artifactory download redirect hosts must contain only a hostname and optional port.");
  }
  return parsed.host.toLowerCase();
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function redirectTarget(response: Response, currentUrl: string): URL {
  const location = response.headers.get("location");
  if (!location) throw new Error("Artifactory redirect did not include a Location header.");
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new Error("Artifactory redirect contained an invalid Location header.");
  }
}

function isAuthenticationRedirect(response: Response, target: URL): boolean {
  const destination = `${target.hostname}${target.pathname}`;
  return isSessionExpired(response) || /(?:login|logon|signin|siteminder|fedlaunch)/i.test(destination);
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}

/**
 * Bounded Artifactory 6 REST client. The controller URL must use HTTPS, and
 * authenticated requests never follow redirects outside its configured context.
 */
export class ArtifactoryClient {
  private readonly baseUrl: string;
  private readonly base: URL;
  private readonly allowedDownloadRedirectHosts: Set<string>;
  private readonly downloadTimeoutMs: number;
  private readonly unauthenticatedFetch: AuthenticatedFetch;

  constructor(
    private readonly fetchFn: AuthenticatedFetch,
    baseUrl: string,
    options: ArtifactoryClientOptions = {},
  ) {
    this.baseUrl = normalizeArtifactoryBaseUrl(baseUrl);
    this.base = new URL(`${this.baseUrl}/`);
    this.allowedDownloadRedirectHosts = new Set(
      [...(options.allowedDownloadRedirectHosts ?? [])].map(normalizeRedirectHost),
    );
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.downloadTimeoutMs) ||
        this.downloadTimeoutMs < 1 ||
        this.downloadTimeoutMs > MAX_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS) {
      throw new Error("Artifactory download timeout must be an integer between 1 and 86400000 milliseconds.");
    }
    this.unauthenticatedFetch = options.unauthenticatedFetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  private isControllerUrl(target: URL): boolean {
    const basePathWithoutSlash = this.base.pathname.replace(/\/$/, "");
    return target.origin === this.base.origin &&
      (target.pathname === basePathWithoutSlash || target.pathname.startsWith(this.base.pathname));
  }

  private async followDownloadRedirect(
    initialResponse: Response,
    initialUrl: string,
    init: RequestInit,
  ): Promise<Response> {
    let response = initialResponse;
    let currentUrl = initialUrl;
    for (let attempt = 0; attempt < MAX_DOWNLOAD_REDIRECTS; attempt++) {
      const target = redirectTarget(response, currentUrl);
      if (isAuthenticationRedirect(response, target)) {
        throw new Error("Artifactory refused an authentication redirect on artifact download.");
      }
      if (target.protocol !== "https:") {
        throw new Error("Artifactory download redirects must use HTTPS.");
      }
      if (target.username || target.password) {
        throw new Error("Artifactory download redirects must not contain embedded credentials.");
      }

      const controllerTarget = this.isControllerUrl(target);
      if (!controllerTarget && !this.allowedDownloadRedirectHosts.has(target.host.toLowerCase())) {
        throw new Error(
          "Artifactory download redirected to an unapproved host. " +
          "Verify the storage backend and add its exact HTTPS hostname to RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS.",
        );
      }

      const headers = new Headers(init.headers);
      let redirectFetch = this.fetchFn;
      if (!controllerTarget) {
        headers.delete("Authorization");
        headers.delete("Cookie");
        headers.delete("Proxy-Authorization");
        redirectFetch = this.unauthenticatedFetch;
      }
      response = await redirectFetch(target.toString(), {
        ...init,
        headers,
        redirect: "manual",
      });
      currentUrl = target.toString();
      if (!isRedirect(response)) return response;
    }
    throw new Error(`Artifactory download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects.`);
  }

  private async request(
    operation: string,
    init: RequestInit = {},
    allowDownloadRedirect = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const requestUrl = `${this.baseUrl}/${operation}`;
    const requestInit: RequestInit = {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    let response = await this.fetchFn(requestUrl, requestInit);
    if (isRedirect(response)) {
      const target = redirectTarget(response, requestUrl);
      if (isAuthenticationRedirect(response, target)) {
        throw new Error(`Artifactory refused an authentication redirect on ${operation}.`);
      }
      if (!allowDownloadRedirect) {
        throw new Error(`Artifactory refused an unexpected redirect on ${operation}.`);
      }
      response = await this.followDownloadRedirect(response, requestUrl, requestInit);
    }
    if (!response.ok) {
      throw new ArtifactoryHttpError(response.status, response.statusText, operation);
    }
    return response;
  }

  private async json<T>(operation: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(operation, init);
    if (response.status === 204) return {} as T;
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_JSON_BYTES) throw new Error("Artifactory JSON response exceeds the 5 MiB safety limit.");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error("Artifactory JSON response exceeds the 5 MiB safety limit.");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Artifactory returned invalid JSON on ${operation}.`);
    }
  }

  /** Check service reachability and authentication. */
  async ping(): Promise<string> {
    const response = await this.request("api/system/ping", { headers: { Accept: "text/plain" } });
    return (await response.text()).trim();
  }

  /** Return Artifactory version, revision, and add-on metadata. */
  getVersion(): Promise<ArtifactoryVersion> {
    return this.json("api/system/version");
  }

  /** List repositories visible to the authenticated account. */
  listRepositories(filters: { type?: "local" | "remote" | "virtual"; packageType?: string } = {}): Promise<ArtifactoryRepository[]> {
    return this.json(`api/repositories${queryString(filters)}`);
  }

  /** Read metadata for an artifact, folder, or repository root. */
  getItemInfo(repository: string, itemPath = ""): Promise<ArtifactoryItemInfo> {
    const repo = encodeRepositoryKey(repository);
    const item = encodeArtifactoryPath(itemPath, true);
    return this.json(`api/storage/${repo}${item ? `/${item}` : ""}`);
  }

  /** List a repository folder with bounded depth options. */
  listFolder(repository: string, itemPath = "", options: { deep?: boolean; depth?: number; includeFolders?: boolean } = {}): Promise<ArtifactoryFolderList> {
    const repo = encodeRepositoryKey(repository);
    const item = encodeArtifactoryPath(itemPath, true);
    const params = new URLSearchParams({
      deep: options.deep ? "1" : "0",
      listFolders: options.includeFolders === false ? "0" : "1",
    });
    if (options.depth !== undefined) params.set("depth", String(options.depth));
    return this.json(`api/storage/${repo}${item ? `/${item}` : ""}?list&${params}`);
  }

  /** Read item properties, normalizing Artifactory 6's 404 response for an existing propertyless item. */
  async getItemProperties(repository: string, itemPath: string): Promise<Record<string, unknown>> {
    const operation = `api/storage/${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}?properties`;
    try {
      return await this.json(operation);
    } catch (error) {
      if (error instanceof ArtifactoryHttpError && error.status === 404) {
        // Artifactory 6 returns 404 when an existing item has no properties.
        await this.getItemInfo(repository, itemPath);
        return { properties: {} };
      }
      throw error;
    }
  }

  /** Read item download statistics. */
  getItemStats(repository: string, itemPath: string): Promise<Record<string, unknown>> {
    return this.json(`api/storage/${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}?stats`);
  }

  /** Search artifacts by partial filename. */
  searchArtifacts(name: string, repositories: string[] = []): Promise<Record<string, unknown>> {
    if (!name.trim()) throw new Error("Artifact search name cannot be empty.");
    repositories.forEach(encodeRepositoryKey);
    return this.json(`api/search/artifact${queryString({ name, repos: repositories.length ? repositories.join(",") : undefined })}`);
  }

  /** Run a bounded structured AQL item search. */
  searchItems(search: ArtifactoryItemSearch): Promise<ArtifactorySearchResult> {
    encodeRepositoryKey(search.repository);
    const limit = search.limit ?? 100;
    const offset = search.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("AQL search limit must be between 1 and 500.");
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error("AQL search offset must be between 0 and 100000.");
    const criteria: Record<string, unknown> = { repo: search.repository };
    if (search.pathPattern) criteria.path = { $match: search.pathPattern };
    if (search.namePattern) criteria.name = { $match: search.namePattern };
    if (search.type && search.type !== "any") criteria.type = search.type;
    for (const [key, value] of Object.entries(search.properties ?? {})) {
      if (!ARTIFACTORY_PROPERTY_KEY.test(key)) throw new Error(`Invalid Artifactory property key: ${key}`);
      criteria[`@${key}`] = { $match: value };
    }
    const query = `items.find(${JSON.stringify(criteria)})` +
      `.include("repo","path","name","type","size","created","modified","actual_sha1","actual_md5")` +
      `.offset(${offset}).limit(${limit})`;
    return this.json("api/search/aql", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: query,
    });
  }

  /** List published build-info names. */
  listBuilds(): Promise<Record<string, unknown>> {
    return this.json("api/build");
  }

  /** List published runs for one build-info name. */
  listBuildRuns(buildName: string): Promise<Record<string, unknown>> {
    if (!buildName.trim()) throw new Error("Build name is required.");
    return this.json(`api/build/${encodeURIComponent(buildName)}`);
  }

  /** Read one published build-info run. */
  getBuildInfo(buildName: string, buildNumber: string): Promise<Record<string, unknown>> {
    if (!buildName.trim() || !buildNumber.trim()) throw new Error("Build name and number are required.");
    return this.json(`api/build/${encodeURIComponent(buildName)}/${encodeURIComponent(buildNumber)}`);
  }

  /** Stream an artifact, following only approved direct-storage redirects without credentials. */
  async downloadArtifact(
    repository: string,
    itemPath: string,
    maxBytes: number,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number }> {
    const operation = `${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}`;
    const response = await this.request(operation, {
      headers: { Accept: "application/octet-stream" },
      signal: AbortSignal.timeout(this.downloadTimeoutMs),
    }, true);
    const declaredHeader = response.headers.get("content-length");
    const declaredLength = declaredHeader === null ? undefined : Number(declaredHeader);
    if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      try { await response.body?.cancel(); } catch { /* preserve the transfer-limit error */ }
      throw new Error(`Artifact exceeds the configured transfer limit of ${maxBytes} bytes.`);
    }
    if (!response.body) throw new Error("Artifactory returned an artifact response without a body.");
    return {
      body: response.body,
      contentLength: declaredLength !== undefined && Number.isFinite(declaredLength) ? declaredLength : undefined,
    };
  }

  /** Upload an artifact with caller-computed SHA-1 and SHA-256 verification headers. */
  uploadArtifact(
    repository: string,
    itemPath: string,
    data: Blob,
    checksums: { sha1: string; sha256: string },
  ): Promise<Record<string, unknown>> {
    return this.json(`${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Checksum-Sha1": checksums.sha1,
        "X-Checksum-Sha256": checksums.sha256,
      },
      body: data,
    });
  }

  private copyOrMove(
    operation: "copy" | "move",
    sourceRepository: string,
    sourcePath: string,
    targetRepository: string,
    targetPath: string,
    dryRun: boolean,
  ): Promise<Record<string, unknown>> {
    const source = `${encodeRepositoryKey(sourceRepository)}/${encodeArtifactoryPath(sourcePath)}`;
    const target = `/${encodeRepositoryKey(targetRepository)}/${encodeArtifactoryPath(targetPath)}`;
    return this.json(`api/${operation}/${source}${queryString({ to: target, dry: dryRun ? 1 : 0, suppressLayouts: 1, failFast: 1 })}`, {
      method: "POST",
    });
  }

  /** Dry-run or copy an item to a repository-root-absolute target. */
  copyItem(sourceRepository: string, sourcePath: string, targetRepository: string, targetPath: string, dryRun = true): Promise<Record<string, unknown>> {
    return this.copyOrMove("copy", sourceRepository, sourcePath, targetRepository, targetPath, dryRun);
  }

  /** Dry-run or move an item to a repository-root-absolute target. */
  moveItem(sourceRepository: string, sourcePath: string, targetRepository: string, targetPath: string, dryRun = true): Promise<Record<string, unknown>> {
    return this.copyOrMove("move", sourceRepository, sourcePath, targetRepository, targetPath, dryRun);
  }

  /** Delete one encoded repository item. */
  async deleteItem(repository: string, itemPath: string): Promise<void> {
    await this.request(`${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}`, { method: "DELETE" });
  }

  /** Set validated item properties with optional recursive application. */
  async setItemProperties(repository: string, itemPath: string, properties: Record<string, string[]>, recursive = false): Promise<void> {
    validateArtifactoryProperties(properties);
    const encoded = Object.entries(properties).map(([key, values]) => `${key}=${values.join(",")}`).join("|");
    await this.request(`api/storage/${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}${queryString({ properties: encoded, recursive: recursive ? 1 : 0 })}`, {
      method: "PUT",
    });
  }

  /** Delete validated property keys with optional recursive application. */
  async deleteItemProperties(repository: string, itemPath: string, propertyKeys: string[], recursive = false): Promise<void> {
    if (!propertyKeys.length || propertyKeys.some((key) => !ARTIFACTORY_PROPERTY_KEY.test(key))) {
      throw new Error("Artifactory property keys must be non-empty and contain only supported characters.");
    }
    await this.request(`api/storage/${encodeRepositoryKey(repository)}/${encodeArtifactoryPath(itemPath)}${queryString({ properties: propertyKeys.join(","), recursive: recursive ? 1 : 0 })}`, {
      method: "DELETE",
    });
  }
}
