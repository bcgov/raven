import type {
  AdoWiqlResult,
  AdoWorkItem,
  AdoWorkItemCommentsPage,
  AdoRepository,
  AdoRepositoryList,
  AdoGitRefList,
  AdoGitItemList,
  AdoPullRequest,
  AdoPullRequestList,
  AdoPipelineList,
  AdoPatchOperation,
  AdoProjectList,
  AdoCollectionList,
} from "./types.js";

/**
 * REST client for Azure DevOps Server (on-premises).
 *
 * Auth: PAT (Personal Access Token) via HTTP Basic auth with an empty username.
 * Base URL format: https://{server}/{collection}
 *   e.g. https://ado.example.com/DefaultCollection
 *
 * All requests target api-version 7.1 (supported by ADO Server 2020+).
 * Earlier versions (2019) can use 5.1 — override with ADO_API_VERSION env var.
 */
export class AdoClient {
  private baseUrl: string;
  private apiVersion: string;
  private authHeader: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(baseUrl: string, pat: string, apiVersion = "7.1", fetchFn?: typeof globalThis.fetch) {
    // Strip trailing slashes (string-based to avoid ReDoS-vulnerable regex)
    let url = baseUrl;
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    this.apiVersion = apiVersion;
    // PAT auth: empty username, PAT as password
    this.authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async request<T>(
    path: string,
    options?: RequestInit & { params?: Record<string, string> }
  ): Promise<T> {
    const { params, ...fetchOpts } = options ?? {};
    const query = params ? `?${new URLSearchParams({ ...params, "api-version": this.apiVersion })}` : `?api-version=${this.apiVersion}`;
    const url = `${this.baseUrl}/${path.replace(/^\//, "")}${query}`;

    const resp = await this.fetchFn(url, {
      ...fetchOpts,
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
    // Some endpoints return 204 No Content
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }

  // ---------------------------------------------------------------------------
  // Work Items
  // ---------------------------------------------------------------------------

  /** Build the URL path prefix for a project, optionally scoped to a collection. */
  private projectPrefix(project: string, collection?: string): string {
    return collection
      ? `${encodeURIComponent(collection)}/${encodeURIComponent(project)}`
      : encodeURIComponent(project);
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

  /**
   * Create a new work item.
   * @param type  Work item type name, e.g. "Bug", "Task", "User Story"
   * @param ops   JSON Patch operations to set fields
   */
  async createWorkItem(type: string, project: string, ops: AdoPatchOperation[], collection?: string): Promise<AdoWorkItem> {
    return this.request<AdoWorkItem>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${encodeURIComponent("$" + type)}`,
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
    return this.request<AdoWorkItemCommentsPage>(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}/comments`
    );
  }

  /** Add a comment to a work item. */
  async addWorkItemComment(id: number, project: string, text: string, collection?: string): Promise<void> {
    await this.request(
      `${this.projectPrefix(project, collection)}/_apis/wit/workitems/${id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
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
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}`
    );
  }

  // ---------------------------------------------------------------------------
  // Branches
  // ---------------------------------------------------------------------------

  /** List branches (refs) in a repository. */
  async listBranches(project: string, repoNameOrId: string, filter?: string, collection?: string): Promise<AdoGitRefList> {
    const params: Record<string, string> = { filterContains: filter ?? "" };
    return this.request<AdoGitRefList>(
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}/refs`,
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
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}/items`,
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
    const prefix = collection
      ? `${encodeURIComponent(collection)}/${encodeURIComponent(project)}`
      : encodeURIComponent(project);
    const url =
      `${this.baseUrl}/${prefix}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}/items` +
      `?path=${encodeURIComponent(path)}&versionDescriptor=${encodeURIComponent(branch)}&versionType=branch&api-version=${this.apiVersion}`;

    const resp = await this.fetchFn(url, {
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
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}/pullrequests`,
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
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}/pullrequests/${prId}`
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
      `${this.projectPrefix(project, collection)}/_apis/git/repositories/${encodeURIComponent(repoNameOrId)}/pullrequests`,
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
    return this.request<AdoPipelineList>(
      `${this.projectPrefix(project, collection)}/_apis/pipelines`
    );
  }

  /** List all project collections on this ADO Server instance. */
  async listCollections(): Promise<AdoCollectionList> {
    return this.request<AdoCollectionList>(`_apis/projectCollections`);
  }

  /** List team projects in a named collection. */
  async listProjects(collection: string, top = 200): Promise<AdoProjectList> {
    // Build URL manually to avoid URLSearchParams encoding '$top' as '%24top'
    const url = `${this.baseUrl}/${encodeURIComponent(collection)}/_apis/projects?$top=${top}&api-version=${this.apiVersion}`;
    const resp = await this.fetchFn(url, {
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`ADO API error ${resp.status} ${resp.statusText}: ${body.slice(0, 500)}`);
    }
    return resp.json() as Promise<AdoProjectList>;
  }
}
