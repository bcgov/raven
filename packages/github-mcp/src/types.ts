// ---------------------------------------------------------------------------
// Canonical finding schema
// ---------------------------------------------------------------------------

/** Severity levels used by the canonical finding schema. */
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "note";

/** Confidence/precision levels. */
export type FindingConfidence = "high" | "medium" | "low";

/**
 * Canonical security finding emitted by RAVEN agents.
 * Converted to SARIF 2.1.0 by security_publish_sarif.
 */
export interface CanonicalFinding {
  /** Unique identifier within the upload batch. */
  finding_id: string;
  /** Stable rule ID used as the SARIF rule id (e.g. "RAVEN-SQLI-001"). */
  rule_id: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  /** CVSS-style numeric score in [0,10]. Stored in SARIF rule properties. */
  security_severity?: number;
  confidence?: FindingConfidence;
  precision?: "very-high" | "high" | "medium" | "low";
  cwe?: string[];
  owasp?: string[];
  /** Repository-relative file path (forward slashes). MUST NOT be absolute. */
  file: string;
  start_line: number;
  end_line?: number;
  start_column?: number;
  end_column?: number;
  /** Sanitised evidence — no exploit payloads, no secret material. */
  evidence?: string;
  recommendation?: string;
  /**
   * Fields used to compute a stable partial fingerprint.
   * If omitted, the MCP derives the fingerprint from owner/repo, rule_id,
   * file, start_line, and the title.
   */
  fingerprint_material?: {
    repo?: string;
    file?: string;
    rule_id?: string;
    /** SHA-256 or other hash of the source line context. */
    start_line_context_hash?: string;
  };
  requires_human_validation?: boolean;
}

// ---------------------------------------------------------------------------
// SARIF 2.1.0 subset (only the fields we produce/consume)
// ---------------------------------------------------------------------------

export interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

export interface SarifRegion {
  startLine: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region?: SarifRegion;
}

export interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
  message?: { text: string };
}

export interface SarifMultiformatMessageString {
  text: string;
  markdown?: string;
}

export interface SarifRuleProperties {
  tags?: string[];
  precision?: string;
  "security-severity"?: string;
  "problem.severity"?: string;
}

export interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: SarifMultiformatMessageString;
  fullDescription?: SarifMultiformatMessageString;
  help?: SarifMultiformatMessageString;
  helpUri?: string;
  properties?: SarifRuleProperties;
}

export interface SarifResult {
  ruleId: string;
  level?: "error" | "warning" | "note" | "none";
  message: { text: string };
  locations?: SarifLocation[];
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

export interface SarifDriver {
  name: string;
  version?: string;
  semanticVersion?: string;
  informationUri?: string;
  rules?: SarifRule[];
}

export interface SarifRun {
  tool: { driver: SarifDriver };
  results?: SarifResult[];
  originalUriBaseIds?: Record<string, { uri: string }>;
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

// ---------------------------------------------------------------------------
// GitHub API response types
// ---------------------------------------------------------------------------

export interface GitHubCodeScanningAlert {
  number: number;
  state: "open" | "dismissed" | "fixed";
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  dismissed_at?: string | null;
  dismissed_by?: { login: string } | null;
  rule: {
    id: string;
    name: string;
    severity: string | null;
    security_severity_level?: string | null;
    description: string;
    full_description?: string | null;
    tags?: string[];
    help?: string | null;
  };
  tool: { name: string; version?: string | null };
  most_recent_instance: GitHubAlertInstance;
  instances_url: string;
  html_url: string;
  url: string;
  created_at: string;
  updated_at: string;
  fixed_at?: string | null;
  auto_dismissed_at?: string | null;
}

export interface GitHubAlertInstance {
  ref?: string;
  state: string;
  commit_sha?: string;
  message?: { text: string };
  location?: {
    path: string;
    start_line: number;
    end_line?: number;
    start_column?: number;
    end_column?: number;
  };
  html_url?: string;
  classifications?: string[];
  environment?: string;
  analysis_key?: string;
}

export interface GitHubSarifUploadResponse {
  id: string;
  url: string;
}

export interface GitHubSarifStatusResponse {
  processing_status: "pending" | "complete" | "failed";
  analyses_url: string | null;
  errors: string[] | null;
}

export interface GitHubSecretScanningAlert {
  number: number;
  created_at: string;
  updated_at?: string;
  url: string;
  html_url: string;
  state: "open" | "resolved";
  resolution?: string | null;
  resolved_at?: string | null;
  resolved_by?: { login: string } | null;
  resolution_comment?: string | null;
  secret_type: string;
  secret_type_display_name?: string;
  // The secret field is intentionally omitted — we never expose it.
}

export interface GitHubDependabotAlert {
  number: number;
  state: "open" | "dismissed" | "fixed" | "auto_dismissed";
  dependency: {
    package: { ecosystem: string; name: string };
    manifest_path: string;
    scope?: string | null;
  };
  security_advisory: {
    ghsa_id: string;
    summary: string;
    description: string;
    severity: "low" | "medium" | "high" | "critical";
    cvss?: { score: number; vector_string: string } | null;
    cwe_ids?: string[];
    published_at: string;
    updated_at: string;
    withdrawn_at?: string | null;
  };
  security_vulnerability: {
    vulnerable_version_range: string;
    first_patched_version?: { identifier: string } | null;
  };
  url: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  dismissed_at?: string | null;
  dismissed_by?: { login: string } | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  fixed_at?: string | null;
  auto_dismissed_at?: string | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  url: string;
  user: { login: string } | null;
  labels: Array<{ name: string; color?: string }>;
  assignees?: Array<{ login: string }>;
  milestone?: { number: number; title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  comments: number;
  pull_request?: { url: string } | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  html_url: string;
  url: string;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string; repo?: { full_name: string } | null };
  user: { login: string } | null;
  requested_reviewers?: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GitHubAutofix {
  status: "pending" | "error" | "success";
  description?: string | null;
  start_time?: string | null;
  completion_time?: string | null;
  changes?: Array<{
    path: string;
    additions: number;
    deletions: number;
  }> | null;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  security_and_analysis?: {
    advanced_security?: { status: "enabled" | "disabled" };
    code_security_and_analysis?: { status: "enabled" | "disabled" };
    secret_scanning?: { status: "enabled" | "disabled" };
    secret_scanning_push_protection?: { status: "enabled" | "disabled" };
    dependabot_security_updates?: { status: "enabled" | "disabled" };
  } | null;
}

export interface GitHubRuleset {
  id: number;
  name: string;
  target?: string;
  enforcement: "disabled" | "evaluate" | "active";
  source_type?: string;
  conditions?: unknown;
  rules?: Array<{ type: string; parameters?: unknown }>;
}
