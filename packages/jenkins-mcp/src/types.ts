export interface JenkinsParameter {
  name: string;
  value?: unknown;
}

export interface JenkinsAction {
  parameters?: JenkinsParameter[];
  parameterDefinitions?: JenkinsParameterDefinition[];
  causes?: Array<{
    shortDescription?: string;
    userId?: string;
    userName?: string;
  }>;
  [key: string]: unknown;
}

export interface JenkinsParameterDefinition {
  name: string;
  type?: string;
  description?: string | null;
  defaultParameterValue?: JenkinsParameter | null;
  choices?: string[];
}

export interface JenkinsControllerInfo {
  nodeName?: string;
  nodeDescription?: string;
  mode?: string;
  numExecutors?: number;
  quietingDown?: boolean;
  useCrumbs?: boolean;
  useSecurity?: boolean;
  version?: string;
}

export interface JenkinsBuildRef {
  number: number;
  url?: string;
}

export interface JenkinsBuild extends JenkinsBuildRef {
  actions?: JenkinsAction[];
  artifacts?: JenkinsArtifact[];
  building?: boolean;
  description?: string | null;
  displayName?: string;
  duration?: number;
  estimatedDuration?: number;
  fullDisplayName?: string;
  id?: string;
  keepLog?: boolean;
  result?: string | null;
  timestamp?: number;
  url?: string;
}

export interface JenkinsJob {
  name: string;
  fullName?: string;
  url?: string;
  color?: string;
  buildable?: boolean;
  inQueue?: boolean;
  description?: string | null;
  jobs?: JenkinsJob[];
  builds?: JenkinsBuildRef[];
  lastBuild?: JenkinsBuildRef | null;
  lastCompletedBuild?: JenkinsBuildRef | null;
  lastFailedBuild?: JenkinsBuildRef | null;
  lastStableBuild?: JenkinsBuildRef | null;
  lastSuccessfulBuild?: JenkinsBuildRef | null;
  lastUnstableBuild?: JenkinsBuildRef | null;
}

export interface JenkinsQueueItem {
  id: number;
  cancelled?: boolean;
  task?: {
    name?: string;
    fullName?: string;
    url?: string;
  };
  why?: string | null;
  blocked?: boolean;
  buildable?: boolean;
  stuck?: boolean;
  inQueueSince?: number;
  params?: string;
  actions?: JenkinsAction[];
  executable?: JenkinsBuildRef;
}

export interface JenkinsQueueResponse {
  items: JenkinsQueueItem[];
}

export interface JenkinsProgressiveConsole {
  text: string;
  nextStart: number;
  moreData: boolean;
}

export interface JenkinsArtifact {
  displayPath: string;
  fileName: string;
  relativePath: string;
}

export interface JenkinsArtifactDownload {
  bytes: Uint8Array;
  contentType?: string;
}

export interface JenkinsTestCase {
  className?: string;
  name: string;
  status?: string;
  duration?: number;
  age?: number;
  errorDetails?: string | null;
  errorStackTrace?: string | null;
}

export interface JenkinsTestSuite {
  name?: string;
  duration?: number;
  cases?: JenkinsTestCase[];
}

export interface JenkinsTestReport {
  failCount: number;
  skipCount: number;
  passCount: number;
  totalCount?: number;
  duration?: number;
  suites?: JenkinsTestSuite[];
}

export interface JenkinsChange {
  id?: string;
  msg?: string;
  timestamp?: number;
  author?: {
    fullName?: string;
    absoluteUrl?: string;
  };
  affectedPaths?: string[];
}

export interface JenkinsChangeSet {
  kind?: string;
  items: JenkinsChange[];
}

export interface JenkinsPromotionProcess {
  name: string;
  url?: string;
  displayName?: string;
  description?: string | null;
  buildable?: boolean;
  inQueue?: boolean;
  lastBuild?: JenkinsBuildRef | null;
}

export interface JenkinsPromotionStatus {
  name?: string;
  timestamp?: number;
  manuallyApproved?: boolean;
  promotionAttempted?: boolean;
  promotionSuccessful?: boolean;
  lastAnError?: boolean | null;
  promotionBuilds?: JenkinsBuildRef[];
  [key: string]: unknown;
}

export interface JenkinsCredentialMetadata {
  id: string;
  displayName?: string;
  description?: string;
  typeName?: string;
}

export interface JenkinsAgent {
  displayName: string;
  offline: boolean;
  temporarilyOffline?: boolean;
  idle?: boolean;
  numExecutors?: number;
  assignedLabels?: Array<{ name: string }>;
  monitorData?: Record<string, unknown>;
}

export interface JenkinsPlugin {
  shortName: string;
  longName?: string;
  version?: string;
  enabled?: boolean;
  active?: boolean;
  hasUpdate?: boolean;
}
