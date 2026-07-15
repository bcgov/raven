import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager, createAuthenticatedFetch, createBasicAuthFetch, PiScrubber, authCliPath } from "@nrs/auth";
import { ConfluenceClient } from "./confluence-client.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { markdownToHtml } from "./markdown-to-html.js";
import { parsePageId } from "./page-id.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { homedir } from "node:os";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const READ_PAGES_CAP = 10;
/** Upload cap. Confluence default is 100 MB; mirror it here so we fail
 *  fast rather than waiting for a server-side rejection. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Defense-in-depth blocklist for `upload_attachment` source paths. The MCP
 * server runs locally with the user's credentials, so it can read anything
 * the user can — including secrets. Refuse to read from these locations and
 * file extensions even when the caller asks. Not a substitute for user
 * judgement (the tool always requires confirmation), but it removes the
 * obvious prompt-injection vectors.
 */
const SENSITIVE_PATH_PREFIXES = [".ssh", ".aws", ".gnupg", ".kube", ".raven"];
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".env", ".p12", ".pfx", ".jks"];
const SENSITIVE_BASENAMES = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials"];

function isSensitivePath(absPath: string): string | null {
  const lower = absPath.toLowerCase();
  const base = basename(lower);
  if (SENSITIVE_BASENAMES.includes(base)) return `basename '${base}' is on the blocklist`;
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (base.endsWith(ext)) return `extension '${ext}' is on the blocklist`;
  }
  const home = homedir().toLowerCase();
  if (lower.startsWith(home + sep)) {
    const rel = lower.slice(home.length + 1);
    for (const dir of SENSITIVE_PATH_PREFIXES) {
      if (rel === dir || rel.startsWith(dir + sep)) {
        return `path is under ~/${dir}`;
      }
    }
  }
  return null;
}
const CONFLUENCE_BASE_URL =
  process.env["CONFLUENCE_URL"] ??
  (process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/confluence`
    : "https://apps.example.gov.bc.ca/int/confluence");

// ---------------------------------------------------------------------------
// Scoring & Ranking
// Ported from chat.py score_page() — tuned for Confluence page relevance.
// ---------------------------------------------------------------------------

/** Days since a date string (ISO format). */
function daysAgo(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  try {
    return Math.floor(
      (Date.now() - new Date(dateStr).getTime()) / 86_400_000
    );
  } catch {
    return null;
  }
}

/** Human-readable age label. */
function ageLabel(days: number | null): string {
  if (days === null) return "Unknown age";
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}yr ago`;
}

/** Age tier tag for grouping. */
function ageTier(days: number | null): string {
  if (days === null) return "Unknown";
  if (days < 365) return "Current";
  if (days < 365 * 3) return "Recent";
  return "Outdated";
}

/**
 * Composite relevance score for a Confluence page (0–100).
 *
 * Factors (adapted from chat.py score_page):
 *   Recency         40 pts — exponential decay from last update
 *   Search rank     30 pts — position in Confluence's CQL result order
 *   Content signal  20 pts — excerpt presence and length (proxy for richness)
 *   Title match     10 pts — bonus if query terms appear in title
 */
function scorePage(
  result: import("./types.js").ConfluenceSearchResult,
  searchRank: number,
  totalResults: number,
  queryTerms: string[]
): number {
  let score = 0;
  const content = result.content;

  // Recency (40 pts) — pages go stale faster than issues
  const lastUpdated = content.history?.lastUpdated?.when;
  const age = daysAgo(lastUpdated);
  if (age !== null) {
    if (age <= 30) score += 40;
    else if (age <= 90) score += 37 - (age - 30) * 0.05;
    else if (age <= 365) score += 33 - (age - 90) * 0.025;
    else if (age <= 365 * 3) score += 25 - (age - 365) * 0.01;
    else score += Math.max(3, 15 - (age - 365 * 3) * 0.005);
  } else {
    score += 10; // unknown → neutral
  }

  // Search rank (30 pts) — Confluence CQL relevance is strong
  score += Math.max(
    0,
    30 - searchRank * (30 / Math.max(totalResults, 1))
  );

  // Content signal (20 pts) — excerpt as proxy for richness
  const excerptLen = (result.excerpt ?? "").length;
  if (excerptLen > 150) score += 20;
  else if (excerptLen > 80) score += 15;
  else if (excerptLen > 0) score += 8;
  // no excerpt at all → 0

  // Title match (10 pts) — bonus when query terms appear in title
  const titleLower = (content.title ?? "").toLowerCase();
  const matchingTerms = queryTerms.filter(
    (t) => t.length > 2 && titleLower.includes(t)
  );
  if (matchingTerms.length > 0) {
    score += Math.min(10, matchingTerms.length * 4);
  }

  return Math.round(score * 10) / 10;
}

/** Format a scored Confluence search result as readable markdown. */
function formatSearchResult(
  result: import("./types.js").ConfluenceSearchResult,
  score: number
): string {
  const content = result.content;
  const title = content.title ?? "Untitled";
  const pageId = content.id ?? "unknown";

  const lastUpdated = content.history?.lastUpdated?.when;
  const age = daysAgo(lastUpdated);
  const tier = ageTier(age);
  const dateStr = lastUpdated ? lastUpdated.split("T")[0] : "Unknown";
  const ageTag = age !== null ? ` (${ageLabel(age)}, ${tier})` : "";

  const webLink = content._links?.webui;
  const pageUrl = webLink
    ? `${CONFLUENCE_BASE_URL}${webLink}`
    : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${pageId}`;

  let excerpt = result.excerpt?.trim() ?? "";
  excerpt = excerpt
    .replace(/@@@hl@@@/g, "**")
    .replace(/@@@endhl@@@/g, "**");

  return (
    `- **(Score: ${score})** **${title}**\n` +
    `  Updated: ${dateStr}${ageTag} | ID: ${pageId}\n` +
    `  URL: ${pageUrl}\n` +
    `  ${excerpt.slice(0, 200) || "No excerpt available"}`
  );
}

/**
 * Create and configure the Confluence MCP server.
 * Port of confluence_mcp.py MCP tools (lines 307-565).
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createConfluenceServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Confluence",
      version: "0.1.0",
    },
    {
      instructions: `You have access to tools for searching, navigating, and managing Confluence pages, attachments, labels, and comments. Read tools (search_confluence, search_space, search_cql, read_pages, list_spaces, list_page_children, get_page_ancestors, list_attachments, get_labels, list_page_comments) let you search, view, list, and navigate. Write tools (create_page, update_page, delete_page, move_page, upload_attachment, add_labels, remove_label, add_page_comment) let you create/update/delete pages, manage attachments and labels, and add comments — page/comment content is provided in Markdown and converted to Confluence storage format automatically. IMPORTANT: You MUST use the write tools when the user asks you to perform these actions. The following write tools modify live Confluence and must always be confirmed with the user before invoking: delete_page, move_page, upload_attachment (also reads from local disk), create_page, update_page, add_labels, remove_label, add_page_comment. Never refuse by claiming these tools are read-only — they are not. However, always confirm with the user before calling create_page or update_page, since these actions modify live Confluence content. Keep API calls to a minimum to avoid overloading the server. The expected workflow for reading is: search first, then call read_pages with the top page IDs to get full content, then summarize for the user. After that two-step flow, STOP calling tools. Never call the same tool twice with the same arguments. Never guess or fabricate Confluence page IDs or space keys — if you don't know them, ask the user. If a tool returns an error, explain the error clearly to the user and suggest next steps. If you encounter authentication errors (401 Unauthorized or "No valid SMSESSION found"), inform the user they need to set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD environment variables for Basic Auth, or re-authenticate via SMSESSION by running: node ${authCliPath}${WORKAROUND_NOTE}`,
    }
  );

  let client: ConfluenceClient | null = null;

  async function getClient(): Promise<ConfluenceClient> {
    if (!client) {
      const email = process.env["ATLASSIAN_EMAIL"];
      const password = process.env["ATLASSIAN_PASSWORD"];
      const baseUrl = process.env["ATLASSIAN_BASE_URL"];

      if (email && password && baseUrl) {
        const authFetch = createBasicAuthFetch(email, password);
        client = new ConfluenceClient(authFetch, `${baseUrl}/int/confluence`);
      } else {
        const sessionManager = new SessionManager();
        const authFetch = await createAuthenticatedFetch(sessionManager);
        client = new ConfluenceClient(authFetch);
      }
    }
    return client;
  }

  // --- Tools ---

  server.tool(
    "search_confluence",
    `Search BC Gov Confluence pages by keyword or phrase.

Returns a list of matching pages with titles, dates, page IDs, and URLs
sorted by relevance. Use the page IDs with read_pages to get full content.

IMPORTANT: After receiving search results, you MUST call read_pages with
at least the top 10 most relevant page IDs to get the actual content and
build a deep understanding, then provide an executive summary. Never just
list the search results to the user.

IMPORTANT: Always include the full Confluence page URL (not just the page ID) when referencing results to the user.`,
    {
      query: z
        .string()
        .describe("Search text - can be keywords, phrases, or questions"),
      limit: z
        .number()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Maximum results to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`),
      start: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset — index of first result (default 0)"),
    },
    { readOnlyHint: true },
    async ({ query, limit, start }) => {
      try {
        const confluence = await getClient();
        const cql = `text ~ "${query}" AND type = "page"`;
        const results = await confluence.search(cql, limit, start);

        if (results.results.length === 0) {
          return {
            content: [
              { type: "text", text: `No pages found matching '${query}'.` },
            ],
          };
        }

        // Score and rank results
        const queryTerms = query.toLowerCase().split(/\s+/);
        const total = results.results.length;
        const scored = results.results.map((result, idx) => ({
          result,
          score: scorePage(result, idx, total, queryTerms),
        }));
        scored.sort((a, b) => b.score - a.score);

        // Group by age tier for readability
        const tiers: Record<string, string[]> = {};
        for (const { result, score } of scored) {
          const lastUpdated = result.content.history?.lastUpdated?.when;
          const age = daysAgo(lastUpdated);
          const tier = ageTier(age);
          if (!tiers[tier]) tiers[tier] = [];
          tiers[tier].push(formatSearchResult(result, score));
        }

        const sections: string[] = [];
        for (const tierName of ["Current", "Recent", "Outdated", "Unknown"]) {
          const items = tiers[tierName];
          if (items && items.length > 0) {
            sections.push(
              `### ${tierName} (${items.length} pages)\n\n${items.join("\n\n")}`
            );
          }
        }

        const shownEnd = start + results.results.length;
        const header =
          `Found ${results.totalSize} pages matching '${query}' (showing ${start + 1}–${shownEnd}, ranked by relevance):\n\n`;
        const paginationHint = shownEnd < results.totalSize
          ? `\n\n_${results.totalSize - shownEnd} more pages — call again with start=${shownEnd}._`
          : "";

        const text =
          header +
          sections.join("\n\n---\n\n") +
          paginationHint +
          "\n\nUse read_pages with at least the top page IDs to get full content for deep analysis.";

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Search error: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "read_pages",
    `Read the full content of one or more Confluence pages.

Returns the complete page content converted to Markdown — no truncation.
When the user asks to read a page, they get the whole page.

IMPORTANT: Always include the full Confluence page URL (not just the page ID) when referencing results to the user.`,
    {
      pageIds: z
        .string()
        .describe(
          'Comma-separated page IDs (e.g., "12345" or "12345, 67890, 11111")'
        ),
    },
    { readOnlyHint: true },
    async ({ pageIds }) => {
      let ids: string[];
      try {
        ids = pageIds
          .split(",")
          .map((id) => parsePageId(id.trim()));
      } catch (err) {
        return {
          content: [{ type: "text", text: `Invalid page ID: ${safeErr(err)}` }],
          isError: true,
        };
      }

      if (ids.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No page IDs provided. Pass one or more comma-separated IDs.",
            },
          ],
          isError: true,
        };
      }

      if (ids.length > READ_PAGES_CAP) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Maximum ${READ_PAGES_CAP} pages at once to avoid context overflow.`,
            },
          ],
          isError: true,
        };
      }

      const confluence = await getClient();
      const output: string[] = [];

      for (const pid of ids) {
        try {
          const page = await confluence.getPage(pid);

          const title = page.title ?? "Untitled";
          const htmlBody = page.body?.storage?.value ?? "";
          const markdownBody = pi.scrubText(htmlToMarkdown(htmlBody));

          let lastUpdated = "Unknown";
          let updatedBy = "Unknown";
          try {
            lastUpdated = page.version?.when?.split("T")[0] ?? "Unknown";
            updatedBy = pi.scrub(page.version?.by?.displayName) ?? "Unknown";
          } catch {
            // ignore
          }

          const pageUrl = `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${pid}`;

          output.push(
            `## ${title}\n` +
              `**Page ID:** ${pid} | **Updated:** ${lastUpdated} | **By:** ${updatedBy}\n` +
              `**URL:** ${pageUrl}\n\n` +
              markdownBody
          );
        } catch (err) {
          output.push(
            `## ERROR: Page ${pid}\n${safeErr(err)}`
          );
        }
      }

      return {
        content: [{ type: "text", text: output.join("\n\n---\n\n") }],
      };
    }
  );

  server.tool(
    "list_spaces",
    `List all Confluence spaces you have access to.

Returns space keys, names, and types. Useful for discovering what
documentation is available and for filtering searches.`,
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const confluence = await getClient();
        const spaces = await confluence.listSpaces();

        if (spaces.results.length === 0) {
          return {
            content: [
              { type: "text", text: "No spaces found (or session expired)." },
            ],
          };
        }

        const lines = spaces.results.map((space) => {
          let desc = "";
          try {
            desc = space.description?.plain?.value?.slice(0, 100) ?? "";
          } catch {
            // ignore
          }
          let line = `- **${space.name}** (Key: ${space.key}, Type: ${space.type})`;
          if (desc) line += `\n  ${desc}`;
          return line;
        });

        return {
          content: [
            {
              type: "text",
              text: `Found ${spaces.results.length} spaces:\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing spaces: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search_space",
    `Search within a specific Confluence space.

More targeted than search_confluence - filters results to a single space.

IMPORTANT: Always include the full Confluence page URL (not just the page ID) when referencing results to the user.`,
    {
      spaceKey: z
        .string()
        .describe(
          'The space key (e.g., "RRS", "AR", "PMT"). Use list_spaces to find keys.'
        ),
      query: z.string().describe("Search text"),
      limit: z
        .number()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Maximum results to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`),
      start: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset — index of first result (default 0)"),
    },
    { readOnlyHint: true },
    async ({ spaceKey, query, limit, start }) => {
      try {
        const confluence = await getClient();
        const cql = `text ~ "${query}" AND type = "page" AND space = "${spaceKey}"`;
        const results = await confluence.search(cql, limit, start);

        if (results.results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No pages found in space '${spaceKey}' matching '${query}'.`,
              },
            ],
          };
        }

        // Score and rank results
        const queryTerms = query.toLowerCase().split(/\s+/);
        const total = results.results.length;
        const scored = results.results.map((result, idx) => ({
          result,
          score: scorePage(result, idx, total, queryTerms),
        }));
        scored.sort((a, b) => b.score - a.score);

        // Group by age tier for readability
        const tiers: Record<string, string[]> = {};
        for (const { result, score } of scored) {
          const lastUpdated = result.content.history?.lastUpdated?.when;
          const age = daysAgo(lastUpdated);
          const tier = ageTier(age);
          if (!tiers[tier]) tiers[tier] = [];
          tiers[tier].push(formatSearchResult(result, score));
        }

        const sections: string[] = [];
        for (const tierName of ["Current", "Recent", "Outdated", "Unknown"]) {
          const items = tiers[tierName];
          if (items && items.length > 0) {
            sections.push(
              `### ${tierName} (${items.length} pages)\n\n${items.join("\n\n")}`
            );
          }
        }

        const shownEnd = start + results.results.length;
        const header =
          `Found ${results.totalSize} pages in space '${spaceKey}' (showing ${start + 1}–${shownEnd}, ranked by relevance):\n\n`;
        const paginationHint = shownEnd < results.totalSize
          ? `\n\n_${results.totalSize - shownEnd} more pages — call again with start=${shownEnd}._`
          : "";

        return {
          content: [
            {
              type: "text",
              text:
                header +
                sections.join("\n\n---\n\n") +
                paginationHint +
                "\n\nUse read_pages with at least the top page IDs to get full content for deep analysis.",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Search error: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_page_children",
    `List the immediate child pages of a Confluence page. Use this to navigate space hierarchies — find subsections of a parent page without searching. Pages are returned with title, last-updated date, and URL.`,
    {
      pageId: z.string().describe("Page ID whose children to list"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Maximum children to return (default 25)"),
      start: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset (default 0)"),
    },
    { readOnlyHint: true },
    async ({ pageId, limit, start }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        const result = await confluence.getPageChildren(pageId, limit, start);
        if (result.results.length === 0) {
          // Distinguish "no children" from "start past the end" — the former
          // is information, the latter is a pagination cursor mistake.
          const text = start > 0
            ? `No children at start=${start} (past end of list). Use start=0 to see the first page, or list_page_children with no start to check if the page has any children at all.`
            : `Page ${pageId} has no children.`;
          return { content: [{ type: "text", text }] };
        }
        const lines = result.results.map((c) => {
          const updated = c.history?.lastUpdated?.when?.split("T")[0] ?? "Unknown";
          const url = c._links?.webui
            ? `${CONFLUENCE_BASE_URL}${c._links.webui}`
            : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${c.id}`;
          return `- **${c.title}** (id: ${c.id}, updated ${updated})\n  ${url}`;
        });
        // `result.size` is the count returned in this page (Confluence paged
        // endpoints don't include a total). When we filled the page, more are
        // likely available — surface a continuation hint.
        const shownEnd = start + result.results.length;
        const maybeMore = result.results.length === limit;
        const header = `### Children of page ${pageId} — showing ${start + 1}–${shownEnd}${maybeMore ? " (more likely available)" : ""}`;
        const footer = maybeMore
          ? `\n\n_Page filled to limit (${limit}). Call again with start=${shownEnd} to continue._`
          : "";
        return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}${footer}` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing children: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_page_ancestors",
    `Get the ancestor chain (breadcrumb path) of a Confluence page — from space root down to the page's parent. Useful for understanding where a page sits in a space's hierarchy.`,
    {
      pageId: z.string().describe("Page ID to look up"),
    },
    { readOnlyHint: true },
    async ({ pageId }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        const page = await confluence.getPageAncestors(pageId);
        const ancestors = page.ancestors ?? [];
        const lines: string[] = [];
        lines.push(`### Breadcrumb for "${page.title}" (${pageId})`);
        if (page.space) {
          lines.push(`**Space:** ${page.space.name} (${page.space.key})`);
        }
        if (ancestors.length === 0) {
          lines.push("\n_(this page is at the space root — no ancestors)_");
        } else {
          lines.push("");
          ancestors.forEach((a, idx) => {
            const url = a._links?.webui
              ? `${CONFLUENCE_BASE_URL}${a._links.webui}`
              : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${a.id}`;
            lines.push(`${"  ".repeat(idx)}- **${a.title}** (id: ${a.id}) — ${url}`);
          });
          const selfUrl = page._links?.webui
            ? `${CONFLUENCE_BASE_URL}${page._links.webui}`
            : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${page.id}`;
          lines.push(`${"  ".repeat(ancestors.length)}- **${page.title}** (this page) — ${selfUrl}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching ancestors: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_page",
    `Create a new Confluence page in a space.

Content should be provided in Markdown format — it will be automatically
converted to Confluence storage format (HTML).

Returns the created page ID, title, and URL.

IMPORTANT: Always include the full Confluence page URL when referencing the created page to the user.`,
    {
      spaceKey: z
        .string()
        .describe('Space key (e.g., "DEMO", "RRS"). Use list_spaces to find keys.'),
      title: z.string().describe("Page title"),
      body: z
        .string()
        .describe("Page content in Markdown format"),
      parentId: z
        .string()
        .optional()
        .describe("Parent page ID to nest under (optional). If omitted, page is created at the space root."),
    },
    { readOnlyHint: false },
    async ({ spaceKey, title, body, parentId }) => {
      try {
        const confluence = await getClient();
        const bodyHtml = markdownToHtml(body);
        const resolvedParentId = parentId !== undefined ? parsePageId(parentId) : undefined;
        const result = await confluence.createPage(spaceKey, title, bodyHtml, resolvedParentId);

        const pageUrl = result._links?.webui
          ? `${CONFLUENCE_BASE_URL}${result._links.webui}`
          : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${result.id}`;

        return {
          content: [
            {
              type: "text",
              text:
                `Page created successfully.\n\n` +
                `**Page ID:** ${result.id}\n` +
                `**Title:** ${result.title}\n` +
                `**Version:** ${result.version.number}\n` +
                `**URL:** ${pageUrl}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating page: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_page",
    `Update an existing Confluence page's title and/or content.

Content should be provided in Markdown format — it will be automatically
converted to Confluence storage format (HTML).

The tool automatically fetches the current page version and increments it,
so you do not need to provide a version number.

IMPORTANT: Always include the full Confluence page URL when referencing the updated page to the user.`,
    {
      pageId: z
        .string()
        .describe("The page ID to update"),
      title: z
        .string()
        .describe("New page title"),
      body: z
        .string()
        .describe("New page content in Markdown format"),
    },
    { readOnlyHint: false },
    async ({ pageId, title, body }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);

        // Fetch current page to get the version number
        const currentPage = await confluence.getPage(pageId);
        const currentVersion = currentPage.version?.number ?? 0;
        const newVersion = currentVersion + 1;

        const bodyHtml = markdownToHtml(body);
        const result = await confluence.updatePage(pageId, title, bodyHtml, newVersion);

        const pageUrl = result._links?.webui
          ? `${CONFLUENCE_BASE_URL}${result._links.webui}`
          : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${result.id}`;

        return {
          content: [
            {
              type: "text",
              text:
                `Page updated successfully.\n\n` +
                `**Page ID:** ${result.id}\n` +
                `**Title:** ${result.title}\n` +
                `**Version:** ${result.version.number}\n` +
                `**URL:** ${pageUrl}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating page ${pageId}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  server.tool(
    "list_attachments",
    `List attachments on a Confluence page — filename, mime type, size, version, and download URL. Use the download URL to fetch binary content separately (this MCP doesn't return binary in tool output).`,
    {
      pageId: z.string().describe("Page ID"),
      limit: z.number().min(1).max(100).default(25).describe("Maximum to return (default 25)"),
      start: z.number().min(0).default(0).describe("Pagination offset"),
    },
    { readOnlyHint: true },
    async ({ pageId, limit, start }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        const result = await confluence.getAttachments(pageId, limit, start);
        if (result.results.length === 0) {
          return { content: [{ type: "text", text: `No attachments on page ${pageId}.` }] };
        }
        const lines: string[] = [];
        const shownEnd = start + result.results.length;
        // Confluence paged endpoints don't include a total — `result.size`
        // is the count returned in THIS page, not across all pages. Surface
        // it as "returned N" and hint at continuation if the page filled.
        const maybeMore = result.results.length === limit;
        lines.push(
          `### Returned ${result.results.length} attachment(s) on ${pageId} (showing ${start + 1}–${shownEnd})${maybeMore ? " — more likely available" : ""}\n`
        );
        for (const a of result.results) {
          // Explicit null check, not truthy — a valid 0-byte attachment
          // should render as "0 KB", not "?".
          const fileSize = a.extensions?.fileSize;
          const size = fileSize != null
            ? `${Math.round(fileSize / 1024)} KB`
            : "?";
          // Prefer metadata.mediaType (newer DC) then extensions.mediaType
          // (older DC) — both may be populated, neither, or just one.
          const mime = a.metadata?.mediaType ?? a.extensions?.mediaType ?? "application/octet-stream";
          const ver = a.version?.number ?? "?";
          const author = pi.scrub(a.version?.by?.displayName) ?? "Unknown";
          const date = a.version?.when?.split("T")[0] ?? "Unknown";
          const downloadUrl = a._links?.download
            ? `${CONFLUENCE_BASE_URL}${a._links.download}`
            : "(no download link)";
          lines.push(
            `- **${a.title}** (${size}, ${mime}, v${ver}, ${date} by ${author})\n  ID: ${a.id}\n  Download: ${downloadUrl}`
          );
          if (a.extensions?.comment) lines.push(`  _${pi.scrubText(a.extensions.comment)}_`);
        }
        if (maybeMore) {
          lines.push(`\n_Page filled to limit (${limit}). Call again with start=${shownEnd} to continue._`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing attachments: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "upload_attachment",
    `Upload a file from the local filesystem as an attachment to a Confluence page. If a file with the same name already exists on the page, Confluence creates a new version of the existing attachment (no duplicates). Always confirm with the user before uploading — this writes to live Confluence.`,
    {
      pageId: z.string().describe("Page ID to attach the file to"),
      filePath: z
        .string()
        .describe("Path to the file on the local filesystem (the MCP server reads it directly). May be absolute or relative — relative paths are resolved against the MCP process's current working directory."),
      filename: z
        .string()
        .optional()
        .describe("Override the filename used in Confluence (defaults to the file's basename). Must not contain path separators ('/', '\\\\'); if it does, only the basename is kept."),
      mimeType: z
        .string()
        .optional()
        .describe("MIME type override (e.g., 'image/png'). Defaults to application/octet-stream."),
      comment: z
        .string()
        .optional()
        .describe("Version comment shown in Confluence's attachment history"),
    },
    { readOnlyHint: false },
    async ({ pageId, filePath, filename, mimeType, comment }) => {
      try {
        pageId = parsePageId(pageId);
        // resolve() handles relative paths and "..". realpath() resolves
        // symlinks so a non-blocklisted symlink can't redirect us into
        // ~/.ssh or another blocked location. Check BOTH the user-supplied
        // path (post-resolve) and the realpath target — refuse if either
        // is sensitive, so we don't leak even via the symlink name.
        const absPath = resolve(filePath);
        let realPath: string;
        try {
          realPath = await realpath(absPath);
        } catch (err) {
          // ENOENT bubbles up to the user with the file path
          return {
            content: [
              { type: "text", text: `File not found or not accessible: '${absPath}' (${safeErr(err)})` },
            ],
            isError: true,
          };
        }
        const blockedSurface = isSensitivePath(absPath);
        const blockedReal = isSensitivePath(realPath);
        if (blockedSurface || blockedReal) {
          const where = blockedReal && realPath !== absPath
            ? `'${absPath}' resolves to '${realPath}': ${blockedReal}`
            : `'${absPath}': ${blockedSurface ?? blockedReal}`;
          return {
            content: [
              {
                type: "text",
                text: `Refused to upload from ${where}. If you really need to upload this file, copy it somewhere outside the blocked locations first.`,
              },
            ],
            isError: true,
          };
        }
        // Check size BEFORE reading — a stat call is cheap, but loading
        // 5GB into memory just to reject it would be miserable.
        const fileStat = await stat(realPath);
        if (!fileStat.isFile()) {
          return {
            content: [
              { type: "text", text: `Refused to upload from '${realPath}': not a regular file (got ${fileStat.isDirectory() ? "directory" : "special file"}).` },
            ],
            isError: true,
          };
        }
        if (fileStat.size > MAX_UPLOAD_BYTES) {
          return {
            content: [
              {
                type: "text",
                text: `File too large: ${Math.round(fileStat.size / 1024 / 1024)} MB exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload cap.`,
              },
            ],
            isError: true,
          };
        }
        const content = await readFile(realPath);
        // Strip any path separators the caller put in `filename`. The
        // platform's basename() only strips the current platform's separator,
        // so on POSIX a Windows-style "foo\\bar.txt" would slip through and
        // become a literal attachment name. Normalize both separators to
        // forward slash first, then basename.
        // If the caller-supplied filename normalizes to an empty basename
        // (e.g. "" or "foo/"), fall back to the source file's basename
        // rather than uploading with an empty/invalid attachment name.
        const callerName = filename ? basename(filename.replace(/\\/g, "/")) : "";
        const name = callerName.length > 0 ? callerName : basename(absPath);
        const confluence = await getClient();
        const result = await confluence.uploadAttachment(pageId, name, content, {
          mimeType,
          comment,
        });
        const att = result.results[0];
        if (!att) {
          return {
            content: [{ type: "text", text: `Upload returned no attachment record (page ${pageId}).` }],
            isError: true,
          };
        }
        const downloadUrl = att._links?.download
          ? `${CONFLUENCE_BASE_URL}${att._links.download}`
          : "(no download link)";
        return {
          content: [
            {
              type: "text",
              text: `Uploaded **${att.title}** to page ${pageId}.\n**Attachment ID:** ${att.id}\n**Version:** ${att.version?.number ?? "?"}\n**Download:** ${downloadUrl}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error uploading attachment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  server.tool(
    "get_labels",
    `Get all labels on a Confluence page. Returns label names with their prefix (usually "global").`,
    { pageId: z.string().describe("Page ID") },
    { readOnlyHint: true },
    async ({ pageId }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        const result = await confluence.getLabels(pageId);
        if (result.labels.length === 0) {
          return { content: [{ type: "text", text: `No labels on page ${pageId}.` }] };
        }
        const lines = result.labels.map((l) => `- ${l.prefix}:${l.name}`);
        const header = `### ${result.count} label(s) on ${pageId}${result.truncated ? " (truncated at cap)" : ""}`;
        return {
          content: [
            { type: "text", text: `${header}\n\n${lines.join("\n")}` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching labels: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "add_labels",
    `Add one or more labels to a Confluence page. Each label uses the default "global" prefix. Labels are normalized to lowercase by Confluence on storage, so "Policy" and "policy" map to the same label — pass them already-lowercased to avoid surprises and to make remove_label calls predictable.`,
    {
      pageId: z.string().describe("Page ID"),
      names: z.array(z.string()).min(1).describe("Label names to add (one or more)"),
    },
    { readOnlyHint: false },
    async ({ pageId, names }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        await confluence.addLabels(pageId, names);
        return {
          content: [
            { type: "text", text: `Added ${names.length} label(s) to ${pageId}: ${names.join(", ")}` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error adding labels: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "remove_label",
    `Remove a single label from a Confluence page.`,
    {
      pageId: z.string().describe("Page ID"),
      name: z.string().describe("Label name to remove (without the 'global:' prefix)"),
    },
    { readOnlyHint: false },
    async ({ pageId, name }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        await confluence.removeLabel(pageId, name);
        return {
          content: [{ type: "text", text: `Removed label '${name}' from ${pageId}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error removing label: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Page comments
  // ---------------------------------------------------------------------------

  server.tool(
    "list_page_comments",
    `List page-level comments (and resolved/inline comment locations) on a Confluence page. Returns author, date, body (converted to Markdown), and location (footer/inline/resolved).`,
    {
      pageId: z.string().describe("Page ID"),
      limit: z.number().min(1).max(100).default(25).describe("Maximum to return (default 25)"),
      start: z.number().min(0).default(0).describe("Pagination offset"),
    },
    { readOnlyHint: true },
    async ({ pageId, limit, start }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        const result = await confluence.getPageComments(pageId, limit, start);
        if (result.results.length === 0) {
          return { content: [{ type: "text", text: `No comments on page ${pageId}.` }] };
        }
        const lines: string[] = [];
        const shownEnd = start + result.results.length;
        // Same as attachments: Confluence paged endpoints don't carry a
        // cross-page total. "Returned N" + continuation hint when full.
        const maybeMore = result.results.length === limit;
        lines.push(
          `### Returned ${result.results.length} comment(s) on ${pageId} (showing ${start + 1}–${shownEnd})${maybeMore ? " — more likely available" : ""}\n`
        );
        for (const c of result.results) {
          const date = c.history?.createdDate?.split("T")[0] ?? "?";
          const author = pi.scrub(c.history?.createdBy?.displayName) ?? "Unknown";
          const location = c.extensions?.location ?? "footer";
          const html = c.body?.storage?.value ?? "";
          const md = pi.scrubText(htmlToMarkdown(html));
          lines.push(`**${author}** (${date}, ${location}, id ${c.id}):`);
          lines.push(md);
          lines.push("\n---\n");
        }
        if (maybeMore) {
          lines.push(`_Page filled to limit (${limit}). Call again with start=${shownEnd} to continue._`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing comments: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "add_page_comment",
    `Add a page-level (footer) comment to a Confluence page. Body is provided as Markdown and converted to Confluence storage format. For inline comments anchored to specific text, use the Confluence UI — the REST API only exposes footer comments via this path.`,
    {
      pageId: z.string().describe("Page ID"),
      body: z.string().describe("Comment body in Markdown"),
    },
    { readOnlyHint: false },
    async ({ pageId, body }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        const html = markdownToHtml(body);
        const comment = await confluence.addPageComment(pageId, html);
        return {
          content: [
            {
              type: "text",
              text: `Comment added to page ${pageId}.\n**Comment ID:** ${comment.id}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error adding comment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Page lifecycle
  // ---------------------------------------------------------------------------

  server.tool(
    "delete_page",
    `Delete a Confluence page (moves it to the space trash). Always confirm with the user before deleting — this writes to live Confluence and affects discoverability immediately even though space admins can restore from trash.`,
    {
      pageId: z.string().describe("Page ID to delete"),
    },
    { readOnlyHint: false },
    async ({ pageId }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        await confluence.deletePage(pageId);
        return {
          content: [{ type: "text", text: `Page ${pageId} moved to trash.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error deleting page ${pageId}: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "move_page",
    `Move a Confluence page to a new parent (re-parent within or across spaces — though cross-space moves require both pages be visible to the user). The page's title, body, and labels are preserved.`,
    {
      pageId: z.string().describe("Page ID to move"),
      newParentId: z.string().describe("ID of the new parent page"),
    },
    { readOnlyHint: false },
    async ({ pageId, newParentId }) => {
      try {
        const confluence = await getClient();
        pageId = parsePageId(pageId);
        newParentId = parsePageId(newParentId);
        const result = await confluence.movePage(pageId, newParentId);
        const url = result._links?.webui
          ? `${CONFLUENCE_BASE_URL}${result._links.webui}`
          : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${result.id}`;
        return {
          content: [
            {
              type: "text",
              text: `Page ${pageId} moved under parent ${newParentId}.\n**URL:** ${url}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error moving page: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Raw CQL search
  // ---------------------------------------------------------------------------

  server.tool(
    "search_cql",
    `Run a raw Confluence Query Language (CQL) query — the power-user escape hatch beyond search_confluence/search_space. Supports operators those tools don't expose: lastmodified, creator, contributor, label, mention, type, ancestor, parent, etc. Examples:
- 'type = page AND label = "policy" AND lastmodified > now("-30d")'
- 'creator = "jsmith" AND space = RRS AND type = page'
- 'mention = "jsmith" AND lastmodified > "2026-01-01"'
- 'type = blogpost AND space = NEWS'
- 'ancestor = 12345 AND type = page'`,
    {
      cql: z.string().describe("Raw CQL query string"),
      limit: z
        .number()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Maximum results (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`),
      start: z.number().min(0).default(0).describe("Pagination offset"),
    },
    { readOnlyHint: true },
    async ({ cql, limit, start }) => {
      try {
        const confluence = await getClient();
        const results = await confluence.search(cql, limit, start);
        if (results.results.length === 0) {
          return { content: [{ type: "text", text: `No results for CQL: ${cql}` }] };
        }
        const queryTerms = cql.toLowerCase().split(/\s+/);
        const total = results.results.length;
        const lines = results.results.map((r, idx) => {
          const score = scorePage(r, idx, total, queryTerms);
          return formatSearchResult(r, score);
        });
        const shownEnd = start + results.results.length;
        const header = `Found ${results.totalSize} result(s) for CQL (showing ${start + 1}–${shownEnd}):\n\n`;
        const paginationHint = shownEnd < results.totalSize
          ? `\n\n_${results.totalSize - shownEnd} more — call again with start=${shownEnd}._`
          : "";
        return {
          content: [
            {
              type: "text",
              text: header + lines.join("\n\n") + paginationHint,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `CQL error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
