export interface SonarIssue {
  key: string;
  rule: string;
  severity: "INFO" | "MINOR" | "MAJOR" | "CRITICAL" | "BLOCKER";
  type: "BUG" | "VULNERABILITY" | "CODE_SMELL";
  component: string;
  line?: number;
  message: string;
  status: string;
  resolution?: string;
  effort?: string;
  tags?: string[];
  creationDate: string;
  updateDate: string;
}

export interface SonarIssuesPage {
  total: number;
  p: number;
  ps: number;
  issues: SonarIssue[];
  paging?: { pageIndex: number; pageSize: number; total: number };
}

export interface SonarQualityGateCondition {
  status: "OK" | "WARN" | "ERROR" | "NO_VALUE";
  metricKey: string;
  comparator: string;
  errorThreshold?: string;
  actualValue?: string;
}

export interface SonarQualityGateStatus {
  projectStatus: {
    status: "OK" | "WARN" | "ERROR" | "NONE";
    ignoredConditions?: boolean;
    conditions: SonarQualityGateCondition[];
    periods?: Array<{ index: number; mode: string; date: string }>;
  };
}

export interface SonarHotspot {
  key: string;
  component: string;
  project: string;
  securityCategory: string;
  vulnerabilityProbability: "HIGH" | "MEDIUM" | "LOW";
  status: "TO_REVIEW" | "REVIEWED";
  resolution?: "FIXED" | "SAFE" | "ACKNOWLEDGED";
  line?: number;
  message: string;
  creationDate: string;
  updateDate: string;
}

export interface SonarHotspotsPage {
  paging: { pageIndex: number; pageSize: number; total: number };
  hotspots: SonarHotspot[];
}

export interface SonarMeasure {
  metric: string;
  value?: string;
  bestValue?: boolean;
  period?: { index: number; value: string; bestValue?: boolean };
}

export interface SonarComponentMeasures {
  component: {
    key: string;
    name: string;
    qualifier: string;
    visibility?: "public" | "private";
    language?: string;
    tags?: string[];
    measures: SonarMeasure[];
  };
  periods?: Array<{ index: number; mode: string; date: string; parameter?: string }>;
}

export interface SonarAnalysis {
  key: string;
  date: string;
  projectVersion?: string;
  buildString?: string;
  manualNewCodePeriodBaseline?: boolean;
  events?: Array<{ key: string; category: string; name: string; description?: string }>;
}

export interface SonarAnalysesPage {
  paging: { pageIndex: number; pageSize: number; total: number };
  analyses: SonarAnalysis[];
}