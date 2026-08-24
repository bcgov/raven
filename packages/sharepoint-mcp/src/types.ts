/** Site (web) metadata from /_api/web */
export interface SpoWeb {
  Title: string;
  Description?: string;
  ServerRelativeUrl: string;
  LastItemModifiedDate?: string;
}

/** Document library from /_api/web/lists (BaseTemplate 101) */
export interface SpoLibrary {
  Title: string;
  ItemCount: number;
  LastItemModifiedDate?: string;
  RootFolder?: { ServerRelativeUrl: string };
}

/** File entry from a folder listing or GetFileByServerRelativePath */
export interface SpoFile {
  Name: string;
  ServerRelativeUrl: string;
  /** SPO serializes Int64 as string in some odata modes — normalize with Number() */
  Length: string | number;
  TimeLastModified: string;
  UIVersionLabel?: string;
}

/** Sub-folder entry from a folder listing */
export interface SpoFolder {
  Name: string;
  ServerRelativeUrl: string;
  ItemCount: number;
}

export interface SpoFolderContents {
  files: SpoFile[];
  folders: SpoFolder[];
}

/** Single file metadata (get_file_info / pre-download checks) */
export interface SpoFileInfo {
  name: string;
  serverRelativeUrl: string;
  length: number;
  timeLastModified: string;
  versionLabel?: string;
  webUrl: string;
}

/** One parsed search result row */
export interface SearchHit {
  title: string;
  path: string;
  author?: string;
  modified?: string;
  summary?: string;
  fileType?: string;
  siteName?: string;
}

/** API error carrying the HTTP status so tools can word 403 vs 404 correctly. */
export class SpoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "SpoApiError";
  }
}
