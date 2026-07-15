export interface ArtifactoryVersion {
  version: string;
  revision?: string;
  addons?: string[];
  license?: string;
}

export interface ArtifactoryRepository {
  key: string;
  type: "LOCAL" | "REMOTE" | "VIRTUAL" | string;
  description?: string;
  url?: string;
  packageType?: string;
}

export interface ArtifactoryChecksums {
  md5?: string;
  sha1?: string;
  sha256?: string;
}

export interface ArtifactoryItemInfo {
  repo: string;
  path: string;
  uri?: string;
  downloadUri?: string;
  created?: string;
  createdBy?: string;
  lastModified?: string;
  modifiedBy?: string;
  size?: string;
  mimeType?: string;
  checksums?: ArtifactoryChecksums;
  originalChecksums?: ArtifactoryChecksums;
  children?: Array<{ uri: string; folder: boolean }>;
}

export interface ArtifactoryFolderList {
  uri?: string;
  created?: string;
  files: Array<{
    uri: string;
    size?: number;
    lastModified?: string;
    folder?: boolean;
    sha1?: string;
    sha2?: string;
  }>;
}

export interface ArtifactorySearchResult {
  results: Array<Record<string, unknown>>;
  range?: { start_pos?: number; end_pos?: number; total?: number };
}

export interface ArtifactoryItemSearch {
  repository: string;
  pathPattern?: string;
  namePattern?: string;
  type?: "file" | "folder" | "any";
  properties?: Record<string, string>;
  limit?: number;
  offset?: number;
}
