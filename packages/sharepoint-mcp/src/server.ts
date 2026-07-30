import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SpoSessionManager, createSpoFetch, PiScrubber } from "@nrs/auth";
import { SharePointClient } from "./sharepoint-client.js";
import { SpoApiError, type SearchHit } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

const DEFAULT_SITE = process.env["SHAREPOINT_DEFAULT_SITE"] ?? "";

const sitePathSchema = z
  .string()
  .default(DEFAULT_SITE)
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

  return server;
}
