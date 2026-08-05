import type { AuthenticatedFetch } from "@nrs/auth";
import {
  SpoApiError,
  type SpoWeb,
  type SpoLibrary,
  type SpoFile,
  type SpoFolder,
  type SpoFolderContents,
  type SpoFileInfo,
  type SearchHit,
} from "./types.js";

const DEFAULT_BASE_URL =
  process.env["SHAREPOINT_URL"] ?? "https://example.sharepoint.com";

const JSON_ACCEPT = "application/json;odata=nometadata";

/** Double single quotes so a server-relative path is a valid OData string literal. */
export function escapeODataPath(path: string): string {
  return path.replace(/'/g, "''");
}

const SEARCH_PROPERTIES =
  "Title,Path,Author,LastModifiedTime,HitHighlightedSummary,FileType,SiteName";

/** Strip SPO hit-highlighting markup: <c0>..</c0> emphasis and <ddd/> ellipses. */
export function cleanSummary(raw: string): string {
  return raw
    .replace(/<c\d+>/g, "")
    .replace(/<\/c\d+>/g, "")
    .replace(/<ddd\s*\/>/g, "…")
    .trim();
}

/** Parse the /_api/search/query JSON into flat SearchHit records. */
export function parseSearchResults(json: unknown): { hits: SearchHit[]; totalRows: number } {
  const relevant = (json as {
    PrimaryQueryResult?: {
      RelevantResults?: {
        TotalRows?: number;
        Table?: { Rows?: Array<{ Cells?: Array<{ Key?: string; Value?: string | null }> }> };
      };
    };
  }).PrimaryQueryResult?.RelevantResults;

  const rows = relevant?.Table?.Rows ?? [];
  const hits: SearchHit[] = rows.map((row) => {
    const cells = new Map<string, string>();
    for (const cell of row.Cells ?? []) {
      if (cell.Key && cell.Value != null) cells.set(cell.Key, String(cell.Value));
    }
    const summary = cells.get("HitHighlightedSummary");
    return {
      title: cells.get("Title") ?? "(untitled)",
      path: cells.get("Path") ?? "",
      author: cells.get("Author"),
      modified: cells.get("LastModifiedTime"),
      summary: summary ? cleanSummary(summary) : undefined,
      fileType: cells.get("FileType"),
      siteName: cells.get("SiteName"),
    };
  });

  return { hits, totalRows: relevant?.TotalRows ?? hits.length };
}

/**
 * REST client for SharePoint Online (site-scoped /_api endpoints + tenant
 * search). Auth (FedAuth/rtFa cookies today, Graph bearer later) is baked
 * into the injected AuthenticatedFetch.
 */
export class SharePointClient {
  private baseUrl: string;
  private fetch: AuthenticatedFetch;

  constructor(fetch: AuthenticatedFetch, baseUrl?: string) {
    this.fetch = fetch;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async getJson<T>(url: string): Promise<T> {
    const resp = await this.fetch(url, {
      headers: { Accept: JSON_ACCEPT },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new SpoApiError(
        `SharePoint request failed (${resp.status}): ${body.slice(0, 300)}`,
        resp.status
      );
    }
    return (await resp.json()) as T;
  }

  /** Site (web) metadata. sitePath is "" for the root site or "/sites/Name". */
  async getWeb(sitePath: string): Promise<SpoWeb> {
    return this.getJson<SpoWeb>(
      `${this.baseUrl}${sitePath}/_api/web?$select=Title,Description,ServerRelativeUrl,LastItemModifiedDate`
    );
  }

  /** Visible document libraries (BaseTemplate 101) in a site. */
  async listDocumentLibraries(sitePath: string): Promise<SpoLibrary[]> {
    const params = new URLSearchParams({
      $filter: "BaseTemplate eq 101 and Hidden eq false",
      $select: "Title,ItemCount,LastItemModifiedDate,RootFolder/ServerRelativeUrl",
      $expand: "RootFolder",
    });
    const data = await this.getJson<{ value: SpoLibrary[] }>(
      `${this.baseUrl}${sitePath}/_api/web/lists?${params}`
    );
    return data.value;
  }

  /** Files and sub-folders of a folder, by server-relative folder path. */
  async listFolder(sitePath: string, folderPath: string): Promise<SpoFolderContents> {
    const params = new URLSearchParams({
      $expand: "Files,Folders",
      $select:
        "Files/Name,Files/ServerRelativeUrl,Files/Length,Files/TimeLastModified," +
        "Folders/Name,Folders/ServerRelativeUrl,Folders/ItemCount",
    });
    const url =
      `${this.baseUrl}${sitePath}/_api/web/GetFolderByServerRelativePath(` +
      `decodedurl='${encodeURIComponent(escapeODataPath(folderPath))}')?${params}`;
    const data = await this.getJson<{ Files?: SpoFile[]; Folders?: SpoFolder[] }>(url);
    return { files: data.Files ?? [], folders: data.Folders ?? [] };
  }

  /** Metadata for a single file, by server-relative file path. */
  async getFileInfo(sitePath: string, filePath: string): Promise<SpoFileInfo> {
    const url =
      `${this.baseUrl}${sitePath}/_api/web/GetFileByServerRelativePath(` +
      `decodedurl='${encodeURIComponent(escapeODataPath(filePath))}')` +
      `?$select=Name,ServerRelativeUrl,Length,TimeLastModified,UIVersionLabel`;
    const f = await this.getJson<SpoFile>(url);
    return {
      name: f.Name,
      serverRelativeUrl: f.ServerRelativeUrl,
      length: Number(f.Length),
      timeLastModified: f.TimeLastModified,
      versionLabel: f.UIVersionLabel,
      webUrl: `${this.baseUrl}${f.ServerRelativeUrl}`,
    };
  }

  /** Raw file bytes via /$value. Callers enforce size caps BEFORE calling. */
  async downloadFile(sitePath: string, filePath: string): Promise<Uint8Array> {
    const url =
      `${this.baseUrl}${sitePath}/_api/web/GetFileByServerRelativePath(` +
      `decodedurl='${encodeURIComponent(escapeODataPath(filePath))}')/$value`;
    const resp = await this.fetch(url);
    if (!resp.ok) {
      throw new SpoApiError(
        `SharePoint download failed (${resp.status})`,
        resp.status
      );
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** Title + CanvasContent1 markup for a modern site page (.aspx). */
  async getPageCanvasContent(
    sitePath: string,
    pagePath: string
  ): Promise<{ title: string; canvasContent: string }> {
    const url =
      `${this.baseUrl}${sitePath}/_api/web/GetFileByServerRelativePath(` +
      `decodedurl='${encodeURIComponent(escapeODataPath(pagePath))}')` +
      `/ListItemAllFields?$select=Title,CanvasContent1,WikiField`;
    const item = await this.getJson<{
      Title?: string | null;
      CanvasContent1?: string | null;
      WikiField?: string | null;
    }>(url);
    // Classic wiki-format Site Pages have null CanvasContent1 with the body
    // HTML in WikiField; both are plain HTML the extractor can convert.
    const canvas = item.CanvasContent1?.trim()
      ? item.CanvasContent1
      : (item.WikiField ?? "");
    return { title: item.Title ?? "", canvasContent: canvas };
  }

  /**
   * Tenant-wide KQL search, permission-trimmed to what the user can see.
   * Optional scoping: sitePath restricts via Path:"…*", fileType via FileType:.
   */
  async search(
    queryText: string,
    opts?: { rowLimit?: number; sitePath?: string; fileType?: string }
  ): Promise<{ hits: SearchHit[]; totalRows: number }> {
    const clauses = [queryText];
    if (opts?.sitePath) clauses.push(`Path:"${this.baseUrl}${opts.sitePath}*"`);
    if (opts?.fileType) clauses.push(`FileType:${opts.fileType}`);
    const kql = clauses.join(" ").replace(/'/g, "''");

    const url =
      `${this.baseUrl}/_api/search/query` +
      `?querytext='${encodeURIComponent(kql)}'` +
      `&rowlimit=${opts?.rowLimit ?? 10}` +
      `&selectproperties='${encodeURIComponent(SEARCH_PROPERTIES)}'` +
      `&trimduplicates=true`;

    const json = await this.getJson<unknown>(url);
    return parseSearchResults(json);
  }

  get root(): string {
    return this.baseUrl;
  }
}
