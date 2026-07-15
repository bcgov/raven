/** Jira issue from REST API */
export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    assignee: { displayName: string } | null;
    reporter: { displayName: string } | null;
    priority: { name: string } | null;
    issuetype: { name: string };
    created: string;
    updated: string;
    labels: string[];
    components: Array<{ name: string }>;
    fixVersions: Array<{ name: string }>;
    parent?: { key: string; fields: { summary: string } };
  };
  renderedFields?: {
    description: string | null;
  };
  changelog?: {
    histories: Array<{
      created: string;
      author: { displayName: string };
      items: Array<{
        field: string;
        fromString: string | null;
        toString: string | null;
      }>;
    }>;
  };
}

/** Jira search response */
export interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

/** Jira comment */
export interface JiraComment {
  id: string;
  author: { displayName: string };
  body: string;
  renderedBody?: string;
  created: string;
  updated: string;
}

/** Jira sprint */
export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

/** Jira Agile board */
export interface JiraBoard {
  id: number;
  name: string;
  type: string; // "scrum", "kanban", "simple"
}

/** Response from creating a Jira issue */
export interface JiraCreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

/** Jira workflow transition */
export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

/** Jira issue link type (e.g. "Blocks", "Relates", "Duplicate") */
export interface JiraIssueLinkType {
  id: string;
  name: string;
  inward: string;  // e.g. "is blocked by"
  outward: string; // e.g. "blocks"
}

/** Jira worklog entry. */
export interface JiraWorklog {
  id: string;
  author: { displayName: string; name?: string };
  comment?: string;
  /** ISO timestamp when the work was performed */
  started: string;
  /** Time spent in human form, e.g. "2h 30m" */
  timeSpent: string;
  timeSpentSeconds: number;
  created: string;
  updated: string;
}

/** Response shape for /issue/{key}/worklog */
export interface JiraWorklogsResponse {
  worklogs: JiraWorklog[];
  total: number;
  startAt: number;
  maxResults: number;
}

/** Jira attachment metadata. */
export interface JiraAttachment {
  id: string;
  filename: string;
  author: { displayName: string };
  created: string;
  size: number;
  mimeType: string;
  content: string; // download URL
}

/** Jira user (DC, identified by username). */
export interface JiraUser {
  name: string;
  key?: string;
  emailAddress?: string;
  displayName: string;
  active: boolean;
}

/** Jira project version (used for fixVersions / affectedVersions). */
export interface JiraVersion {
  id: string;
  name: string;
  description?: string;
  archived: boolean;
  released: boolean;
  /** Numeric project ID the version belongs to (Jira returns this as a number). */
  projectId?: number;
  startDate?: string;
  releaseDate?: string;
  userStartDate?: string;
  userReleaseDate?: string;
  overdue?: boolean;
}

/** Watchers response on an issue. */
export interface JiraWatchersResponse {
  isWatching: boolean;
  watchCount: number;
  watchers: Array<{ name: string; displayName: string; active: boolean }>;
}
