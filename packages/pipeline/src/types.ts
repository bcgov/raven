/** Parsed error from server logs. */
export interface ErrorInfo {
  /** The raw error/exception message line */
  message: string;
  /** Full stack trace (multi-line) */
  stackTrace: string;
  /** Short key for deduplication (e.g. exception class + first frame) */
  dedupeKey: string;
  /** Number of occurrences found in the log window */
  occurrences: number;
}

/** AI-generated root cause analysis. */
export interface TriageResult {
  summary: string;
  rootCause: string;
  severity: "critical" | "high" | "medium" | "low";
  suggestedTitle: string;
}

/** AI-generated fix plan. */
export interface FixPlan {
  affectedFiles: string[];
  rootCause: string;
  proposedFix: string;
  /** The actual code patch in unified diff format */
  patch: string;
}

/** Shared state passed between pipeline steps. */
export interface PipelineContext {
  // Input
  /** Target server — empty string in jira-query mode. */
  server: string;
  app: string;
  component: string;
  dryRun: boolean;
  bitbucketProject?: string;
  bitbucketRepo?: string;

  /** Jira project key (may differ from app name, e.g., SOS errors live in CWM project) */
  jiraProject: string;
  /** Skip test execution. */
  skipTests?: boolean;
  /** Enable verbose logging. */
  verbose?: boolean;
  /** Skip duplicate detection — always create a new ticket. */
  forceNew?: boolean;
  /** Use an existing Jira ticket — skip triage entirely. */
  existingTicket?: string;

  // Detect
  errors: ErrorInfo[];
  /** Dedup keys already processed in previous watch iterations (dry-run). */
  processedDedupeKeys?: Set<string>;

  // Triage
  ticketKey?: string;
  isDuplicate?: boolean;
  triageResult?: TriageResult;

  // Plan
  repoPath?: string;
  /** When the fix is in a different repo than the app repo (e.g., shared library) */
  sourceProject?: string;
  sourceRepo?: string;
  fixPlan?: FixPlan;

  // Implement
  branchName?: string;
  commitHash?: string;
  testsPass?: boolean;

  // PR
  prUrl?: string;
}

/** CLI arguments parsed from command line. */
export interface CliArgs {
  /** Target server — required for log scanning, optional for --jira-query mode. */
  server?: string;
  app: string;
  component: string;
  dryRun: boolean;
  /** Run up to this step number (1-6). Useful for testing individual steps. */
  stopAfter?: number;
  /** Skip duplicate detection in triage — always create a new ticket. */
  forceNew?: boolean;
  /** Use an existing Jira ticket — skip triage entirely. */
  existingTicket?: string;
  bitbucketProject?: string;
  bitbucketRepo?: string;
  jiraProject?: string;
  model?: string;
  /** Resume the last run for this app/component. */
  resume?: boolean;
  /** Ignore saved state, start from scratch. */
  fresh?: boolean;
  /** Skip test execution — useful when tests need infrastructure not available locally. */
  skipTests?: boolean;
  /** Enable verbose logging for debugging. */
  verbose?: boolean;
  /** Run continuously, looping back to DETECT after each cycle. */
  watch?: boolean;
  /** Seconds between watch iterations (default 300). */
  watchInterval?: number;
  /** Maximum number of watch iterations before stopping. */
  maxIterations?: number;
  /** JQL query to process existing Jira tickets instead of scanning logs. */
  jiraQuery?: string;
}

/** Result of a single pipeline run. */
export interface PipelineResult {
  success: boolean;
  stoppedAt?: string;
  context: PipelineContext;
  error?: string;
}
