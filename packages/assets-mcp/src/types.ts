/** Value within an asset attribute — can be text, number, reference, etc. */
export interface AssetAttributeValue {
  value: unknown;
  displayValue: string;
  referencedObject?: {
    id: number;
    label: string;
    objectKey: string;
    objectType: { id: number; name: string };
  };
}

/** Single attribute on an asset object */
export interface AssetAttribute {
  id: number;
  objectTypeAttributeId: number;
  objectAttributeValues: AssetAttributeValue[];
  objectTypeAttribute?: {
    id: number;
    name: string;
    type: number;
    description?: string;
  };
}

/** Object type metadata */
export interface AssetObjectType {
  id: number;
  name: string;
  description?: string;
  parentObjectTypeId?: number;
  objectSchemaId: number;
  objectCount?: number;
}

/** Top-level asset object */
export interface AssetObject {
  id: number;
  label: string;
  objectKey: string;
  objectType: AssetObjectType;
  created: string;
  updated: string;
  attributes: AssetAttribute[];
  /** URL to view in Jira (constructed) */
  _url?: string;
}

/** Response from AQL search */
export interface AqlSearchResponse {
  objectEntries: AssetObject[];
  totalFilterCount: number;
  startIndex: number;
  toIndex: number;
  pageNumber: number;
  pageSize: number;
  iqlSearchResult: boolean;
  objectTypeAttributes?: Array<{
    id: number;
    name: string;
    type: number;
  }>;
}

/** Schema metadata */
export interface AssetSchema {
  id: number;
  name: string;
  objectSchemaKey: string;
  description?: string;
  objectCount?: number;
  objectTypeCount?: number;
}

/** History entry for an object */
export interface AssetHistoryEntry {
  id: number;
  affectedAttribute: string;
  oldValue: string;
  newValue: string;
  actor: { name: string; displayName: string };
  created: string;
  type: number;
}

/** Connected Jira ticket */
export interface AssetConnectedTicket {
  key: string;
  summary: string;
  status: string;
  type: string;
  priority?: string;
}
