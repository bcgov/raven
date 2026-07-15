export type RfcChangeStatus = "New" | "Changed" | "Unchanged";

export interface RfcResult {
  rfcNumber: string;
  approvalStatus: string;
  platform: string;
  assetTags: string;
  startDateUtc: string;
  endDateUtc: string;
  description: string;
  riskAssessment: string;
  changeStatus: RfcChangeStatus | number;
}

export interface RfcSearchRequest {
  includeKeywords: string[];
  ignoreKeywords?: string[];
}

export interface RfcSearchResponse {
  generatedAtUtc: string;
  totalMatched: number;
  rfcs: RfcResult[];
}
