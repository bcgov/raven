// ---------------------------------------------------------------------------
// Azure DevOps REST API types (ADO Server / on-premises)
// ---------------------------------------------------------------------------

/** Slim work item returned by WIQL queries. */
export interface AdoWorkItemRef {
  id: number;
  url: string;
}

/** Full work item with all fields. */
export interface AdoWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  _links?: Record<string, { href: string }>;
  url: string;
}

/** WIQL query result. */
export interface AdoWiqlResult {
  workItems: AdoWorkItemRef[];
  columns: Array<{ referenceName: string; name: string }>;
  queryType: string;
  asOf: string;
}

/** Work item comment. */
export interface AdoWorkItemComment {
  id: number;
  text: string;
  createdBy: AdoIdentityRef;
  createdDate: string;
  modifiedDate: string;
}

export interface AdoWorkItemCommentsPage {
  comments: AdoWorkItemComment[];
  count: number;
  totalCount: number;
}

/** Identity reference used across ADO types. */
export interface AdoIdentityRef {
  displayName: string;
  uniqueName?: string;
  id?: string;
}

/** Git repository. */
export interface AdoRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
  webUrl?: string;
  project: AdoTeamProjectRef;
}

export interface AdoRepositoryList {
  value: AdoRepository[];
  count: number;
}

/** Team project reference. */
export interface AdoTeamProjectRef {
  id: string;
  name: string;
}

/** Git branch (ref). */
export interface AdoGitRef {
  name: string;
  objectId: string;
  creator?: AdoIdentityRef;
  url: string;
}

export interface AdoGitRefList {
  value: AdoGitRef[];
  count: number;
}

/** Git tree item (file/directory). */
export interface AdoGitItem {
  objectId: string;
  gitObjectType: "blob" | "tree" | "tag" | "commit";
  commitId: string;
  path: string;
  isFolder?: boolean;
  url: string;
}

export interface AdoGitItemList {
  value: AdoGitItem[];
  count: number;
}

/** Pull request. */
export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: "active" | "completed" | "abandoned" | "all" | "notSet";
  creationDate: string;
  closedDate?: string;
  createdBy: AdoIdentityRef;
  reviewers: AdoReviewer[];
  sourceRefName: string;
  targetRefName: string;
  mergeStatus?: string;
  url: string;
  repository: AdoRepository;
}

export interface AdoReviewer {
  displayName: string;
  uniqueName?: string;
  vote: number; // 10=approved, 5=approved-with-suggestions, 0=no vote, -5=waiting, -10=rejected
}

export interface AdoPullRequestList {
  value: AdoPullRequest[];
  count: number;
}

/** Build pipeline. */
export interface AdoPipeline {
  id: number;
  name: string;
  folder?: string;
  revision: number;
  _links?: Record<string, { href: string }>;
}

export interface AdoPipelineList {
  value: AdoPipeline[];
  count: number;
}

/** Project collection (ADO Server on-premises). */
export interface AdoCollection {
  id: string;
  name: string;
  url: string;
}

export interface AdoCollectionList {
  value: AdoCollection[];
  count: number;
}

/** Team project. */
export interface AdoProject {
  id: string;
  name: string;
  description?: string;
  state: string;
  visibility: string;
  lastUpdateTime?: string;
}

export interface AdoProjectList {
  value: AdoProject[];
  count: number;
}

/** Generic ADO paged list wrapper. */
export interface AdoValueList<T> {
  value: T[];
  count: number;
}

/** Work item type metadata for create/update operations. */
export type AdoWorkItemType =
  | "Bug"
  | "Task"
  | "User Story"
  | "Feature"
  | "Epic"
  | "Issue"
  | "Test Case"
  | "Test Plan";

/** JSON Patch operation for work item create/update. */
export interface AdoPatchOperation {
  op: "add" | "replace" | "remove" | "test";
  path: string;
  value?: unknown;
  from?: string;
}
