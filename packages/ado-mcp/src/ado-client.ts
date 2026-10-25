import type {
  AdoWiqlResult,
  AdoWorkItem,
  AdoWorkItemCommentsPage,
  AdoWorkItemUpdatesPage,
  AdoRepository,
  AdoRepositoryList,
  AdoGitRefList,
  AdoGitItemList,
  AdoPullRequest,
  AdoPullRequestList,
  AdoPipeline,
  AdoPipelineList,
  AdoBuildPipeline,
  AdoBuildPipelineList,
  AdoReleasePipeline,
  AdoReleasePipelineList,
  AdoPatchOperation,
  AdoProject,
  AdoProjectList,
  AdoCollectionList,
} from "./types.js";

/**
 * REST client for Azure DevOps Services and Server (on-premises).
 *
 * Auth: PAT (Personal Access Token) via HTTP Basic auth with an empty username.
 * Base URL: https://dev.azure.com for Services, or https://{server} for Server.
 * The collection argument is the organization name for Services.
 *
 * Requests default to api-version 7.1 (Services and Server 2022+).
 * Set ADO_API_VERSION=6.0 for Server 2020 or 5.0 for Server 2019.
 */
function pathSegment(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A literal percent sign is a valid name character; encodeURIComponent escapes it.
  }
  if (decoded === "." || decoded === "..") {
    throw new Error("ADO path segment must not be a dot segment.");
  }
  return encodeURIComponent(value);
}

export class AdoClient {
  readonly isCloud: boolean;
  private baseUrl: string;
  private apiVersion: string;
  private authHeader: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(baseUrl: string, pat: string, apiVersion = "7.1", fetchFn?: typeof globalThis.fetch) {
    // Strip trailing slashes (string-based to avoid ReDoS-vulnerable regex)
    let url = baseUrl;
    while (url.endsWith("/")) url = url.slice(0, -1);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("ADO_BASE_URL must use HTTPS.");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("ADO_BASE_URL must not contain credentials, a query, or a fragment.");
    }
    const pathStart = url.indexOf("/", url.indexOf("://") + 3);
    if (parsed.hostname === "dev.azure.com" && pathStart !== -1) {
      throw new Error("For Cloud, set ADO_BASE_URL=https://dev.azure.com and the organization in ADO_DEFAULT_COLLECTION.");
    }
    this.baseUrl = url;
    this.isCloud = parsed.hostname === "dev.azure.com";
    this.apiVersion = apiVersion;
    // PAT auth: empty username, PAT as password
    this.authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async requestPage<T>(
    path: string,
    options?: RequestInit & { params?: Record<string, string> }
  ): Promise<{ data: T; continuationToken?: string }> {
    const { params, ...fetchOpts } = options ?? {};
    const separator = path.includes("?") ? "&" : "?";
    const query = params
      ? `${separator}${new URLSearchParams({ ...params, "api-version": params["api-version"] ?? this.apiVersion })}`
      : `${separator}api-version=${this.apiVersion}`;
    const url = `${this.baseUrl}/${path.replace(/^\//, "")}${query}`;

    const resp = await this.fetchFn(url, {
      ...fetchOpts,
      redirect: "error",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...fetchOpts.headers,
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`ADO API error ${resp.status} ${resp.statusText}: ${body.slice(0, 500)}`);
    }
    const continuationToken = resp.headers?.get("x-ms-continuationtoken") || undefined;
    // Some endpoints return 204 No Content
    if (resp.status === 204) return { data: {} as T, continuationToken };
    return { data: (await resp.json()) as T, continuationToken };
  }

  private async request<T>(
    path: string,
    options?: RequestInit & { params?: Record<string, string> }
  ): Promise<T> {
    return (await this.requestPage<T>(path, options)).data;
  }

  private async listAllPages<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();

    do {
      if (seenTokens.size >= 1000) throw new Error("ADO API exceeded the pagination limit (1000 pages).");
      const page = await this.requestPage<{ value?: T[] }>(
        path,
        continuationToken ? { params: { continuationToken } } : undefined
      );
      values.push(...(page.data.value ?? []));
      if (page.continuationToken && seenTokens.has(page.continuationToken)) {
        throw new Error("ADO API returned a repeated continuation token.");
      }
      continuationToken = page.continuationToken;
      if (continuationToken) seenTokens.add(continuationToken);
    } while (continuationToken);

    return values;
  }

  // ---------------------------------------------------------------------------
  // Work Items
  // ---------------------------------------------------------------------------

  /** Build the URL path prefix for a project, optionally scoped to a collection. */
  private projectPrefix(project: string, collection?: string): string {
    return collection
      ? `${pathSegment(collection)}/${pathSegment(project)}`
      : pathSegment(project);
  }

  /**
   * Run a WIQL query and return matching work item refs.
   * @param wiql  Full WIQL string, e.g. "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed'"
   * @param project  Project name or ID (used as context for @project macro).
   * @param collection  Optional collection name (required on multi-collection ADO Server instances).
   */
  async queryWiql(wiql: string, project: string, top = 50, collection?: string): Promise<AdoWiqlResult> {
    return this.request<AdoWiqlResult>(
      `${this.projectPrefix(project, collection)}/_apis/wit/wiql`,
      {
        method: "POST",
        body: JSON.stringify({ query: wiql }),
        params: { "$top": String(top) },
      }
    );
  }

  /**
   * Fetch full work item details for one or more IDs.
   * Returns them as a flat array (ADO batches up to 200 IDs).
   */
  async getWorkItems(ids: number[], project: string, collection?: string): Promise<AdoWorkItem[]> {
    if (ids.length === 0) return [];
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));

    const results: AdoWorkItem[] = [];
    for (const chunk of chunks) {
      const data = await this.request<{ value: AdoWorkItem[] }>(
        `${this.projectPrefix(project, collection)}/_apis/wit/workitems`,
        {
          params: {
            ids: chunk.join(","),
            "$expand": "all",
          },
        }
      );
      results.push(...(data.value ?? []));
    }
    return results;
  }

  /** Get a single work item by ID. */
  async getWorkItem(id: number, project: string, collection?: string): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}`,
      { params: { "$expand": "all" } }
    );
  }

  /** Get a page of work item field and relationship changes, in revision order. */
  async getWorkItemUpdates(
    id: number, project: string, top: number, skip: number, collection?: string
  ): Promise<AdoWorkItemUpdatesPage> {
    return this.request<AdoWorkItemUpdatesPage>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}/updates`,
      { params: { "$top": String(top), "$skip": String(skip) } }
    );
  }

  /**
   * Create a new work item.
   * @param type  Work item type name, e.g. "Bug", "Task", "User Story"
   * @param ops   JSON Patch operations to set fields
   */
  async createWorkItem(type: string, project: string, ops: AdoPatchOperation[], collection?: string): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${pathSegment("$" + type)}`,
      {
        method: "POST",
        body: JSON.stringify(ops),
        headers: { "Content-Type": "application/json-patch+json" },
      }
    );
  }

  /**
   * Update an existing work item.
   * @param ops  JSON Patch operations (op: "add" or "replace")
   */
  async updateWorkItem(id: number, project: string, ops: AdoPatchOperation[], collection?: string): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(ops),
        headers: { "Content-Type": "application/json-patch+json" },
      }
    );
  }

  /** Get comments on a work item. */
  async getWorkItemComments(id: number, project: string, collection?: string): Promise<AdoWorkItemCommentsPage> {
    if (!["6.0", "7.0", "7.1"].includes(this.apiVersion)) {
      throw new Error(`Work item comments are not supported by this client with ADO_API_VERSION=${this.apiVersion}.`);
    }
    return this.request<AdoWorkItemCommentsPage>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}/comments`,
      { params: { "api-version": this.apiVersion === "7.1" ? "7.1-preview.4" : `${this.apiVersion}-preview.3` } }
    );
  }

  /** Add a comment to a work item. */
  async addWorkItemComment(id: number, project: string, text: string, collection?: string): Promise<void> {
    if (!["6.0", "7.0", "7.1"].includes(this.apiVersion)) {
      throw new Error(`Adding work item comments is not supported by this client with ADO_API_VERSION=${this.apiVersion}.`);
    }
    await this.request(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
        params: { "api-version": this.apiVersion === "7.1" ? "7.0-preview.3" : `${this.apiVersion}-preview.3` },
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------

  /** List all Git repositories in a project. */
  async listRepositories(project: string, collection?: string): Promise<AdoRepositoryList> {
    return this.request<AdoRepositoryList>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories`
    );
  }

  /** Get a single repository by name or ID. */
  async getRepository(project: string, repoNameOrId: string, collection?: string): Promise<AdoRepository> {
    return this.request<AdoRepository>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${pathSegment(repoNameOrId)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  /** List branches (refs) in a repository. */
  async listBranches(project: string, repoNameOrId: string, filter?: string, collection?: string): Promise<AdoGitRefList> {
    const params: Record<string, string> = { filterContains: filter ?? "" };
    return this.request<AdoGitRefList>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${pathSegment(repoNameOrId)}/refs`,
      { params }
    );
  }

  // ---------------------------------------------------------------------------
  // Files / Tree
  // ---------------------------------------------------------------------------

  /**
   * Browse the repository tree at a given path.
   * Returns immediate children (one level).
   */
  async browseFiles(
    project: string,
    repoNameOrId: string,
    path: string = "/",
    branch: string = "main",
    collection?: string
  ): Promise<AdoGitItemList> {
    return this.request<AdoGitItemList>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${pathSegment(repoNameOrId)}/items`,
      {
        params: {
          scopePath: path,
          recursionLevel: "OneLevel",
          versionDescriptor: branch,
          versionType: "branch",
          includeContentMetadata: "true",
        },
      }
    );
  }

  /**
   * Read file contents from a repository.
   * Returns raw text content.
   */
  async readFile(
    project: string,
    repoNameOrId: string,
    path: string,
    branch: string = "main",
    collection?: string
  ): Promise<string> {
    const prefix = this.projectPrefix(project, collection);
    const url =
      `${this.baseUrl}/${prefix}/_apis/git/repositories/${pathSegment(repoNameOrId)}/items` +
      `?path=${encodeURIComponent(path)}&versionDescriptor=${encodeURIComponent(branch)}&versionType=branch&api-version=${this.apiVersion}`;

    const resp = await this.fetchFn(url, {
      redirect: "error",
      headers: {
        Authorization: this.authHeader,
        Accept: "text/plain",
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`ADO file read error ${resp.status}: ${body.slice(0, 500)}`);
    }
    return resp.text();
  }

  // ---------------------------------------------------------------------------
  // Pull Requests
  // ---------------------------------------------------------------------------

  /** List pull requests in a repository. */
  async listPullRequests(
    project: string,
    repoNameOrId: string,
    status: "active" | "completed" | "abandoned" | "all" = "active",
    top = 25,
    collection?: string
  ): Promise<AdoPullRequestList> {
    return this.request<AdoPullRequestList>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${pathSegment(repoNameOrId)}/pullrequests`,
      {
        params: {
          "searchCriteria.status": status,
          "$top": String(top),
        },
      }
    );
  }

  /** Get a single pull request by ID. */
  async getPullRequest(project: string, repoNameOrId: string, prId: number, collection?: string): Promise<AdoPullRequest> {
    return this.request<AdoPullRequest>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${pathSegment(repoNameOrId)}/pullrequests/${prId}`
    );
  }

  /** Create a pull request. */
  async createPullRequest(
    project: string,
    repoNameOrId: string,
    payload: {
      title: string;
      description?: string;
      sourceRefName: string; // e.g. "refs/heads/feature/my-branch"
      targetRefName: string; // e.g. "refs/heads/main"
      reviewers?: Array<{ id: string }>;
      isDraft?: boolean;
    },
    collection?: string
  ): Promise<AdoPullRequest> {
    return this.request<AdoPullRequest>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${pathSegment(repoNameOrId)}/pullrequests`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Pipelines
  // ---------------------------------------------------------------------------

  /** List pipelines (build definitions) in a project. */
  async listPipelines(project: string, collection?: string): Promise<AdoPipelineList> {
    const value = await this.listAllPages<AdoPipeline>(
      `${this.projectPrefix(project, collection)}/_apis/pipelines`
    );
    return { value, count: value.length };
  }

  /** List build service definitions, including classic build pipelines. */
  async listBuildPipelines(project: string, collection?: string): Promise<AdoBuildPipelineList> {
    const value = await this.listAllPages<AdoBuildPipeline>(
      `${this.projectPrefix(project, collection)}/_apis/build/definitions`
    );
    return { value, count: value.length };
  }

  /** List classic release pipeline definitions in a project. */
  async listReleasePipelines(project: string, collection?: string): Promise<AdoReleasePipelineList> {
    const value = await this.listAllPages<AdoReleasePipeline>(
      `${this.projectPrefix(project, collection)}/_apis/release/definitions`
    );
    return { value, count: value.length };
  }

  /** List all project collections on this ADO Server instance. */
  async listCollections(): Promise<AdoCollectionList> {
    return this.request<AdoCollectionList>(`_apis/projectCollections`);
  }

  /** List team projects in a collection (or Cloud organization). */
  async listProjects(collection: string, top = 200): Promise<AdoProjectList> {
    const value = await this.listAllPages<AdoProject>(
      `${pathSegment(collection)}/_apis/projects?$top=${top}`
    );
    return { value, count: value.length };
  }
}
