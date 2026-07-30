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
      `/ListItemAllFields?$select=Title,CanvasContent1`;
    const item = await this.getJson<{ Title?: string; CanvasContent1?: string }>(url);
    return { title: item.Title ?? "", canvasContent: item.CanvasContent1 ?? "" };
  }

  get root(): string {
    return this.baseUrl;
  }
}
