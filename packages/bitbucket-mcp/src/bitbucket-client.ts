import type { AuthenticatedFetch } from "@nrs/auth";
import type {
  BitbucketRepo,
  BitbucketBrowseResponse,
  BitbucketBranch,
  BitbucketPullRequest,
  BitbucketPRActivity,
  BitbucketPRComment,
  BitbucketCommit,
  BitbucketMergeStatus,
  BitbucketTag,
  BitbucketBuildStatus,
  BitbucketBlameResponse,
  PagedResponse,
  CodeSearchResponse,
} from "./types.js";

/** Thrown when the Code Search plugin is not installed (404). */
export class CodeSearchNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeSearchNotAvailableError";
  }
}

const DEFAULT_BASE_URL =
  process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/stash`
    : "https://apps.example.gov.bc.ca/int/stash";

/**
 * REST client for Bitbucket Data Center.
 * Uses /rest/api/1.0/ endpoints.
 */
export class BitbucketClient {
  private baseUrl: string;
  private fetch: AuthenticatedFetch;

  constructor(fetch: AuthenticatedFetch, baseUrl?: string) {
    this.fetch = fetch;
    this.baseUrl =
      baseUrl ?? process.env["BITBUCKET_URL"] ?? DEFAULT_BASE_URL;
  }

  private apiUrl(path: string): string {
    return `${this.baseUrl}/rest/api/1.0${path}`;
  }

  /**
   * List repositories in a project.
   */
  async listRepos(
    projectKey: string,
    limit: number = 25
  ): Promise<PagedResponse<BitbucketRepo>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const resp = await this.fetch(
      this.apiUrl(`/projects/${encodeURIComponent(projectKey)}/repos?${params}`)
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list repos for ${projectKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketRepo>;
  }

  /**
   * Browse files/directories in a repository.
   */
  async browseFiles(
    projectKey: string,
    repoSlug: string,
    path: string = "",
    at?: string
  ): Promise<BitbucketBrowseResponse> {
    const params = new URLSearchParams();
    if (at) params.set("at", at);

    const encodedPath = path
      ? `/${path.split("/").map(encodeURIComponent).join("/")}`
      : "";

    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/browse${encodedPath}?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to browse ${projectKey}/${repoSlug}/${path} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketBrowseResponse;
  }

  /**
   * List all files in a repository recursively (flat list).
   * Uses the /files endpoint and follows the paged response until
   * `isLastPage`, so repos with more than `limit` files don't silently
   * truncate. `maxFiles` caps the total returned to keep large monorepo
   * scans from running unbounded; default 50000 covers our biggest repos
   * with headroom.
   */
  async listFiles(
    projectKey: string,
    repoSlug: string,
    limit: number = 5000,
    maxFiles: number = 50_000
  ): Promise<string[]> {
    const all: string[] = [];
    let start = 0;
    while (all.length < maxFiles) {
      const params = new URLSearchParams({ limit: String(limit), start: String(start) });
      const resp = await this.fetch(
        this.apiUrl(
          `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/files?${params}`
        )
      );
      if (!resp.ok) {
        throw new Error(
          `Failed to list files for ${projectKey}/${repoSlug} (${resp.status}): ${await resp.text()}`
        );
      }
      const data = (await resp.json()) as PagedResponse<string>;
      all.push(...data.values);
      if (data.isLastPage) break;
      // Bitbucket DC may return nextPageStart; fall back to start+size.
      start = data.nextPageStart ?? (start + data.values.length);
      if (data.values.length === 0) break; // safety against infinite loop
    }
    return all.slice(0, maxFiles);
  }

  /**
   * Read raw file content.
   */
  async readFile(
    projectKey: string,
    repoSlug: string,
    filePath: string,
    at?: string
  ): Promise<string> {
    const params = new URLSearchParams();
    if (at) params.set("at", at);

    const encodedPath = filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/raw/${encodedPath}?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to read ${projectKey}/${repoSlug}/${filePath} (${resp.status}): ${await resp.text()}`
      );
    }
    return resp.text();
  }

  /**
   * List branches in a repository.
   */
  async listBranches(
    projectKey: string,
    repoSlug: string,
    limit: number = 25
  ): Promise<PagedResponse<BitbucketBranch>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/branches?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list branches (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketBranch>;
  }

  /**
   * List pull requests for a repository.
   */
  async listPullRequests(
    projectKey: string,
    repoSlug: string,
    state: string = "OPEN",
    limit: number = 25
  ): Promise<PagedResponse<BitbucketPullRequest>> {
    const params = new URLSearchParams({
      state,
      limit: String(limit),
    });
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list PRs (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketPullRequest>;
  }

  /**
   * Get pull request details.
   */
  async getPullRequest(
    projectKey: string,
    repoSlug: string,
    prId: number
  ): Promise<BitbucketPullRequest> {
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketPullRequest;
  }

  /**
   * Search code across repositories using the Bitbucket DC 8.x Code Search API.
   *
   * Uses POST /rest/search/latest/search with a JSON body.
   * Scoping is done via query modifiers: project:KEY, repo:KEY/slug, ext:java.
   *
   * @param query - Search query (supports Elasticsearch syntax + modifiers)
   * @param projectKey - Optional project key to scope the search
   * @param repoSlug - Optional repo slug to scope the search (requires projectKey)
   * @param limit - Maximum results (default 25)
   */
  async searchCode(
    query: string,
    projectKey?: string,
    repoSlug?: string,
    limit: number = 25
  ): Promise<CodeSearchResponse> {
    // Build scoped query using Bitbucket query modifiers
    let scopedQuery = query;
    if (projectKey && repoSlug) {
      scopedQuery = `repo:${projectKey}/${repoSlug} ${query}`;
    } else if (projectKey) {
      scopedQuery = `project:${projectKey} ${query}`;
    }

    const resp = await this.fetch(
      `${this.baseUrl}/rest/search/latest/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: scopedQuery,
          entities: { code: { limit } },
        }),
      }
    );

    if (resp.status === 405 || resp.status === 404) {
      throw new CodeSearchNotAvailableError(
        "Code Search is not available on this Bitbucket server. " +
          "Use clone_repo to clone the repository locally, then use local grep/search tools instead."
      );
    }
    if (!resp.ok) {
      const body = await resp.text();
      // Parse Bitbucket error messages (JSON: { errors: [{ message }] })
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        if (parsed.errors?.[0]?.message) {
          detail = parsed.errors[0].message;
        }
      } catch {
        // use raw body
      }
      throw new Error(`Code search failed (${resp.status}): ${detail}`);
    }
    return (await resp.json()) as CodeSearchResponse;
  }

  /**
   * Create a pull request.
   */
  async createPullRequest(
    projectKey: string,
    repoSlug: string,
    params: {
      title: string;
      description?: string;
      fromBranch: string;
      toBranch?: string;
      reviewers?: string[];
    }
  ): Promise<BitbucketPullRequest> {
    const body = {
      title: params.title,
      description: params.description ?? "",
      fromRef: {
        id: `refs/heads/${params.fromBranch}`,
        repository: {
          slug: repoSlug,
          project: { key: projectKey },
        },
      },
      toRef: {
        id: `refs/heads/${params.toBranch ?? "main"}`,
        repository: {
          slug: repoSlug,
          project: { key: projectKey },
        },
      },
      reviewers: (params.reviewers ?? []).map((name) => ({ user: { name } })),
    };

    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests`
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to create PR (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketPullRequest;
  }

  /**
   * Create a branch from a starting point.
   */
  async createBranch(
    projectKey: string,
    repoSlug: string,
    branchName: string,
    startPoint: string = "main"
  ): Promise<BitbucketBranch> {
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/branches`
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: branchName,
          startPoint,
        }),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to create branch '${branchName}' (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketBranch;
  }

  /**
   * Get the HTTP clone URL for a repository (for git clone).
   */
  getCloneUrl(projectKey: string, repoSlug: string): string {
    return `${this.baseUrl}/scm/${projectKey.toLowerCase()}/${repoSlug}.git`;
  }

  // ---------------------------------------------------------------------------
  // Pull request review operations
  // ---------------------------------------------------------------------------

  /**
   * Get the unified diff text for a pull request.
   */
  async getPullRequestDiff(
    projectKey: string,
    repoSlug: string,
    prId: number,
    contextLines: number = 10
  ): Promise<string> {
    const params = new URLSearchParams({ contextLines: String(contextLines) });
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/diff?${params}`
      ),
      { headers: { Accept: "text/plain" } }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get diff for PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return resp.text();
  }

  /**
   * Get the activity stream for a PR (comments, approvals, status changes).
   * Walks pages so callers don't silently lose older activity.
   */
  async getPullRequestActivities(
    projectKey: string,
    repoSlug: string,
    prId: number,
    maxEntries: number = 200
  ): Promise<BitbucketPRActivity[]> {
    const all: BitbucketPRActivity[] = [];
    let start = 0;
    while (all.length < maxEntries) {
      const params = new URLSearchParams({
        limit: String(Math.min(100, maxEntries - all.length)),
        start: String(start),
      });
      const resp = await this.fetch(
        this.apiUrl(
          `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/activities?${params}`
        )
      );
      if (!resp.ok) {
        throw new Error(
          `Failed to get activities for PR ${prId} (${resp.status}): ${await resp.text()}`
        );
      }
      const page = (await resp.json()) as PagedResponse<BitbucketPRActivity>;
      all.push(...page.values);
      if (page.isLastPage || page.values.length === 0) break;
      start = page.nextPageStart ?? start + page.values.length;
    }
    return all.slice(0, maxEntries);
  }

  /**
   * Add a comment to a pull request. If `anchor` is provided, the comment is
   * an inline comment on a specific file/line; otherwise it's a general
   * (top-level) PR comment.
   */
  async addPullRequestComment(
    projectKey: string,
    repoSlug: string,
    prId: number,
    text: string,
    anchor?: {
      path: string;
      line?: number;
      lineType?: "ADDED" | "REMOVED" | "CONTEXT";
      fileType?: "FROM" | "TO";
    }
  ): Promise<BitbucketPRComment> {
    const body: Record<string, unknown> = { text };
    if (anchor) body.anchor = anchor;
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/comments`
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to comment on PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketPRComment;
  }

  /**
   * List commits in a pull request.
   */
  async getPullRequestCommits(
    projectKey: string,
    repoSlug: string,
    prId: number,
    limit: number = 100
  ): Promise<PagedResponse<BitbucketCommit>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/commits?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list commits for PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketCommit>;
  }

  /**
   * Set review status on a pull request as the current user.
   * Bitbucket DC accepts: APPROVED, NEEDS_WORK, UNAPPROVED.
   */
  async setPullRequestStatus(
    projectKey: string,
    repoSlug: string,
    prId: number,
    status: "APPROVED" | "NEEDS_WORK" | "UNAPPROVED"
  ): Promise<void> {
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/participants/me`
      ),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to set PR ${prId} status to ${status} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  /**
   * Check whether a PR can be merged.
   */
  async canMergePullRequest(
    projectKey: string,
    repoSlug: string,
    prId: number
  ): Promise<BitbucketMergeStatus> {
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/merge`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to check merge status for PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketMergeStatus;
  }

  /**
   * Merge a pull request. The PR's optimistic-locking version must match.
   */
  async mergePullRequest(
    projectKey: string,
    repoSlug: string,
    prId: number,
    version: number
  ): Promise<BitbucketPullRequest> {
    const params = new URLSearchParams({ version: String(version) });
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/merge?${params}`
      ),
      { method: "POST" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to merge PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketPullRequest;
  }

  /**
   * Decline a pull request. The PR's optimistic-locking version must match.
   */
  async declinePullRequest(
    projectKey: string,
    repoSlug: string,
    prId: number,
    version: number
  ): Promise<BitbucketPullRequest> {
    const params = new URLSearchParams({ version: String(version) });
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${prId}/decline?${params}`
      ),
      { method: "POST" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to decline PR ${prId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketPullRequest;
  }

  // ---------------------------------------------------------------------------
  // Commits / history / blame
  // ---------------------------------------------------------------------------

  /**
   * List commits in a repository, optionally filtered by branch range or path.
   * `until` is the ref/SHA to log from (HEAD by default), `since` is exclusive.
   * `path` filters to commits that touched a specific file.
   */
  async listCommits(
    projectKey: string,
    repoSlug: string,
    options?: {
      until?: string;
      since?: string;
      path?: string;
      limit?: number;
      start?: number;
      merges?: "include" | "exclude" | "only";
    }
  ): Promise<PagedResponse<BitbucketCommit>> {
    const params = new URLSearchParams({
      limit: String(options?.limit ?? 25),
      start: String(options?.start ?? 0),
    });
    if (options?.until) params.set("until", options.until);
    if (options?.since) params.set("since", options.since);
    if (options?.path) params.set("path", options.path);
    if (options?.merges) params.set("merges", options.merges);
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/commits?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list commits for ${projectKey}/${repoSlug} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketCommit>;
  }

  /**
   * Get a single commit by ID.
   */
  async getCommit(
    projectKey: string,
    repoSlug: string,
    commitId: string
  ): Promise<BitbucketCommit> {
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/commits/${encodeURIComponent(commitId)}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch commit ${commitId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketCommit;
  }

  /**
   * Blame a file — returns line-by-line attribution at the given ref.
   * Pages through results so long files don't truncate.
   *
   * The `startLine` option (1-based) is plumbed into the Bitbucket browse
   * pagination, so blaming a slice deep in a huge file fetches just that
   * slice rather than walking the whole file. The returned response's
   * `start` field reflects the 0-based offset of the first returned line.
   */
  async blameFile(
    projectKey: string,
    repoSlug: string,
    filePath: string,
    options?: { at?: string; maxLines?: number; startLine?: number }
  ): Promise<BitbucketBlameResponse> {
    const maxLines = options?.maxLines ?? 5000;
    // startLine is 1-based on the API side too (the response uses
    // `lineNumber` 1-based). Bitbucket's `start` query param is 0-based, so
    // subtract 1. Clamp to 0 to avoid negative offsets.
    const initialStart = Math.max(0, (options?.startLine ?? 1) - 1);
    const lines: Array<{ text: string }> = [];
    const blame: BitbucketBlameResponse["blame"] = [];
    let start = initialStart;
    let isLast = false;
    const encodedPath = filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    // Track the last page's nextPageStart so callers can resume cleanly
    // when we cut off at maxLines rather than the natural EOF.
    let nextPageStart: number | undefined;
    while (!isLast && lines.length < maxLines) {
      const params = new URLSearchParams({
        // "blame=true" rather than just "blame=". Some Bitbucket DC
        // versions parse the empty-value form as the flag being absent and
        // silently return content without blame annotations.
        blame: "true",
        start: String(start),
        limit: String(Math.min(500, maxLines - lines.length)),
      });
      if (options?.at) params.set("at", options.at);
      const resp = await this.fetch(
        this.apiUrl(
          `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/browse/${encodedPath}?${params}`
        )
      );
      if (!resp.ok) {
        throw new Error(
          `Failed to blame ${filePath} (${resp.status}): ${await resp.text()}`
        );
      }
      const page = (await resp.json()) as BitbucketBlameResponse;
      lines.push(...(page.lines ?? []));
      blame.push(...(page.blame ?? []));
      isLast = page.isLastPage ?? true;
      nextPageStart = page.nextPageStart;
      if (!isLast) start = page.nextPageStart ?? start + (page.lines?.length ?? 0);
      if ((page.lines?.length ?? 0) === 0) break;
    }

    return {
      lines,
      blame,
      // Surface what the caller actually fetched: their requested offset.
      start: initialStart,
      size: lines.length,
      isLastPage: isLast,
      // Preserve the server's resumption cursor when we cut off short.
      // When isLast=true this is undefined (no more pages), which is correct.
      ...(nextPageStart !== undefined && !isLast ? { nextPageStart } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  /**
   * List tags in a repository.
   */
  async listTags(
    projectKey: string,
    repoSlug: string,
    options?: { filterText?: string; limit?: number; start?: number; orderBy?: "ALPHABETICAL" | "MODIFICATION" }
  ): Promise<PagedResponse<BitbucketTag>> {
    const params = new URLSearchParams({
      limit: String(options?.limit ?? 25),
      start: String(options?.start ?? 0),
    });
    if (options?.filterText) params.set("filterText", options.filterText);
    if (options?.orderBy) params.set("orderBy", options.orderBy);
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/tags?${params}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list tags (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketTag>;
  }

  /**
   * Get a single tag by name.
   */
  async getTag(
    projectKey: string,
    repoSlug: string,
    tagName: string
  ): Promise<BitbucketTag> {
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/tags/${encodeURIComponent(tagName)}`
      )
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch tag '${tagName}' (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketTag;
  }

  /**
   * Create a tag (lightweight or annotated). Pass `message` to make it annotated.
   */
  async createTag(
    projectKey: string,
    repoSlug: string,
    name: string,
    startPoint: string,
    message?: string
  ): Promise<BitbucketTag> {
    const body: Record<string, unknown> = {
      name,
      startPoint,
      // The DC API's git/tags endpoint accepts a "type" hint but the simpler
      // /tags endpoint just uses presence of message to mean annotated.
    };
    // Use undefined check rather than truthiness — `""` is a valid (if
    // unusual) annotated-tag message and should still trigger annotated mode.
    if (message !== undefined) body.message = message;
    const resp = await this.fetch(
      this.apiUrl(
        `/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/tags`
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to create tag '${name}' (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as BitbucketTag;
  }

  // ---------------------------------------------------------------------------
  // Build status (CI integration)
  // ---------------------------------------------------------------------------

  /**
   * Get build statuses attached to a commit. Uses the build-status endpoint
   * which lives outside /rest/api/1.0/. Paged endpoint — `start` allows
   * walking beyond the first page when a commit accumulates many statuses.
   */
  async getBuildStatus(
    commitId: string,
    limit: number = 25,
    start: number = 0
  ): Promise<PagedResponse<BitbucketBuildStatus>> {
    const params = new URLSearchParams({
      limit: String(limit),
      start: String(start),
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/build-status/1.0/commits/${encodeURIComponent(commitId)}?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch build status for ${commitId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as PagedResponse<BitbucketBuildStatus>;
  }
}
