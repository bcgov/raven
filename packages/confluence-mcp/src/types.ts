/** Confluence search result */
export interface ConfluenceSearchResult {
  content: {
    id: string;
    title: string;
    type: string;
    _links?: { webui?: string };
    history?: {
      lastUpdated?: { when: string };
    };
  };
  excerpt?: string;
}

/** Confluence search response */
export interface ConfluenceSearchResponse {
  results: ConfluenceSearchResult[];
  totalSize: number;
  start: number;
  limit: number;
}

/** Confluence page content */
export interface ConfluencePage {
  id: string;
  title: string;
  type: string;
  body?: {
    storage?: { value: string };
  };
  version?: {
    when: string;
    by?: { displayName: string };
    number: number;
  };
  space?: {
    key: string;
    name: string;
  };
  ancestors?: Array<{
    id: string;
    title: string;
    type: string;
    _links?: { webui?: string };
  }>;
  _links?: { webui?: string };
}

/** A summary of a child page (subset of the full page schema). */
export interface ConfluenceChildPage {
  id: string;
  title: string;
  type: string;
  history?: { lastUpdated?: { when: string } };
  _links?: { webui?: string };
}

/** Paged response for content children endpoint. */
export interface ConfluenceChildPagesResponse {
  results: ConfluenceChildPage[];
  start: number;
  limit: number;
  size: number;
}

/** Confluence attachment metadata. */
export interface ConfluenceAttachment {
  id: string;
  type: "attachment";
  /** filename — Confluence stores it as `title` */
  title: string;
  version?: { number: number; when: string; by?: { displayName: string } };
  /**
   * Newer Confluence DC versions surface the MIME type here when
   * `expand=metadata.mediaType` is requested. Older versions only populate
   * `extensions.mediaType`. Callers should read either, preferring metadata.
   */
  metadata?: {
    mediaType?: string;
  };
  extensions?: {
    mediaType?: string;
    fileSize?: number;
    comment?: string;
  };
  _links?: { download?: string; webui?: string };
}

/** Paged response for attachments endpoint. */
export interface ConfluenceAttachmentsResponse {
  results: ConfluenceAttachment[];
  start: number;
  limit: number;
  size: number;
}

/** Confluence label. */
export interface ConfluenceLabel {
  prefix: string;
  name: string;
  id?: string;
  label?: string;
}

/** Paged response for labels endpoint (one page from the server). */
export interface ConfluenceLabelsResponse {
  results: ConfluenceLabel[];
  start: number;
  limit: number;
  size: number;
}

/**
 * Aggregated set of labels collected across multiple pages. Distinct from
 * the per-page `ConfluenceLabelsResponse` so consumers can't mistake the
 * fabricated start/limit/size for actual server pagination metadata.
 */
export interface ConfluenceLabelsAggregate {
  /** All labels across all walked pages. */
  labels: ConfluenceLabel[];
  /** Total labels collected (after the maxLabels cap is applied). */
  count: number;
  /** True if the walk stopped at the maxLabels cap rather than EOF. */
  truncated: boolean;
}

/** A page-level Confluence comment. */
export interface ConfluenceCommentItem {
  id: string;
  type: "comment";
  title?: string;
  body?: { storage?: { value: string } };
  version?: { number: number; when: string; by?: { displayName: string } };
  history?: {
    createdBy?: { displayName: string };
    createdDate?: string;
    lastUpdated?: { when: string };
  };
  extensions?: {
    location?: "footer" | "inline" | "resolved";
  };
  _links?: { webui?: string };
}

/** Paged response for comments endpoint. */
export interface ConfluenceCommentsResponse {
  results: ConfluenceCommentItem[];
  start: number;
  limit: number;
  size: number;
}

/** Confluence space */
export interface ConfluenceSpace {
  key: string;
  name: string;
  type: string;
  description?: {
    plain?: { value: string };
  };
}

/** Confluence spaces response */
export interface ConfluenceSpacesResponse {
  results: ConfluenceSpace[];
  start: number;
  limit: number;
  size: number;
}

/** Response from creating or updating a Confluence page */
export interface ConfluencePageWriteResponse {
  id: string;
  title: string;
  type: string;
  version: {
    number: number;
  };
  _links: {
    webui: string;
    self: string;
  };
}
