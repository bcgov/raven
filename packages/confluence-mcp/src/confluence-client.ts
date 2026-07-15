import type { AuthenticatedFetch } from "@nrs/auth";
import type {
  ConfluenceSearchResponse,
  ConfluencePage,
  ConfluenceSpacesResponse,
  ConfluencePageWriteResponse,
  ConfluenceChildPagesResponse,
  ConfluenceAttachment,
  ConfluenceAttachmentsResponse,
  ConfluenceLabel,
  ConfluenceLabelsResponse,
  ConfluenceLabelsAggregate,
  ConfluenceCommentItem,
  ConfluenceCommentsResponse,
} from "./types.js";

const DEFAULT_BASE_URL =
  process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/confluence`
    : "https://apps.example.gov.bc.ca/int/confluence";

/**
 * REST client for Confluence Data Center.
 * Direct REST calls replacing the Python atlassian-python-api dependency.
 */
export class ConfluenceClient {
  private baseUrl: string;
  private fetch: AuthenticatedFetch;

  constructor(fetch: AuthenticatedFetch, baseUrl?: string) {
    this.fetch = fetch;
    this.baseUrl =
      baseUrl ?? process.env["CONFLUENCE_URL"] ?? DEFAULT_BASE_URL;
  }

  /**
   * Search pages via CQL (Confluence Query Language).
   */
  async search(
    cql: string,
    limit: number = 10,
    start: number = 0
  ): Promise<ConfluenceSearchResponse> {
    const params = new URLSearchParams({
      cql,
      limit: String(limit),
      start: String(start),
      expand: "history.lastUpdated,version",
    });

    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/search?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Confluence search failed (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceSearchResponse;
  }

  /**
   * Get a page by ID with full body content.
   */
  async getPage(pageId: string): Promise<ConfluencePage> {
    const params = new URLSearchParams({
      expand: "body.storage,version,history.lastUpdated,space",
    });

    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch page ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluencePage;
  }

  /**
   * List all accessible spaces.
   */
  async listSpaces(
    limit: number = 50
  ): Promise<ConfluenceSpacesResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      expand: "description.plain",
    });

    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/space?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list spaces (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceSpacesResponse;
  }

  /**
   * Create a new page in a space.
   */
  async createPage(
    spaceKey: string,
    title: string,
    bodyHtml: string,
    parentId?: string
  ): Promise<ConfluencePageWriteResponse> {
    const payload: Record<string, unknown> = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: {
        storage: {
          value: bodyHtml,
          representation: "storage",
        },
      },
    };

    if (parentId) {
      payload.ancestors = [{ id: parentId }];
    }

    const resp = await this.fetch(`${this.baseUrl}/rest/api/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to create page (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluencePageWriteResponse;
  }

  /**
   * List the immediate child pages of a given page.
   */
  async getPageChildren(
    pageId: string,
    limit: number = 25,
    start: number = 0
  ): Promise<ConfluenceChildPagesResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      start: String(start),
      expand: "history.lastUpdated",
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/page?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list children of ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceChildPagesResponse;
  }

  /**
   * Get a page's ancestor chain (root → parent → … → page's parent).
   * Uses the standard content endpoint with expand=ancestors.
   */
  async getPageAncestors(pageId: string): Promise<ConfluencePage> {
    const params = new URLSearchParams({ expand: "ancestors,space" });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch ancestors for ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluencePage;
  }

  /**
   * List attachments on a page.
   */
  async getAttachments(
    pageId: string,
    limit: number = 25,
    start: number = 0
  ): Promise<ConfluenceAttachmentsResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      start: String(start),
      expand: "version,metadata.mediaType,extensions",
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list attachments for ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceAttachmentsResponse;
  }

  /**
   * Upload an attachment to a page. If `filename` already exists on the page,
   * a new version of that attachment is created rather than a duplicate.
   *
   * On Confluence Data Center the bare `child/attachment` create endpoint
   * rejects a duplicate filename with HTTP 400 ("Cannot add a new attachment
   * with same file name…"); versioning an existing attachment requires POSTing
   * the new data to `child/attachment/{id}/data`. We therefore look the page's
   * attachments up first and route to the correct endpoint.
   */
  async uploadAttachment(
    pageId: string,
    filename: string,
    content: Uint8Array,
    options?: { mimeType?: string; comment?: string; minorEdit?: boolean }
  ): Promise<ConfluenceAttachmentsResponse> {
    const blob = new Blob([content as BlobPart], {
      type: options?.mimeType ?? "application/octet-stream",
    });
    const form = new FormData();
    form.append("file", blob, filename);
    if (options?.comment) form.append("comment", options.comment);
    if (options?.minorEdit) form.append("minorEdit", "true");

    // Find an existing attachment with the same filename so we can version it
    // instead of attempting a duplicate create (which DC rejects with 400).
    const match = await this.findAttachmentByTitle(pageId, filename);
    const url = match
      ? `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/${encodeURIComponent(match.id)}/data`
      : `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;

    const resp = await this.fetch(url, {
      method: "POST",
      // X-Atlassian-Token bypasses XSRF check on multipart uploads.
      // Do NOT set Content-Type — fetch sets it with the boundary.
      headers: { "X-Atlassian-Token": "no-check" },
      body: form,
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to upload attachment to ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    // The create endpoint (`child/attachment`) returns a paged
    // `{ results: [...] }` wrapper, but the version endpoint
    // (`child/attachment/{id}/data`) returns a single attachment object.
    // Normalize both to the paged shape callers expect.
    const json = (await resp.json()) as
      | ConfluenceAttachmentsResponse
      | ConfluenceAttachment;
    if ("results" in json) {
      return json;
    }
    return { results: [json], start: 0, limit: 1, size: 1 };
  }

  /**
   * Find an existing attachment on a page by filename, walking pages of the
   * attachment listing so a duplicate that sits beyond the first page is still
   * detected. Without this, a page with more than `pageSize` attachments could
   * route a re-upload to the create endpoint and hit the DC 400 this is meant
   * to avoid. Returns the matching attachment, or `undefined` if none exists.
   *
   * Scans at most `maxScan` attachments so a server with broken pagination
   * (full pages that ignore `start`) can't spin forever — mirrors the bounded
   * loop in `getLabels`.
   */
  private async findAttachmentByTitle(
    pageId: string,
    filename: string,
    maxScan: number = 5000
  ): Promise<ConfluenceAttachment | undefined> {
    let start = 0;
    while (start < maxScan) {
      const page = await this.getAttachments(pageId, 200, start);
      const match = page.results.find((a) => a.title === filename);
      if (match) return match;
      if (page.results.length === 0) return undefined; // belt + braces against infinite loops
      // Confluence paged responses don't carry a reliable total — and the server
      // may cap `limit` below what we asked for. Compare against the *response's*
      // limit (not our requested size) so a capped first page isn't mistaken for
      // EOF; a short page means we've drained the listing.
      if (page.results.length < page.limit) return undefined;
      start += page.results.length;
    }
    return undefined;
  }

  /**
   * Get all labels on a page. Walks pages of the /label endpoint so heavily-
   * labelled pages don't silently truncate.
   *
   * Returns a dedicated aggregate type rather than `ConfluenceLabelsResponse`
   * to make it clear that the contents represent an internally-collected
   * set, not a single server page (with its own pagination cursor).
   */
  async getLabels(pageId: string, maxLabels: number = 500): Promise<ConfluenceLabelsAggregate> {
    const all: ConfluenceLabel[] = [];
    let start = 0;
    const pageSize = 50;
    let hitCap = false;
    while (all.length < maxLabels) {
      const params = new URLSearchParams({
        limit: String(Math.min(pageSize, maxLabels - all.length)),
        start: String(start),
      });
      const resp = await this.fetch(
        `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/label?${params}`
      );
      if (!resp.ok) {
        throw new Error(
          `Failed to fetch labels for ${pageId} (${resp.status}): ${await resp.text()}`
        );
      }
      const page = (await resp.json()) as ConfluenceLabelsResponse;
      all.push(...page.results);
      // Confluence paged responses don't carry a total — stop when the page
      // came back short of the requested size, which means we've drained it.
      if (page.results.length < page.limit) break;
      start += page.results.length;
      if (page.results.length === 0) break; // belt + braces against infinite loops
      if (all.length >= maxLabels) {
        hitCap = true;
        break;
      }
    }
    const labels = all.slice(0, maxLabels);
    return { labels, count: labels.length, truncated: hitCap };
  }

  /**
   * Add labels to a page. Each label gets the default `global` prefix.
   */
  async addLabels(pageId: string, names: string[]): Promise<ConfluenceLabelsResponse> {
    const payload = names.map((name) => ({ prefix: "global", name }));
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/label`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to add labels to ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceLabelsResponse;
  }

  /**
   * Remove a single label from a page.
   */
  async removeLabel(pageId: string, name: string): Promise<void> {
    const params = new URLSearchParams({ name });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/label?${params}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to remove label '${name}' from ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  /**
   * List page-level comments on a page.
   */
  async getPageComments(
    pageId: string,
    limit: number = 25,
    start: number = 0
  ): Promise<ConfluenceCommentsResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      start: String(start),
      depth: "all",
      expand: "body.storage,version,history.createdBy,history.createdDate,extensions.location",
    });
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/comment?${params}`
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to list comments for ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceCommentsResponse;
  }

  /**
   * Add a page-level comment. Confluence comments are content of type=comment
   * with a container reference to the parent page.
   */
  async addPageComment(
    pageId: string,
    bodyHtml: string
  ): Promise<ConfluenceCommentItem> {
    const payload = {
      type: "comment",
      container: { id: pageId, type: "page" },
      body: {
        storage: {
          value: bodyHtml,
          representation: "storage",
        },
      },
    };
    const resp = await this.fetch(`${this.baseUrl}/rest/api/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(
        `Failed to add comment to ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluenceCommentItem;
  }

  /**
   * Delete a page (trashes it; recoverable by space admins).
   */
  async deletePage(pageId: string): Promise<void> {
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`,
      { method: "DELETE" }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to delete page ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
  }

  /**
   * Move a page to a new parent. Requires the current title and version since
   * Confluence's update endpoint demands them even when only ancestors change.
   */
  async movePage(
    pageId: string,
    newParentId: string
  ): Promise<ConfluencePageWriteResponse> {
    const current = await this.getPage(pageId);
    const payload = {
      type: "page",
      title: current.title,
      // Required: keep the body intact. Re-emit the existing storage.
      body: {
        storage: {
          value: current.body?.storage?.value ?? "",
          representation: "storage",
        },
      },
      version: { number: (current.version?.number ?? 0) + 1 },
      ancestors: [{ id: newParentId }],
    };
    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to move page ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluencePageWriteResponse;
  }

  /**
   * Update an existing page.
   */
  async updatePage(
    pageId: string,
    title: string,
    bodyHtml: string,
    versionNumber: number
  ): Promise<ConfluencePageWriteResponse> {
    const payload = {
      type: "page",
      title,
      body: {
        storage: {
          value: bodyHtml,
          representation: "storage",
        },
      },
      version: {
        number: versionNumber,
      },
    };

    const resp = await this.fetch(
      `${this.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to update page ${pageId} (${resp.status}): ${await resp.text()}`
      );
    }
    return (await resp.json()) as ConfluencePageWriteResponse;
  }

}
