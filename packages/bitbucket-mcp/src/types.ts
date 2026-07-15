/** Bitbucket DC repository */
export interface BitbucketRepo {
  slug: string;
  name: string;
  project: { key: string; name: string };
  state: string;
  description?: string;
  forkable: boolean;
  links: {
    clone?: Array<{ href: string; name: string }>;
    self?: Array<{ href: string }>;
  };
}

/** Bitbucket DC paged response */
export interface PagedResponse<T> {
  size: number;
  limit: number;
  start: number;
  isLastPage: boolean;
  values: T[];
  nextPageStart?: number;
}

/** Bitbucket DC file/directory entry */
export interface BitbucketFileEntry {
  path: { toString: string; name: string; extension?: string };
  type: "FILE" | "DIRECTORY";
  size?: number;
}

/** Bitbucket DC file browse response */
export interface BitbucketBrowseResponse {
  path: { toString: string };
  children?: PagedResponse<BitbucketFileEntry>;
  lines?: Array<{ text: string }>;
}

/** Bitbucket DC branch */
export interface BitbucketBranch {
  id: string;
  displayId: string;
  type: string;
  latestCommit: string;
  isDefault: boolean;
}

/** Bitbucket DC pull request */
export interface BitbucketPullRequest {
  id: number;
  /** Optimistic-locking version. Required when merging/declining. */
  version?: number;
  title: string;
  description?: string;
  state: string;
  author: { user: { displayName: string; name?: string } };
  reviewers: Array<{
    user: { displayName: string; name?: string };
    approved: boolean;
    status?: string;
  }>;
  fromRef: { displayId: string; repository: { slug: string } };
  toRef: { displayId: string };
  createdDate: number;
  updatedDate: number;
  links: { self?: Array<{ href: string }> };
}

/** Single PR comment (general or inline). */
export interface BitbucketPRComment {
  id: number;
  version: number;
  text: string;
  author: { displayName: string; name?: string };
  createdDate: number;
  updatedDate: number;
  /** Present on inline comments — anchors comment to a file/line. */
  anchor?: {
    path: string;
    line?: number;
    lineType?: "ADDED" | "REMOVED" | "CONTEXT";
    fileType?: "FROM" | "TO";
  };
  comments?: BitbucketPRComment[];
}

/** A single entry in the PR activity stream. */
export interface BitbucketPRActivity {
  id: number;
  createdDate: number;
  user: { displayName: string; name?: string };
  action: string;
  comment?: BitbucketPRComment;
  commentAction?: string;
}

/** Bitbucket DC commit summary as returned in PR commits. */
export interface BitbucketCommit {
  id: string;
  displayId: string;
  author: { name: string; emailAddress: string };
  authorTimestamp: number;
  message: string;
  parents: Array<{ id: string; displayId: string }>;
}

/** Bitbucket DC mergeability check response. */
export interface BitbucketMergeStatus {
  canMerge: boolean;
  conflicted: boolean;
  vetoes: Array<{ summaryMessage: string; detailedMessage?: string }>;
}

/** A Bitbucket DC tag (lightweight or annotated). */
export interface BitbucketTag {
  id: string;             // refs/tags/<name>
  displayId: string;      // <name>
  type: "TAG";
  latestCommit: string;
  latestChangeset: string;
  hash: string | null;    // null for lightweight tags
}

/** A single build status entry attached to a commit. */
export interface BitbucketBuildStatus {
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "CANCELLED" | "UNKNOWN" | string;
  key: string;
  name?: string;
  url?: string;
  description?: string;
  /** Epoch millis (DC) */
  dateAdded?: number;
}

/** Bitbucket DC blame range — one entry covers one or more consecutive lines. */
export interface BitbucketBlameRange {
  lineNumber: number;
  spannedLines: number;
  commitId?: string;
  commitDisplayId?: string;
  commitHash?: string;
  authorName?: string;
  authorEmail?: string;
  /** Epoch millis */
  authorTimestamp?: number;
  fileName?: string;
}

/** Browse-with-blame response (paged). */
export interface BitbucketBlameResponse {
  lines: Array<{ text: string }>;
  blame: BitbucketBlameRange[];
  start: number;
  size: number;
  isLastPage: boolean;
  nextPageStart?: number;
}

/** Bitbucket Code Search — a single file match (Bitbucket DC 8.x POST API) */
export interface CodeSearchResult {
  repository: {
    slug: string;
    name: string;
    project: { key: string; name: string };
  };
  file: string;
  hitContexts: Array<
    Array<{
      text: string;
      line: number;
    }>
  >;
}

/** Bitbucket Code Search API response (Bitbucket DC 8.x POST API) */
export interface CodeSearchResponse {
  code: {
    count: number;
    values: CodeSearchResult[];
    isLastPage: boolean;
    start: number;
    nextStart: number;
  };
}
