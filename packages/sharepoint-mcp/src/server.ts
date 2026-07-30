import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpoSessionManager, createSpoFetch, PiScrubber, classifyAttachment, decodeUtf8, extractPdfText, sanitizeFilename } from "@nrs/auth";
import { SharePointClient } from "./sharepoint-client.js";
import { SpoApiError, type SearchHit } from "./types.js";
import { extractDocxMarkdown } from "./extractors/docx.js";
import { extractPageMarkdown } from "./extractors/page-canvas.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// Same default as packages/artifactory-mcp/src/server.ts's DEFAULT_MAX_TRANSFER_BYTES.
const MAX_DOWNLOAD_BYTES_DEFAULT = 512 * 1024 * 1024;

const sitePathSchema = z
  .string()
  .default(() => process.env["SHAREPOINT_DEFAULT_SITE"] ?? "")
  .describe(
    'Server-relative site path, e.g. "/sites/MyProject" or "/teams/MyTeam". ' +
      "Empty string for the tenant root site. Defaults to SHAREPOINT_DEFAULT_SITE when configured."
  )
  .refine((v) => v === "" || v.startsWith("/"), {
    message: "sitePath must be empty or start with '/'",
  });

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One search hit as a numbered markdown block. */
export function formatSearchHit(hit: SearchHit, index: number): string {
  const meta: string[] = [];
  if (hit.fileType) meta.push(hit.fileType);
  if (hit.author) meta.push(`by ${hit.author}`);
  if (hit.modified) meta.push(`modified ${hit.modified.slice(0, 10)}`);
  const lines = [
    `${index + 1}. **${hit.title}**${meta.length ? ` (${meta.join(", ")})` : ""}`,
    `   ${hit.path}`,
  ];
  if (hit.summary) lines.push(`   > ${hit.summary}`);
  return lines.join("\n");
}

/** Word SPO failures accurately: 403 = permissions, 404 = wrong path. */
export function describeSpoError(err: unknown): string {
  if (err instanceof SpoApiError) {
    if (err.status === 403) {
      return "You don't have access to this site or file (permission-trimmed search can list items you cannot open). (403)";
    }
    if (err.status === 404) {
      return "Not found — check the site/path. (404)";
    }
  }
  return safeErr(err);
}

/** Cap text output with an explicit truncation notice. */
export function truncateText(text: string, cap: number = MAX_TEXT_CHARS): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n\n[truncated — showing ${cap} of ${text.length} characters]`
  );
}

const EXT_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/plain",
  json: "text/plain",
  xml: "text/plain",
  yml: "text/plain",
  yaml: "text/plain",
};

/** SPO file metadata carries no MIME type — derive one from the extension. */
export function mimeFromExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

let client: SharePointClient | null = null;

async function getClient(): Promise<SharePointClient> {
  if (!client) {
    const sessionManager = new SpoSessionManager();
    const spoFetch = await createSpoFetch(sessionManager);
    client = new SharePointClient(spoFetch, sessionManager.targetUrl);
  }
  return client;
}

/** Create the RAVEN SharePoint MCP server. */
export function createSharePointServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN SharePoint",
      version: "0.1.0",
    },
    {
      instructions: `You have access to read-only tools for searching and reading BC Gov SharePoint Online content: project documentation, design documents, architecture diagrams, requirements, and mock-up screens stored in document libraries and site pages. All tools are READ-ONLY — never attempt to create, modify, or delete SharePoint content. The expected workflow is: search_sharepoint first (or list_sites/get_site/list_folder to browse), then read_document or read_page on the most relevant results, then summarize for the user. Always include the SharePoint URL when referencing results. Results are permission-trimmed: the user only sees content their IDIR account can access; a 403 on a specific item means they lack access to it, not that authentication failed. Keep API calls to a minimum — SharePoint Online throttles aggressively. Never call the same tool twice with the same arguments. If you encounter authentication errors ("No valid SharePoint session"), tell the user to run: node packages/auth/dist/cli.js --sharepoint (or npx raven-auth --sharepoint), or to set SPO_FEDAUTH and SPO_RTFA environment variables. NOTE: inlined image content (diagrams, mock-ups, screenshots) may contain personal information visible to the AI and cannot be PI-scrubbed.`,
    }
  );

  server.tool(
    "search_sharepoint",
    `Search BC Gov SharePoint Online by keyword, phrase, or KQL query.

Searches everything the logged-in user can see (documents, pages, sites),
ranked by relevance, with hit-highlighted snippets. Use read_document or
read_page on the most relevant result paths to get full content, then
summarize. Supports KQL operators (AND, OR, quotes, property:value).
Always include the full SharePoint URL when referencing results.`,
    {
      query: z.string().describe("Search text or KQL query"),
      sitePath: sitePathSchema.optional().describe('Optional: restrict to one site, e.g. "/sites/MyProject"'),
      fileType: z.string().optional().describe('Optional file type filter, e.g. "docx", "pdf", "pptx", "aspx"'),
      limit: z
        .number()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Maximum results (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`),
    },
    { readOnlyHint: true },
    async ({ query, sitePath, fileType, limit }) => {
      try {
        const spo = await getClient();
        const { hits, totalRows } = await spo.search(query, {
          rowLimit: limit,
          sitePath: sitePath || undefined,
          fileType,
        });
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(`No results for '${query}'. Permission-trimming applies — content you cannot access is never listed.`),
              },
            ],
          };
        }
        const body = hits.map((hit, i) => formatSearchHit(hit, i)).join("\n\n");
        const text = `Found ${totalRows} results for '${query}' (showing ${hits.length}):\n\n${body}\n\nUse read_document (files) or read_page (.aspx pages) with a site path + server-relative path to get full content.`;
        return { content: [{ type: "text", text: pi.scrubText(text) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search error: ${describeSpoError(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_sites",
    `Find SharePoint sites by name or keyword.

Runs a site-scoped search (contentclass:STS_Site) across everything the user
can see. Returns site titles, URLs, and descriptions. Use get_site with a
site's server-relative path (e.g. "/sites/MyProject") to see its document
libraries.`,
    {
      query: z.string().describe("Site name or keyword to search for"),
      limit: z
        .number()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Maximum results (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`),
    },
    { readOnlyHint: true },
    async ({ query, limit }) => {
      try {
        const spo = await getClient();
        const { hits } = await spo.search(`contentclass:STS_Site ${query}`, { rowLimit: limit });
        if (hits.length === 0) {
          return { content: [{ type: "text", text: pi.scrubText(`No sites found matching '${query}'.`) }] };
        }
        const body = hits.map((hit, i) => formatSearchHit(hit, i)).join("\n\n");
        return { content: [{ type: "text", text: pi.scrubText(`Sites matching '${query}':\n\n${body}`) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `list_sites error: ${describeSpoError(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_site",
    `Get a SharePoint site's metadata and its document libraries.

Returns the site title, description, and each visible document library with
its item count and root folder path — use those folder paths with
list_folder to browse.`,
    { sitePath: sitePathSchema },
    { readOnlyHint: true },
    async ({ sitePath }) => {
      try {
        const spo = await getClient();
        const [web, libs] = await Promise.all([
          spo.getWeb(sitePath),
          spo.listDocumentLibraries(sitePath),
        ]);
        const libLines = libs.map(
          (l) =>
            `- **${l.Title}** (${l.ItemCount} items)${l.RootFolder ? ` — folder: ${l.RootFolder.ServerRelativeUrl}` : ""}`
        );
        const text = [
          `# ${web.Title}`,
          web.Description ? web.Description : "",
          ``,
          `Site path: ${web.ServerRelativeUrl}`,
          web.LastItemModifiedDate ? `Last modified: ${web.LastItemModifiedDate}` : "",
          ``,
          `## Document libraries`,
          ...(libLines.length ? libLines : ["(none visible)"]),
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text", text: pi.scrubText(text) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `get_site error: ${describeSpoError(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_folder",
    `List the files and sub-folders of a SharePoint document library folder.

folderPath is the server-relative path from get_site (e.g.
"/sites/MyProject/Shared Documents" or a sub-folder of it). Returns file
names, sizes, and modified dates plus sub-folder item counts.`,
    {
      sitePath: sitePathSchema,
      folderPath: z
        .string()
        .describe(
          'Server-relative folder path, e.g. "/sites/MyProject/Shared Documents/Designs"'
        ),
    },
    { readOnlyHint: true },
    async ({ sitePath, folderPath }) => {
      try {
        const spo = await getClient();
        const { files, folders } = await spo.listFolder(sitePath, folderPath);
        const folderLines = folders.map(
          (f) =>
            `- 📁 **${f.Name}/** (${f.ItemCount} items) — ${f.ServerRelativeUrl}`
        );
        const fileLines = files.map(
          (f) =>
            `- ${f.Name} (${formatBytes(Number(f.Length))}, modified ${f.TimeLastModified.slice(0, 10)}) — ${f.ServerRelativeUrl}`
        );
        const text = [
          `Contents of ${folderPath}:`,
          ``,
          ...(folderLines.length ? folderLines : []),
          ...(fileLines.length ? fileLines : []),
          ...(folderLines.length + fileLines.length === 0 ? ["(empty folder)"] : []),
          ``,
          `Use read_document with a file's server-relative path to read it.`,
        ].join("\n");
        return { content: [{ type: "text", text: pi.scrubText(text) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `list_folder error: ${describeSpoError(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_file_info",
    `Get metadata for a single SharePoint file: size, modified date, version, and URL. Use before read_document to check whether a large file is worth reading inline.`,
    {
      sitePath: sitePathSchema,
      filePath: z.string().describe('Server-relative file path, e.g. "/sites/MyProject/Shared Documents/design.docx"'),
    },
    { readOnlyHint: true },
    async ({ sitePath, filePath }) => {
      try {
        const spo = await getClient();
        const info = await spo.getFileInfo(sitePath, filePath);
        const text = [
          `**${info.name}**`,
          `- Size: ${formatBytes(info.length)}`,
          `- Modified: ${info.timeLastModified}`,
          info.versionLabel ? `- Version: ${info.versionLabel}` : "",
          `- URL: ${info.webUrl}`,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: pi.scrubText(text) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `get_file_info error: ${describeSpoError(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_document",
    `Read a SharePoint file's content directly in the tool result.

Word documents (.docx) come back as markdown, PDFs as extracted text, plain
text/markdown/CSV/JSON verbatim, and images (png/jpg/gif — diagrams, mock-ups)
as the image itself. Files over 10 MB (2 MB for images) and other formats
(xlsx, pptx, vsd, ...) are not readable inline — use download_file for those.
NOTE: inlined image content may contain personal information visible to the AI
and cannot be PI-scrubbed.`,
    {
      sitePath: sitePathSchema,
      filePath: z.string().describe('Server-relative file path, e.g. "/sites/MyProject/Shared Documents/design.docx"'),
    },
    { readOnlyHint: true },
    async ({ sitePath, filePath }) => {
      try {
        const spo = await getClient();
        const info = await spo.getFileInfo(sitePath, filePath);
        if (info.length > MAX_FETCH_BYTES) {
          return {
            content: [{ type: "text", text: pi.scrubText(`File is ${formatBytes(info.length)} — larger than the ${formatBytes(MAX_FETCH_BYTES)} inline limit. It is viewable at: ${info.webUrl}`) }],
            isError: true,
          };
        }

        const mime = mimeFromExtension(info.name);
        const kind = classifyAttachment(mime, info.name);
        // classifyAttachment doesn't know docx (it reports "other" for the
        // OOXML MIME type) — route on the extension before the early return.
        const isDocx = info.name.toLowerCase().endsWith(".docx");
        if (kind === "other" && !isDocx) {
          return {
            content: [{ type: "text", text: pi.scrubText(`No inline reader for '${info.name}' (${mime}). Use download_file to save it locally, or view it at: ${info.webUrl}`) }],
            isError: true,
          };
        }
        if (kind === "image" && info.length > MAX_IMAGE_BYTES) {
          return {
            content: [{ type: "text", text: pi.scrubText(`Image is ${formatBytes(info.length)} — larger than the ${formatBytes(MAX_IMAGE_BYTES)} inline limit. Use download_file, or view it at: ${info.webUrl}`) }],
            isError: true,
          };
        }

        const bytes = await spo.downloadFile(sitePath, filePath);
        const header = `**${info.name}** (${formatBytes(info.length)}, modified ${info.timeLastModified.slice(0, 10)}) — ${info.webUrl}\n\n`;

        if (kind === "image") {
          return {
            content: [
              { type: "text", text: pi.scrubText(header.trim()) },
              { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime },
            ],
          };
        }

        let text: string;
        if (isDocx) {
          text = await extractDocxMarkdown(bytes);
        } else if (kind === "pdf") {
          text = await extractPdfText(bytes);
          if (!text.trim()) text = "(PDF contained no extractable text — it may be a scanned image.)";
        } else {
          text = decodeUtf8(bytes);
        }

        return { content: [{ type: "text", text: pi.scrubText(header) + truncateText(pi.scrubText(text)) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read_document error: ${describeSpoError(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_page",
    `Read a modern SharePoint site page (.aspx) as markdown.

Extracts the text-webpart content of pages in a Site Pages library (knowledge
articles, decisions, wiki-style pages). Embedded webparts (video, lists,
Power BI, ...) are omitted. If the page has no extractable text you get a link
to view it instead.`,
    {
      sitePath: sitePathSchema,
      pagePath: z
        .string()
        .refine((v) => v.toLowerCase().endsWith(".aspx"), { message: "pagePath must end in .aspx" })
        .describe('Server-relative page path, e.g. "/sites/MyProject/SitePages/Architecture-Decisions.aspx"'),
    },
    { readOnlyHint: true },
    async ({ sitePath, pagePath }) => {
      try {
        const spo = await getClient();
        const { title, canvasContent } = await spo.getPageCanvasContent(sitePath, pagePath);
        const webUrl = `${spo.root}${pagePath}`;
        const md = extractPageMarkdown(canvasContent);
        if (!md) {
          return { content: [{ type: "text", text: pi.scrubText(`This page has no extractable text (or an unsupported layout). View it directly: ${webUrl}`) }] };
        }
        const text = `# ${title || pagePath}\n\n${md}\n\n---\nSource: ${webUrl}`;
        return { content: [{ type: "text", text: truncateText(pi.scrubText(text)) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read_page error: ${describeSpoError(err)}` }], isError: true };
      }
    }
  );

  server.tool(
    "download_file",
    `Download a SharePoint file to the local protected download directory
(RAVEN_SHAREPOINT_DOWNLOAD_DIR, default ~/.raven/sharepoint-downloads).

Use for formats read_document cannot show inline (xlsx, pptx, vsd, zip, large
files) or when the user wants the actual file. Files over 512 MB by default
(RAVEN_SHAREPOINT_MAX_DOWNLOAD_BYTES) are rejected rather than downloaded.
Returns the saved path.`,
    {
      sitePath: sitePathSchema,
      filePath: z.string().describe("Server-relative file path"),
    },
    { readOnlyHint: true },
    async ({ sitePath, filePath }) => {
      try {
        const spo = await getClient();
        const info = await spo.getFileInfo(sitePath, filePath);

        const maxDownload =
          Number(process.env["RAVEN_SHAREPOINT_MAX_DOWNLOAD_BYTES"]) || MAX_DOWNLOAD_BYTES_DEFAULT;
        if (info.length > maxDownload) {
          return {
            content: [
              {
                type: "text",
                text: pi.scrubText(
                  `File is ${formatBytes(info.length)} — larger than the ${formatBytes(maxDownload)} download limit (RAVEN_SHAREPOINT_MAX_DOWNLOAD_BYTES). View it at: ${info.webUrl}`
                ),
              },
            ],
            isError: true,
          };
        }

        const bytes = await spo.downloadFile(sitePath, filePath);

        const dir =
          process.env["RAVEN_SHAREPOINT_DOWNLOAD_DIR"] ??
          join(homedir(), ".raven", "sharepoint-downloads");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const target = join(dir, sanitizeFilename(info.name));
        await writeFile(target, bytes);

        return {
          content: [{ type: "text", text: pi.scrubText(`Saved **${info.name}** (${formatBytes(bytes.length)}) to ${target}`) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `download_file error: ${describeSpoError(err)}` }], isError: true };
      }
    }
  );

  return server;
}
