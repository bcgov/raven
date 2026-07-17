import type { AuthenticatedFetch } from "@nrs/auth";
import type {
  JiraSearchResponse,
  JiraIssue,
  JiraComment,
  JiraSprint,
  JiraBoard,
  JiraCreateIssueResponse,
  JiraTransition,
  JiraIssueLinkType,
  JiraWorklog,
  JiraWorklogsResponse,
  JiraAttachment,
  JiraUser,
  JiraVersion,
  JiraWatchersResponse,
} from "./types.js";
import type { JiraFieldMeta } from "./field-meta.js";

const DEFAULT_BASE_URL =
  process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/jira`
    : "https://apps.example.gov.bc.ca/int/jira";

/**
 * REST client for Jira Data Center.
 * Uses /rest/api/2/ for core resources and /rest/agile/1.0/ for sprints/boards.
 */
export class JiraClient {
  private baseUrl: string;
  private fetch: AuthenticatedFetch;

  constructor(fetch: AuthenticatedFetch, baseUrl?: string) {
    this.fetch = fetch;
    this.baseUrl = baseUrl ?? process.env["JIRA_URL"] ?? DEFAULT_BASE_URL;
  }

  /**
   * Search issues via JQL.
   */
  async searchIssues(
    jql: string,
    maxResults: number = 20,
    startAt: number = 0
  ): Promise<JiraSearchResponse> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      startAt: String(startAt),
      fields:
        "summary,description,status,assignee,reporter,priority,issuetype,created,updated,labels,components,fixVersions,parent",
      expand: "renderedFields",
    });

    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/search?${params}`
    );
    if (!resp.ok) {
      throw new Error(`Jira search failed (${resp.status}): ${await resp.text()}`);
    }
    return (await resp.json()) as JiraSearchResponse;
  }

  /**
   * Get full issue details including changelog.
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const params = new URLSearchParams({
      expand: "renderedFields,changelog",
    });

    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch issue ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraIssue;
  }

  /**
   * List comments on an issue.
   */
  async getComments(
    issueKey: string
  ): Promise<{ comments: JiraComment[]; total: number }> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?expand=renderedBody`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch comments for ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as { comments: JiraComment[]; total: number };
  }

  /**
   * Get sprint details.
   */
  async getSprint(sprintId: number): Promise<JiraSprint> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/sprint/${sprintId}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch sprint ${sprintId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraSprint;
  }

  /**
   * Get issues in a sprint.
   */
  async getSprintIssues(
    sprintId: number,
    maxResults: number = 50,
    startAt: number = 0
  ): Promise<JiraSearchResponse> {
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      startAt: String(startAt),
      fields:
        "summary,status,assignee,priority,issuetype",
    });

    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/sprint/${sprintId}/issue?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch sprint issues (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraSearchResponse;
  }

  /**
   * List Agile boards, optionally filtered by project key.
   */
  async listBoards(
    projectKey?: string
  ): Promise<{ values: JiraBoard[] }> {
    const params = new URLSearchParams();
    if (projectKey) params.set("projectKeyOrId", projectKey);

    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/board?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list boards (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as { values: JiraBoard[] };
  }

  /**
   * List sprints on a board.
   */
  async getBoardSprints(
    boardId: number,
    state?: string
  ): Promise<{ values: JiraSprint[] }> {
    const params = new URLSearchParams();
    if (state) params.set("state", state);

    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch board sprints (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as { values: JiraSprint[] };
  }

  /**
   * Create a new issue.
   */
  async createIssue(fields: Record<string, unknown>): Promise<JiraCreateIssueResponse> {
    const resp = await this.fetch(`${this.baseUrl}/rest/api/2/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to create issue (${resp.status}): ${await resp.text()}`);
    }
    return (await resp.json()) as JiraCreateIssueResponse;
  }

  /**
   * Update an existing issue's fields.
   */
  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      }
    );
    if (!resp.ok) {
      throw new Error(`Failed to update issue ${issueKey} (${resp.status}): ${await resp.text()}`);
    }
  }

  /**
   * Add a comment to an issue.
   */
  async addComment(issueKey: string, body: string): Promise<JiraComment> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    if (!resp.ok) {
      throw new Error(`Failed to add comment to ${issueKey} (${resp.status}): ${await resp.text()}`);
    }
    return (await resp.json()) as JiraComment;
  }

  /**
   * Get available workflow transitions for an issue.
   */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`
    );
    if (!resp.ok) {
      throw new Error(`Failed to get transitions for ${issueKey} (${resp.status}): ${await resp.text()}`);
    }
    const data = (await resp.json()) as { transitions: JiraTransition[] };
    return data.transitions;
  }

  /**
   * Transition an issue to a new status.
   */
  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transition: { id: transitionId } }),
      }
    );
    if (!resp.ok) {
      throw new Error(`Failed to transition issue ${issueKey} (${resp.status}): ${await resp.text()}`);
    }
  }

  /**
   * List available issue link types (e.g. "Blocks", "Relates", "Duplicate").
   */
  async getIssueLinkTypes(): Promise<JiraIssueLinkType[]> {
    const resp = await this.fetch(`${this.baseUrl}/rest/api/2/issueLinkType`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch link types (${resp.status}): ${await resp.text()}`);
    }
    const data = (await resp.json()) as { issueLinkTypes: JiraIssueLinkType[] };
    return data.issueLinkTypes;
  }

  /**
   * Create a link between two issues.
   *
   * @param linkTypeName  The name of the link type (e.g. "Blocks", "Relates", "Duplicate").
   *                      Use the *outward* sense: the first argument (outwardIssue) performs
   *                      this action on the second (inwardIssue).  For example,
   *                      linkTypeName="Blocks", outwardIssueKey="A", inwardIssueKey="B"
   *                      means "A blocks B".
   *
   * NOTE on the swap below — NRM-specific: BC Gov NRM Jira's
   * `POST /rest/api/2/issueLink` treats the JSON `outwardIssue` field as the
   * *target* of the link (the issue that ends up showing the inward description,
   * e.g. "is blocked by") and the JSON `inwardIssue` field as the *source* (the
   * issue showing the outward description, e.g. "blocks"). This is the opposite
   * of the natural reading of the field names. Verified empirically 2026-04-28
   * during AS Phase Epic execution: 13 Blocks links were created with reversed
   * direction before this fix landed. We deliberately swap the assignments so
   * callers can keep thinking in the natural direction documented above.
   *
   * RAVEN is BC Gov NRM-only by design (see README); if this client is ever
   * pointed at a non-NRM Jira instance with the standard `outwardIssue`/
   * `inwardIssue` semantics, this swap will need to be removed (or gated
   * behind config).
   */
  async linkIssues(
    linkTypeName: string,
    outwardIssueKey: string,
    inwardIssueKey: string,
    comment?: string
  ): Promise<void> {
    const body: Record<string, unknown> = {
      type: { name: linkTypeName },
      outwardIssue: { key: inwardIssueKey },
      inwardIssue: { key: outwardIssueKey },
    };
    if (comment) {
      body.comment = { body: comment };
    }
    const resp = await this.fetch(`${this.baseUrl}/rest/api/2/issueLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to link ${outwardIssueKey} → ${inwardIssueKey} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Worklogs
  // ---------------------------------------------------------------------------

  /**
   * List worklog entries on an issue. Jira DC's worklog endpoint is paginated
   * (returns startAt/maxResults/total), so callers should thread pagination
   * params through for issues with many entries.
   */
  async getWorklogs(
    issueKey: string,
    maxResults: number = 100,
    startAt: number = 0
  ): Promise<JiraWorklogsResponse> {
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      startAt: String(startAt),
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch worklogs for ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraWorklogsResponse;
  }

  /**
   * Add a worklog entry. timeSpent uses Jira format like "2h 30m" or "1d".
   * `started` is an ISO timestamp; defaults to now if omitted.
   */
  async addWorklog(
    issueKey: string,
    timeSpent: string,
    options?: { comment?: string; started?: string }
  ): Promise<JiraWorklog> {
    const body: Record<string, unknown> = { timeSpent };
    if (options?.comment) body.comment = options.comment;
    if (options?.started) body.started = options.started;
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/worklog`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to add worklog to ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraWorklog;
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  /**
   * List attachments on an issue. Fetches only the attachment field for speed.
   */
  async listAttachments(issueKey: string): Promise<JiraAttachment[]> {
    const params = new URLSearchParams({ fields: "attachment" });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch attachments for ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    const data = (await resp.json()) as { fields: { attachment?: JiraAttachment[] } };
    return data.fields.attachment ?? [];
  }

  /**
   * Get attachment metadata by ID.
   */
  async getAttachmentMetadata(attachmentId: string): Promise<JiraAttachment> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch attachment ${attachmentId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraAttachment;
  }

  /**
   * Rewrite an absolute URL to use the client's configured host. Jira returns
   * attachment content URLs pointing at its public (SiteMinder) host, but we
   * must fetch them via the authenticated base host (e.g. the Basic-Auth BWA
   * host). Same-origin URLs are returned unchanged; unparseable URLs pass through.
   */
  private toBaseHost(url: string): string {
    try {
      const target = new URL(url);
      const base = new URL(this.baseUrl);
      if (target.origin !== base.origin) {
        target.protocol = base.protocol;
        target.host = base.host;
        return target.toString();
      }
      return url;
    } catch {
      return url;
    }
  }

  /**
   * Download an attachment's raw bytes given its metadata. Rewrites the content
   * URL to the client's authenticated host (Jira returns URLs on its public
   * SiteMinder host) and follows at most one SAME-ORIGIN redirect; a
   * cross-origin redirect (different scheme, host, or port) is refused to avoid
   * leaking credentials.
   */
  async downloadAttachmentContent(meta: JiraAttachment): Promise<Uint8Array> {
    const contentUrl = this.toBaseHost(meta.content);
    let resp = await this.fetch(contentUrl);
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (location) {
        const target = new URL(location, contentUrl);
        if (target.origin !== new URL(contentUrl).origin) {
          throw new Error(
            `Refusing to follow cross-origin attachment redirect to ${target.origin} (would leak credentials)`
          );
        }
        resp = await this.fetch(target.toString());
      }
    }
    if (!resp.ok) {
      throw new Error(
        `Failed to download attachment ${meta.id} (${resp.status}): ${await resp.text()}`
      );
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Download an attachment's metadata + bytes by ID.
   */
  async downloadAttachment(
    attachmentId: string
  ): Promise<{ meta: JiraAttachment; bytes: Uint8Array }> {
    const meta = await this.getAttachmentMetadata(attachmentId);
    const bytes = await this.downloadAttachmentContent(meta);
    return { meta, bytes };
  }

  // ---------------------------------------------------------------------------
  // User search
  // ---------------------------------------------------------------------------

  /**
   * Search users by username/displayName/email substring (Jira DC syntax).
   */
  async searchUsers(query: string, maxResults: number = 25): Promise<JiraUser[]> {
    const params = new URLSearchParams({
      username: query,
      maxResults: String(maxResults),
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/user/search?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to search users (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraUser[];
  }

  /**
   * Search users assignable to issues in a given project.
   */
  async searchAssignableUsers(
    projectKey: string,
    query: string = "",
    maxResults: number = 25
  ): Promise<JiraUser[]> {
    const params = new URLSearchParams({
      project: projectKey,
      username: query,
      maxResults: String(maxResults),
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/user/assignable/search?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to search assignable users (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraUser[];
  }

  // ---------------------------------------------------------------------------
  // Project versions
  // ---------------------------------------------------------------------------

  async listProjectVersions(projectKey: string): Promise<JiraVersion[]> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list versions for ${projectKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraVersion[];
  }

  async getVersion(versionId: string): Promise<JiraVersion> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/version/${encodeURIComponent(versionId)}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch version ${versionId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraVersion;
  }

  async createVersion(
    projectKey: string,
    name: string,
    options?: {
      description?: string;
      startDate?: string;
      releaseDate?: string;
      released?: boolean;
      archived?: boolean;
    }
  ): Promise<JiraVersion> {
    const body: Record<string, unknown> = { project: projectKey, name };
    if (options?.description) body.description = options.description;
    if (options?.startDate) body.startDate = options.startDate;
    if (options?.releaseDate) body.releaseDate = options.releaseDate;
    if (options?.released !== undefined) body.released = options.released;
    if (options?.archived !== undefined) body.archived = options.archived;
    const resp = await this.fetch(`${this.baseUrl}/rest/api/2/version`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to create version '${name}' (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraVersion;
  }

  async updateVersion(
    versionId: string,
    updates: Partial<{
      name: string;
      description: string;
      startDate: string;
      releaseDate: string;
      released: boolean;
      archived: boolean;
    }>
  ): Promise<JiraVersion> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/version/${encodeURIComponent(versionId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to update version ${versionId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraVersion;
  }

  /**
   * Delete a version. If the version has issues with fixVersion or
   * affectedVersion set, those references are either cleared or moved to
   * `moveFixIssuesTo` / `moveAffectedIssuesTo` (must be other version IDs).
   */
  async deleteVersion(
    versionId: string,
    options?: { moveFixIssuesTo?: string; moveAffectedIssuesTo?: string }
  ): Promise<void> {
    const params = new URLSearchParams();
    if (options?.moveFixIssuesTo) params.set("moveFixIssuesTo", options.moveFixIssuesTo);
    if (options?.moveAffectedIssuesTo) params.set("moveAffectedIssuesTo", options.moveAffectedIssuesTo);
    const qs = params.toString();
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/version/${encodeURIComponent(versionId)}${qs ? `?${qs}` : ""}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to delete version ${versionId} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Watchers
  // ---------------------------------------------------------------------------

  async getWatchers(issueKey: string): Promise<JiraWatchersResponse> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch watchers for ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraWatchersResponse;
  }

  /**
   * Add a watcher. The body is the username as a bare JSON string.
   */
  async addWatcher(issueKey: string, username: string): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(username),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to add watcher '${username}' to ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  async removeWatcher(issueKey: string, username: string): Promise<void> {
    const params = new URLSearchParams({ username });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/watchers?${params}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to remove watcher '${username}' from ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Sprint management
  // ---------------------------------------------------------------------------

  async createSprint(
    boardId: number,
    name: string,
    options?: { startDate?: string; endDate?: string; goal?: string }
  ): Promise<JiraSprint> {
    const body: Record<string, unknown> = { name, originBoardId: boardId };
    if (options?.startDate) body.startDate = options.startDate;
    if (options?.endDate) body.endDate = options.endDate;
    if (options?.goal) body.goal = options.goal;
    const resp = await this.fetch(`${this.baseUrl}/rest/agile/1.0/sprint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to create sprint '${name}' (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraSprint;
  }

  /**
   * Update a sprint. The Agile API exposes BOTH methods at this endpoint and
   * they are semantically different:
   *   - POST /rest/agile/1.0/sprint/{id} — partial update; only the fields
   *     present in the body are touched, others retain their values.
   *   - PUT  /rest/agile/1.0/sprint/{id} — full update; omitted fields may
   *     be reset to defaults.
   *
   * This client passes only changed fields (callers expect partial-update
   * semantics — that's what "update_sprint name only" means), so POST is
   * correct. PUT with a partial body would surprise callers by wiping
   * unspecified fields. This is documented at
   * https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/
   *
   * Pass `state: "active"` (with start/end dates) to start, or `state: "closed"`
   * to close. Most fields are optional.
   */
  async updateSprint(
    sprintId: number,
    updates: Partial<{
      name: string;
      startDate: string;
      endDate: string;
      goal: string;
      state: "active" | "closed" | "future";
    }>
  ): Promise<JiraSprint> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/sprint/${sprintId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to update sprint ${sprintId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraSprint;
  }

  async deleteSprint(sprintId: number): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/sprint/${sprintId}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to delete sprint ${sprintId} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  /**
   * Move issues into a sprint. Up to 50 issues per call (Agile API limit).
   */
  async moveIssuesToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/agile/1.0/sprint/${sprintId}/issue`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issues: issueKeys }),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to move issues into sprint ${sprintId} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Comment update / delete
  // ---------------------------------------------------------------------------

  async updateComment(issueKey: string, commentId: string, body: string): Promise<JiraComment> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to update comment ${commentId} on ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as JiraComment;
  }

  async deleteComment(issueKey: string, commentId: string): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to delete comment ${commentId} on ${issueKey} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Field metadata (createmeta / editmeta)
  // ---------------------------------------------------------------------------

  /**
   * Get normalized field metadata for creating an issue of the given type.
   * Uses the paged createmeta endpoints (Jira 8.4+; the classic
   * /issue/createmeta endpoint was removed in Jira 9).
   */
  async getCreateMeta(
    projectKey: string,
    issueTypeName: string
  ): Promise<JiraFieldMeta[]> {
    const issueTypes = await this.fetchAllCreateMetaPages<{ id: string; name: string }>(
      `${this.baseUrl}/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      100
    );

    const lower = issueTypeName.toLowerCase();
    const issueType = issueTypes.find((t) => t.name.toLowerCase() === lower);
    if (!issueType) {
      const available = issueTypes.map((t) => t.name).join(", ");
      throw new Error(
        `Issue type "${issueTypeName}" not found in project ${projectKey}. Available types: ${available}`
      );
    }

    const rawFields = await this.fetchAllCreateMetaPages<RawFieldMeta & { fieldId: string }>(
      `${this.baseUrl}/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${issueType.id}`,
      200
    );
    return rawFields.map((f) => normalizeFieldMeta(f.fieldId, f));
  }

  /**
   * Collect every page of a paged createmeta endpoint. Follows isLast so
   * projects with many issue types / fields aren't silently truncated.
   */
  private async fetchAllCreateMetaPages<T>(
    url: string,
    maxResults: number
  ): Promise<T[]> {
    const all: T[] = [];
    let startAt = 0;
    for (;;) {
      const resp = await this.fetch(`${url}?maxResults=${maxResults}&startAt=${startAt}`);
      if (!resp.ok) {
        throw new Error(
          `Failed to get create metadata (${resp.status}): ${await resp.text()}`
        );
      }
      const page = (await resp.json()) as { values: T[]; isLast?: boolean };
      all.push(...page.values);
      // Trust isLast; treat a missing flag or an empty page as final so a
      // misbehaving server can't loop us forever.
      if (page.isLast !== false || page.values.length === 0) return all;
      startAt += page.values.length;
    }
  }

  /**
   * Get normalized field metadata for editing an existing issue.
   */
  async getEditMeta(issueKey: string): Promise<JiraFieldMeta[]> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to get edit metadata (${resp.status}): ${await resp.text()}`
      );
    }
    const body = (await resp.json()) as { fields: Record<string, RawFieldMeta> };
    return Object.entries(body.fields).map(([fieldId, f]) =>
      normalizeFieldMeta(fieldId, f)
    );
  }
}

/** Raw field metadata entry as returned by createmeta/editmeta. */
interface RawFieldMeta {
  name: string;
  required: boolean;
  schema?: { type: string; items?: string; custom?: string };
  allowedValues?: Array<Record<string, unknown>>;
}

function normalizeFieldMeta(fieldId: string, f: RawFieldMeta): JiraFieldMeta {
  return {
    fieldId,
    name: f.name,
    required: f.required,
    schema: {
      type: f.schema?.type ?? "string",
      items: f.schema?.items,
      custom: f.schema?.custom,
    },
    allowedValues: f.allowedValues,
  };
}
