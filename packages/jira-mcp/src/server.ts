import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager, createAuthenticatedFetch, createBasicAuthFetch, PiScrubber, authCliPath } from "@nrs/auth";
import { JiraClient } from "./jira-client.js";
import { saveAttachment } from "./attachment-fs.js";
import { buildAttachmentContent, disambiguateFilename } from "./attachment-content.js";
import { resolveCustomFields, formatFieldMeta } from "./field-meta.js";
import { parseSlot, formatSlots, formatReservation, resolveSlotWindow } from "./deploy-calendar.js";
import type { JiraIssue, JiraComment } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const MAX_DESCRIPTION_CHARS = 8000;
const JIRA_BASE_URL =
  process.env["JIRA_URL"] ??
  (process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/jira`
    : "https://apps.example.gov.bc.ca/int/jira");
const JIRA_EPIC_LINK_FIELD = process.env["JIRA_EPIC_LINK_FIELD"] ?? "customfield_10006";
const JIRA_EPIC_NAME_FIELD = process.env["JIRA_EPIC_NAME_FIELD"] ?? "customfield_10005";

// ---------------------------------------------------------------------------
// Scoring & Ranking
// Adapted from chat.py score_page() — tuned for Jira issue relevance.
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
  return "Legacy";
}

/**
 * Composite relevance score for a Jira issue (0–100).
 *
 * Factors (adapted from chat.py score_page):
 *   Recency       35 pts  — exponential decay from last update
 *   Status        25 pts  — active/open issues rank above done/closed
 *   Richness      20 pts  — description length, labels, components
 *   Search rank   10 pts  — position in Jira's own result order
 *   Priority      10 pts  — higher priority scores higher
 */
function scoreIssue(
  issue: JiraIssue,
  searchRank: number,
  totalResults: number
): number {
  let score = 0;
  const f = issue.fields;

  // Recency (35 pts)
  const age = daysAgo(f.updated);
  if (age !== null) {
    if (age <= 30) score += 35;
    else if (age <= 90) score += 32 - (age - 30) * 0.05;
    else if (age <= 365) score += 28 - (age - 90) * 0.02;
    else if (age <= 365 * 3) score += 20 - (age - 365) * 0.008;
    else score += Math.max(3, 12 - (age - 365 * 3) * 0.004);
  } else {
    score += 10;
  }

  // Status (25 pts)
  const status = f.status.name.toLowerCase();
  if (status.includes("progress") || status.includes("review")) score += 25;
  else if (status === "open" || status === "to do" || status === "reopened")
    score += 20;
  else if (status.includes("block") || status.includes("hold")) score += 18;
  else if (
    status === "done" ||
    status === "closed" ||
    status === "resolved"
  )
    score += 8;
  else score += 15;

  // Content richness (20 pts)
  const descLen = (f.description ?? "").length;
  if (descLen > 500) score += 12;
  else if (descLen > 100) score += 8;
  else if (descLen > 0) score += 4;
  if (f.labels.length > 0) score += 3;
  if (f.components.length > 0) score += 3;
  if (f.fixVersions.length > 0) score += 2;

  // Search rank (10 pts)
  score += Math.max(
    0,
    10 - searchRank * (10 / Math.max(totalResults, 1))
  );

  // Priority (10 pts)
  const pri = (f.priority?.name ?? "").toLowerCase();
  if (pri === "blocker" || pri === "critical") score += 10;
  else if (pri === "high" || pri === "highest") score += 8;
  else if (pri === "medium") score += 5;
  else if (pri === "low" || pri === "lowest") score += 2;
  else score += 4;

  return Math.round(score * 10) / 10;
}

/** Format a Jira issue as readable markdown */
function formatIssue(
  issue: JiraIssue,
  verbose: boolean = false,
  score?: number
): string {
  const f = issue.fields;
  const lines: string[] = [];

  const age = daysAgo(f.updated);
  const tier = ageTier(age);
  const scoreTag = score !== undefined ? ` [Score: ${score}]` : "";
  const ageTag = age !== null ? ` (${ageLabel(age)}, ${tier})` : "";

  const issueUrl = `${JIRA_BASE_URL}/browse/${issue.key}`;
  lines.push(`## ${issue.key}: ${f.summary}${scoreTag}`);
  lines.push(`**Link:** ${issueUrl}`);
  lines.push("");
  lines.push(
    `**Status:** ${f.status.name} | **Type:** ${f.issuetype.name} | **Priority:** ${f.priority?.name ?? "None"}`
  );
  lines.push(
    `**Assignee:** ${pi.scrub(f.assignee?.displayName) ?? "Unassigned"} | **Reporter:** ${pi.scrub(f.reporter?.displayName) ?? "Unknown"}`
  );
  lines.push(`**Created:** ${f.created.split("T")[0]} | **Updated:** ${f.updated.split("T")[0]}${ageTag}`);

  if (f.labels.length > 0) {
    lines.push(`**Labels:** ${f.labels.join(", ")}`);
  }
  if (f.components.length > 0) {
    lines.push(`**Components:** ${f.components.map((c) => c.name).join(", ")}`);
  }
  if (f.fixVersions.length > 0) {
    lines.push(
      `**Fix Versions:** ${f.fixVersions.map((v) => v.name).join(", ")}`
    );
  }
  if (f.parent) {
    lines.push(`**Parent:** ${f.parent.key} - ${f.parent.fields.summary}`);
  }

  if (verbose) {
    lines.push("");
    lines.push("### Description");
    let desc =
      issue.renderedFields?.description ?? f.description ?? "_No description_";
    desc = pi.scrubText(desc);
    if (desc.length > MAX_DESCRIPTION_CHARS) {
      lines.push(
        desc.slice(0, MAX_DESCRIPTION_CHARS) +
          `\n\n... [TRUNCATED at ${MAX_DESCRIPTION_CHARS} chars]`
      );
    } else {
      lines.push(desc);
    }

    // Changelog summary (last 10 entries)
    if (issue.changelog?.histories?.length) {
      lines.push("");
      lines.push("### Recent Activity");
      const recent = issue.changelog.histories.slice(-10);
      for (const entry of recent) {
        const date = entry.created.split("T")[0];
        const changes = entry.items
          .map(
            (item) =>
              `${item.field}: ${pi.scrubText(item.fromString ?? "—")} → ${pi.scrubText(item.toString ?? "—")}`
          )
          .join("; ");
        lines.push(`- **${date}** ${pi.scrub(entry.author.displayName)}: ${changes}`);
      }
    }
  }

  return lines.join("\n");
}

/** Format a comment as readable markdown */
function formatComment(comment: JiraComment): string {
  const date = comment.created.split("T")[0];
  const body = pi.scrubText(comment.renderedBody ?? comment.body);
  return `**${pi.scrub(comment.author.displayName)}** (${date}):\n${body}`;
}

/**
 * Create and configure the Jira MCP server.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createJiraServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Jira",
      version: "0.1.0",
    },
    {
      instructions: `You have access to tools for searching and managing Jira issues, sprints, versions, watchers, worklogs, attachments, and users. Read tools (search_issues, read_issue, list_comments, get_sprint, get_board, list_boards, list_worklogs, list_attachments, search_users, search_assignable_users, list_versions, get_version, list_watchers, get_field_meta, list_deployment_slots, get_deployment_booking) let you search, view, list, and look up. Write tools (create_issue, update_issue, add_comment, update_comment, delete_comment, transition_issue, link_issues, add_worklog, create_version, update_version, delete_version, add_watcher, remove_watcher, create_sprint, update_sprint, delete_sprint, move_issues_to_sprint) let you act on Jira content. delete_comment, delete_version, delete_sprint, create_sprint, update_sprint state transitions, create_version, and update_version are visible to the team — always confirm with the user before invoking. IMPORTANT: You MUST use the write tools when the user asks you to create, update, comment on, or transition Jira issues. Never refuse by claiming these tools are read-only — they are not. However, always confirm with the user before calling write tools, since these actions modify live Jira content. Keep API calls to a minimum to avoid overloading the server. When you call a tool and receive results, STOP calling tools and summarize the results for the user. Never call the same tool twice with the same arguments. Never guess or fabricate Jira issue keys or project keys — if you don't know them, ask the user. Always check for duplicate issues before creating new ones. If a tool returns an error, explain the error clearly to the user and suggest next steps. If you encounter authentication errors (401 Unauthorized or "No valid SMSESSION found"), inform the user they need to set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD environment variables for Basic Auth, or re-authenticate via SMSESSION by running: node ${authCliPath}${WORKAROUND_NOTE}`,
    }
  );

  // Lazy-initialized client (auth happens on first use)
  let client: JiraClient | null = null;

  async function getClient(): Promise<JiraClient> {
    if (!client) {
      const email = process.env["ATLASSIAN_EMAIL"];
      const password = process.env["ATLASSIAN_PASSWORD"];
      const baseUrl = process.env["ATLASSIAN_BASE_URL"];

      if (email && password && baseUrl) {
        const authFetch = createBasicAuthFetch(email, password);
        client = new JiraClient(authFetch, `${baseUrl}/int/jira`);
      } else {
        const sessionManager = new SessionManager();
        const authFetch = await createAuthenticatedFetch(sessionManager);
        client = new JiraClient(authFetch);
      }
    }
    return client;
  }

  // --- Tools ---

  server.tool(
    "search_issues",
    `Search Jira issues using JQL (Jira Query Language). Returns a list of matching issues with key details. Use JQL syntax like: project = DEMO, assignee = currentUser(), status = Open, text ~ 'search term'.\n\nIMPORTANT: Always include the full Jira issue link when referencing results to the user (e.g., ${JIRA_BASE_URL}/browse/ISSUE-KEY).`,
    {
      jql: z.string().describe("JQL query string"),
      maxResults: z
        .number()
        .min(1)
        .max(200)
        .default(20)
        .describe("Maximum results to return (1-200, default 20)"),
      startAt: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset — index of first result to return (default 0). Use response 'next page' hint to walk through large result sets."),
    },
    { readOnlyHint: true },
    async ({ jql, maxResults, startAt }) => {
      try {
        const jira = await getClient();
        const results = await jira.searchIssues(jql, maxResults, startAt);

        if (results.issues.length === 0) {
          return {
            content: [
              { type: "text", text: `No issues found for JQL: ${jql}` },
            ],
          };
        }

        // Score and rank results
        const total = results.issues.length;
        const scored = results.issues.map((issue, idx) => ({
          issue,
          score: scoreIssue(issue, idx, total),
        }));
        scored.sort((a, b) => b.score - a.score);

        // Group by age tier for readability
        const tiers: Record<string, string[]> = {};
        for (const { issue, score } of scored) {
          const age = daysAgo(issue.fields.updated);
          const tier = ageTier(age);
          if (!tiers[tier]) tiers[tier] = [];
          tiers[tier].push(formatIssue(issue, false, score));
        }

        const sections: string[] = [];
        // Output in order: Current → Recent → Legacy → Unknown
        for (const tierName of ["Current", "Recent", "Legacy", "Unknown"]) {
          const items = tiers[tierName];
          if (items && items.length > 0) {
            sections.push(
              `### ${tierName} (${items.length} issues)\n\n${items.join("\n\n---\n\n")}`
            );
          }
        }

        const shownEnd = startAt + scored.length;
        const header =
          `Found ${results.total} issues (showing ${startAt + 1}–${shownEnd}, ranked by relevance):\n\n`;
        const footer = shownEnd < results.total
          ? `\n\n_${results.total - shownEnd} more results available — call again with startAt=${shownEnd} to continue._`
          : "";

        return {
          content: [{ type: "text", text: header + sections.join("\n\n---\n\n") + footer }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching Jira: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "read_issue",
    "Read full details of a Jira issue including description, changelog, and metadata. Use this after search_issues to get complete information.\n\nIMPORTANT: Always include the full Jira issue link when referencing results to the user.",
    {
      issueKey: z
        .string()
        .describe("Jira issue key (e.g., DEMO-123, DMS-289)"),
    },
    { readOnlyHint: true },
    async ({ issueKey }) => {
      try {
        const jira = await getClient();
        const issue = await jira.getIssue(issueKey);
        const formatted = formatIssue(issue, true);

        return {
          content: [{ type: "text", text: formatted }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading issue ${issueKey}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_comments",
    "List all comments on a Jira issue. Shows comment authors, dates, and content.",
    {
      issueKey: z
        .string()
        .describe("Jira issue key (e.g., DEMO-123)"),
    },
    { readOnlyHint: true },
    async ({ issueKey }) => {
      try {
        const jira = await getClient();
        const result = await jira.getComments(issueKey);

        if (result.comments.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No comments on ${issueKey}.`,
              },
            ],
          };
        }

        const formatted = result.comments
          .map(formatComment)
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: `${result.total} comments on ${issueKey}:\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching comments for ${issueKey}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_sprint",
    "Get sprint details and all issues in the sprint. Shows sprint goal, dates, and issue breakdown by status. Sprint issue lists can be large — use maxResults/startAt to paginate.",
    {
      sprintId: z.number().describe("Sprint ID (numeric)"),
      maxResults: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Maximum issues to return per page (1-200, default 50)"),
      startAt: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset — index of first issue to return (default 0)"),
    },
    { readOnlyHint: true },
    async ({ sprintId, maxResults, startAt }) => {
      try {
        const jira = await getClient();
        const [sprint, issues] = await Promise.all([
          jira.getSprint(sprintId),
          jira.getSprintIssues(sprintId, maxResults, startAt),
        ]);

        const lines: string[] = [];
        lines.push(`## Sprint: ${sprint.name}`);
        lines.push(`**State:** ${sprint.state}`);
        if (sprint.goal) lines.push(`**Goal:** ${sprint.goal}`);
        if (sprint.startDate)
          lines.push(`**Start:** ${sprint.startDate.split("T")[0]}`);
        if (sprint.endDate)
          lines.push(`**End:** ${sprint.endDate.split("T")[0]}`);

        lines.push("");
        if (issues.issues.length === 0) {
          // Either the sprint is empty, or startAt is past the end of the
          // results. Surface both cases clearly instead of printing an
          // invalid "showing 51–50" range.
          if (issues.total === 0) {
            lines.push(`### Issues (0)`);
            lines.push("");
            lines.push("_(no issues in this sprint)_");
          } else {
            lines.push(`### Issues (${issues.total} total)`);
            lines.push("");
            lines.push(`_No issues at startAt=${startAt}. Valid range is 0..${Math.max(0, issues.total - 1)}._`);
          }
        } else {
          const shownEnd = startAt + issues.issues.length;
          lines.push(`### Issues (${issues.total} total, showing ${startAt + 1}–${shownEnd})`);
          for (const issue of issues.issues) {
            const f = issue.fields;
            lines.push(
              `- **${issue.key}** ${f.summary} [${f.status.name}] (${pi.scrub(f.assignee?.displayName) ?? "Unassigned"})`
            );
          }
          if (shownEnd < issues.total) {
            lines.push("");
            lines.push(`_${issues.total - shownEnd} more issues — call again with startAt=${shownEnd}._`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching sprint ${sprintId}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_board",
    "List sprints on a Jira Agile board. Shows sprint names, states, and dates.",
    {
      boardId: z.number().describe("Agile board ID (numeric)"),
      state: z
        .enum(["active", "closed", "future"])
        .optional()
        .describe("Filter by sprint state (active, closed, future)"),
    },
    { readOnlyHint: true },
    async ({ boardId, state }) => {
      try {
        const jira = await getClient();
        const result = await jira.getBoardSprints(boardId, state);

        if (result.values.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No sprints found for board ${boardId}${state ? ` with state '${state}'` : ""}.`,
              },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`## Board ${boardId} Sprints`);
        for (const sprint of result.values) {
          const dates =
            sprint.startDate && sprint.endDate
              ? ` (${sprint.startDate.split("T")[0]} → ${sprint.endDate.split("T")[0]})`
              : "";
          lines.push(`- **${sprint.name}** [${sprint.state}]${dates} — ID: ${sprint.id}`);
          if (sprint.goal) lines.push(`  Goal: ${sprint.goal}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching board ${boardId}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_boards",
    "List Jira Agile boards, optionally filtered by project key. Returns board names, types, and IDs. Use the board ID with get_board to see its sprints.",
    {
      projectKey: z
        .string()
        .optional()
        .describe("Project key to filter boards (e.g., PROJ1, DEMO). Omit to list all boards."),
    },
    { readOnlyHint: true },
    async ({ projectKey }) => {
      try {
        const jira = await getClient();
        const result = await jira.listBoards(projectKey);

        if (result.values.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No boards found${projectKey ? ` for project ${projectKey}` : ""}.`,
              },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(
          `## Agile Boards${projectKey ? ` for ${projectKey}` : ""} (${result.values.length})`
        );
        for (const board of result.values) {
          lines.push(`- **${board.name}** [${board.type}] — ID: ${board.id}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error listing boards: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_issue",
    "Create a new Jira issue. Returns the created issue key and URL.\n\nIMPORTANT: Always check for duplicates with search_issues before creating a new issue. Always include the full Jira issue link when referencing the created issue.",
    {
      projectKey: z.string().describe("Project key (e.g., RRS, DEMO)"),
      summary: z.string().describe("Issue summary/title"),
      description: z.string().optional().describe("Issue description (plain text or Jira wiki markup)"),
      issueType: z.string().default("Bug").describe("Issue type (e.g., Bug, Task, Story). Default: Bug"),
      priority: z.string().optional().describe("Priority name (e.g., Critical, High, Medium, Low)"),
      labels: z.array(z.string()).optional().describe("Labels to apply"),
      components: z.array(z.string()).optional().describe("Component names"),
      epicKey: z
        .string()
        .optional()
        .describe(
          "Epic Link — the issue key of the Epic this issue belongs to (e.g., PROJ1-5). " +
          "Use when creating Stories/Tasks/Bugs that belong under an Epic. " +
          "Maps to JIRA_EPIC_LINK_FIELD (customfield_10006 by default)."
        ),
      epicName: z
        .string()
        .optional()
        .describe(
          "Epic Name — the short label shown on board cards. " +
          "Required by NRM Jira when issueType='Epic'; rejected for other issue types. " +
          "Maps to JIRA_EPIC_NAME_FIELD (customfield_10005 by default)."
        ),
      fixVersions: z
        .array(z.string())
        .optional()
        .describe(
          "Fix Version names (e.g. ['1.2.19']). Versions must already exist " +
          "in the project — use list_versions to check and create_version to add."
        ),
      assignee: z
        .string()
        .optional()
        .describe("Assignee username (use search_assignable_users to find it)"),
      parentKey: z
        .string()
        .optional()
        .describe(
          "Parent issue key when creating a sub-task type " +
          "(e.g. an RFD-subtask under an RFD). Only valid for sub-task issue types."
        ),
      customFields: z
        .record(z.unknown())
        .optional()
        .describe(
          "Custom fields by display name or field ID, e.g. " +
          "{\"Target environment\": \"PROD\", \"Change Coordinator\": \"jdoe\"}. " +
          "Values are validated and shaped using the project's create screen metadata " +
          "(select options by value, users by username). " +
          "Use get_field_meta first to discover field names, required fields, and allowed values."
        ),
    },
    { readOnlyHint: false },
    async ({ projectKey, summary, description, issueType, priority, labels, components, epicKey, epicName, fixVersions, assignee, parentKey, customFields }) => {
      try {
        // Fail-fast: catch the two ways callers misuse epicName + issueType.
        // Without these, Jira returns a generic 400 that doesn't make the
        // mistake obvious to the LLM.
        if (issueType === "Epic" && !epicName) {
          return {
            content: [{ type: "text", text: "Error: issueType='Epic' requires epicName (Epic Name is mandatory in NRM Jira)." }],
            isError: true,
          };
        }
        if (epicName && issueType !== "Epic") {
          return {
            content: [{ type: "text", text: `Error: epicName is only valid when issueType='Epic' (got '${issueType}'). Use a different field for non-Epic issues.` }],
            isError: true,
          };
        }

        const jira = await getClient();
        const fields: Record<string, unknown> = {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
        };
        if (description) fields.description = description;
        if (priority) fields.priority = { name: priority };
        if (labels) fields.labels = labels;
        if (components) fields.components = components.map((name) => ({ name }));
        if (epicKey) fields[JIRA_EPIC_LINK_FIELD] = epicKey;
        if (epicName) fields[JIRA_EPIC_NAME_FIELD] = epicName;
        if (fixVersions) fields.fixVersions = fixVersions.map((name) => ({ name }));
        if (assignee) fields.assignee = { name: assignee };
        if (parentKey) fields.parent = { key: parentKey };

        if (customFields && Object.keys(customFields).length > 0) {
          const meta = await jira.getCreateMeta(projectKey, issueType);
          const resolved = resolveCustomFields(customFields, meta);
          if (resolved.errors.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: pi.scrubText(
                    `Custom field errors — issue NOT created:\n- ${resolved.errors.join("\n- ")}\n\n` +
                    `Use get_field_meta with projectKey='${projectKey}' and issueType='${issueType}' to see valid fields and values.`
                  ),
                },
              ],
              isError: true,
            };
          }
          Object.assign(fields, resolved.fields);
        }

        const result = await jira.createIssue(fields);
        const issueUrl = `${JIRA_BASE_URL}/browse/${result.key}`;

        return {
          content: [
            {
              type: "text",
              text: `Issue created successfully.\n\n**Key:** ${result.key}\n**URL:** ${issueUrl}\n**Summary:** ${summary}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating issue: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_issue",
    "Update fields on an existing Jira issue.\n\nIMPORTANT: Always include the full Jira issue link when referencing the updated issue.",
    {
      issueKey: z.string().describe("Jira issue key (e.g., RRS-123)"),
      summary: z.string().optional().describe("New summary/title"),
      description: z.string().optional().describe("New description"),
      priority: z.string().optional().describe("New priority name"),
      labels: z.array(z.string()).optional().describe("Replace labels (overwrites existing)"),
      issueType: z
        .string()
        .optional()
        .describe(
          "Change the issue type by name (e.g., 'Epic', 'Story', 'Task', 'Bug'). " +
          "The target type must be configured in the project's issue type scheme. " +
          "When converting Task→Epic in NRM Jira, also pass `epicName` (Epic Name is required by the project)."
        ),
      epicKey: z
        .string()
        .optional()
        .describe(
          "Epic Link — the issue key of the Epic this issue belongs to (e.g., PROJ1-5). " +
          "Maps to JIRA_EPIC_LINK_FIELD (customfield_10006 by default)."
        ),
      epicName: z
        .string()
        .optional()
        .describe(
          "Epic Name — short label shown on board cards. " +
          "Required by NRM Jira when converting an issue to Epic; rejected when " +
          "the target type is not Epic. " +
          "Maps to JIRA_EPIC_NAME_FIELD (customfield_10005 by default)."
        ),
      fixVersions: z
        .array(z.string())
        .optional()
        .describe(
          "Replace Fix Versions with these version names (overwrites existing). " +
          "Versions must already exist in the project."
        ),
      assignee: z
        .string()
        .optional()
        .describe("New assignee username (use search_assignable_users to find it)"),
      customFields: z
        .record(z.unknown())
        .optional()
        .describe(
          "Custom fields by display name or field ID, e.g. " +
          "{\"Target environment\": \"PROD\"}. Values are validated and shaped " +
          "using the issue's edit screen metadata. " +
          "Use get_field_meta with the issueKey to discover editable fields and allowed values."
        ),
    },
    { readOnlyHint: false },
    async ({ issueKey, summary, description, priority, labels, issueType, epicKey, epicName, fixVersions, assignee, customFields }) => {
      try {
        // Fail-fast: catch the two ways callers misuse epicName + issueType
        // on the conversion path. Mirrors create_issue's guards.
        if (issueType === "Epic" && !epicName) {
          return {
            content: [{ type: "text", text: "Error: converting to issueType='Epic' requires epicName (Epic Name is mandatory in NRM Jira)." }],
            isError: true,
          };
        }
        if (epicName && issueType && issueType !== "Epic") {
          return {
            content: [{ type: "text", text: `Error: epicName is only valid when converting to issueType='Epic' (got '${issueType}').` }],
            isError: true,
          };
        }

        const jira = await getClient();
        const fields: Record<string, unknown> = {};
        if (summary) fields.summary = summary;
        if (description) fields.description = description;
        if (priority) fields.priority = { name: priority };
        if (labels) fields.labels = labels;
        if (issueType) fields.issuetype = { name: issueType };
        if (epicKey) fields[JIRA_EPIC_LINK_FIELD] = epicKey;
        if (epicName) fields[JIRA_EPIC_NAME_FIELD] = epicName;
        if (fixVersions) fields.fixVersions = fixVersions.map((name) => ({ name }));
        if (assignee) fields.assignee = { name: assignee };

        if (customFields && Object.keys(customFields).length > 0) {
          const meta = await jira.getEditMeta(issueKey);
          const resolved = resolveCustomFields(customFields, meta);
          if (resolved.errors.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: pi.scrubText(
                    `Custom field errors — issue NOT updated:\n- ${resolved.errors.join("\n- ")}\n\n` +
                    `Use get_field_meta with issueKey='${issueKey}' to see editable fields and values.`
                  ),
                },
              ],
              isError: true,
            };
          }
          Object.assign(fields, resolved.fields);
        }

        if (Object.keys(fields).length === 0) {
          return {
            content: [{ type: "text", text: "No fields to update. Provide at least one field." }],
            isError: true,
          };
        }

        await jira.updateIssue(issueKey, fields);
        const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

        return {
          content: [
            {
              type: "text",
              text: `Issue ${issueKey} updated successfully.\n**URL:** ${issueUrl}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error updating issue ${issueKey}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_field_meta",
    "Discover the fields available on an issue type's create screen (pass projectKey + issueType) " +
      "or an existing issue's edit screen (pass issueKey). Returns field names, IDs, types, " +
      "required flags, and allowed values.\n\n" +
      "Use this before create_issue/update_issue with customFields — e.g. to find the required " +
      "fields and valid option values for RFC/RFD/RFD-subtask tickets.",
    {
      projectKey: z
        .string()
        .optional()
        .describe("Project key (e.g., RRS) — required together with issueType for create metadata"),
      issueType: z
        .string()
        .optional()
        .describe("Issue type name (e.g., RFC, RFD, RFD-subtask, Bug) for create metadata"),
      issueKey: z
        .string()
        .optional()
        .describe("Existing issue key (e.g., RRS-123) for edit metadata — overrides projectKey/issueType"),
    },
    { readOnlyHint: true },
    async ({ projectKey, issueType, issueKey }) => {
      try {
        if (!issueKey && !(projectKey && issueType)) {
          return {
            content: [
              {
                type: "text",
                text: "Error: pass either issueKey (edit metadata) or both projectKey and issueType (create metadata).",
              },
            ],
            isError: true,
          };
        }

        const jira = await getClient();
        const meta = issueKey
          ? await jira.getEditMeta(issueKey)
          : await jira.getCreateMeta(projectKey!, issueType!);
        const heading = issueKey
          ? `**Editable fields on ${issueKey}** (${meta.length}):`
          : `**Fields for creating '${issueType}' in ${projectKey}** (${meta.length}):`;

        return {
          content: [
            { type: "text", text: pi.scrubText(`${heading}\n\n${formatFieldMeta(meta)}`) },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error getting field metadata: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_deployment_slots",
    "List deployment calendar slots (available and reserved) in a date window. " +
      "Use this to see when a deployment can be scheduled before booking an RFD's slot. " +
      "Read-only: reserving or cancelling a slot must be done in the Jira UI ('Deployment booking' panel on the RFD).",
    {
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Window start date (YYYY-MM-DD). Default: today."),
      endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Window end date (YYYY-MM-DD), inclusive. Default: 14 days after start."),
    },
    { readOnlyHint: true },
    async ({ startDate, endDate }) => {
      try {
        const { start, end } = resolveSlotWindow(new Date(), startDate, endDate);

        const jira = await getClient();
        const raw = await jira.listDeploymentSlots(`${start} 00:00`, `${end} 23:59`);
        const text = `**Deployment slots ${start} → ${end}**\n\n${formatSlots(raw.map(parseSlot))}`;
        return { content: [{ type: "text", text: pi.scrubText(text) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing deployment slots: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_deployment_booking",
    "Show the deployment calendar booking held by an issue (usually an RFD), or report that none exists. " +
      "Read-only companion to list_deployment_slots.",
    {
      issueKey: z.string().describe("Issue key holding the booking (e.g., RRS-123)"),
    },
    { readOnlyHint: true },
    async ({ issueKey }) => {
      try {
        const jira = await getClient();
        const booking = await jira.getDeploymentBooking(issueKey);
        return {
          content: [
            { type: "text", text: pi.scrubText(formatReservation(issueKey, booking)) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error getting deployment booking for ${issueKey}: ${safeErr(err)}` },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "add_comment",
    "Add a comment to a Jira issue. Use Jira wiki markup for formatting.",
    {
      issueKey: z.string().describe("Jira issue key (e.g., RRS-123)"),
      body: z.string().describe("Comment body (supports Jira wiki markup)"),
    },
    { readOnlyHint: false },
    async ({ issueKey, body }) => {
      try {
        const jira = await getClient();
        const comment = await jira.addComment(issueKey, body);
        const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

        return {
          content: [
            {
              type: "text",
              text: `Comment added to ${issueKey}.\n**URL:** ${issueUrl}\n**Comment ID:** ${comment.id}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error adding comment to ${issueKey}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "transition_issue",
    "Transition a Jira issue to a new status (e.g., 'In Progress', 'In Review', 'Done'). Provide either targetStatus (finds matching transition by name) or transitionId (direct).",
    {
      issueKey: z.string().describe("Jira issue key (e.g., RRS-123)"),
      targetStatus: z.string().optional().describe("Target status name (e.g., 'In Progress', 'Done'). Case-insensitive partial match."),
      transitionId: z.string().optional().describe("Direct transition ID (use if you know the exact ID)"),
    },
    { readOnlyHint: false },
    async ({ issueKey, targetStatus, transitionId }) => {
      try {
        const jira = await getClient();

        if (!targetStatus && !transitionId) {
          // List available transitions
          const transitions = await jira.getTransitions(issueKey);
          const list = transitions
            .map((t) => `- **${t.name}** (id: ${t.id}) → ${t.to.name}`)
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `Available transitions for ${issueKey}:\n\n${list}\n\nProvide targetStatus or transitionId to transition.`,
              },
            ],
          };
        }

        let resolvedId = transitionId;
        if (!resolvedId && targetStatus) {
          const transitions = await jira.getTransitions(issueKey);
          const match = transitions.find((t) =>
            t.name.toLowerCase().includes(targetStatus.toLowerCase())
          );
          if (!match) {
            const available = transitions.map((t) => t.name).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `No transition matching "${targetStatus}" found for ${issueKey}. Available: ${available}`,
                },
              ],
              isError: true,
            };
          }
          resolvedId = match.id;
        }

        await jira.transitionIssue(issueKey, resolvedId!);
        const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

        return {
          content: [
            {
              type: "text",
              text: `Issue ${issueKey} transitioned successfully.\n**URL:** ${issueUrl}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error transitioning ${issueKey}: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "link_issues",
    "Create a directional link between two Jira issues (e.g. 'blocks', 'relates to', 'duplicates').\n\nThe link is read as: outwardIssueKey <linkType> inwardIssueKey.\nExample: linkType='Blocks', outwardIssueKey='AS-4056', inwardIssueKey='AS-4058' means 'AS-4056 blocks AS-4058'.\n\nOmit both issue keys to list all available link type names.",
    {
      linkType: z
        .string()
        .optional()
        .describe(
          "Link type name using the outward sense (e.g. 'Blocks', 'Relates', 'Duplicates', 'Clones'). Omit to list available types."
        ),
      outwardIssueKey: z
        .string()
        .optional()
        .describe("Issue key that is the source of the link (e.g. AS-4056 blocks ...)"),
      inwardIssueKey: z
        .string()
        .optional()
        .describe("Issue key that is the target of the link (e.g. ... is blocked by AS-4056)"),
      comment: z
        .string()
        .optional()
        .describe("Optional comment to add alongside the link (Jira wiki markup)"),
    },
    { readOnlyHint: false },
    async ({ linkType, outwardIssueKey, inwardIssueKey, comment }) => {
      try {
        const jira = await getClient();

        // No keys supplied — list available link types
        if (!linkType || !outwardIssueKey || !inwardIssueKey) {
          const types = await jira.getIssueLinkTypes();
          const list = types
            .map(
              (t) =>
                `- **${t.name}** — outward: "${t.outward}" / inward: "${t.inward}"`
            )
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `Available link types:\n\n${list}\n\nProvide linkType, outwardIssueKey, and inwardIssueKey to create a link.`,
              },
            ],
          };
        }

        await jira.linkIssues(linkType, outwardIssueKey, inwardIssueKey, comment);

        const outwardUrl = `${JIRA_BASE_URL}/browse/${outwardIssueKey}`;
        const inwardUrl = `${JIRA_BASE_URL}/browse/${inwardIssueKey}`;

        return {
          content: [
            {
              type: "text",
              text: `Link created: [${outwardIssueKey}](${outwardUrl}) **${linkType}** [${inwardIssueKey}](${inwardUrl})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error linking issues: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Worklogs
  // ---------------------------------------------------------------------------

  server.tool(
    "list_worklogs",
    "List worklog entries on a Jira issue — author, time spent, when, and the comment if any. The worklog endpoint is paginated; the displayed total-hours sum is over the returned page, not the whole issue. For issues with many entries, page through with startAt.",
    {
      issueKey: z.string().describe("Jira issue key (e.g., RRS-123)"),
      maxResults: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum worklogs per page (1-500, default 100)"),
      startAt: z
        .number()
        .min(0)
        .default(0)
        .describe("Pagination offset (default 0)"),
    },
    { readOnlyHint: true },
    async ({ issueKey, maxResults, startAt }) => {
      try {
        const jira = await getClient();
        const result = await jira.getWorklogs(issueKey, maxResults, startAt);
        if (result.worklogs.length === 0) {
          if (startAt > 0 && result.total > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No worklogs at startAt=${startAt} (${result.total} total — valid range 0..${result.total - 1}).`,
                },
              ],
            };
          }
          return { content: [{ type: "text", text: `No worklogs on ${issueKey}.` }] };
        }
        // Sum hours over the RETURNED page only — accurate but partial. The
        // header makes the partiality explicit so callers don't read it as
        // a complete-issue total.
        const totalSeconds = result.worklogs.reduce((s, w) => s + w.timeSpentSeconds, 0);
        const totalHours = Math.round((totalSeconds / 3600) * 10) / 10;
        const shownEnd = startAt + result.worklogs.length;
        const isComplete = result.total === result.worklogs.length && startAt === 0;
        const header = isComplete
          ? `### ${result.total} worklog(s) on ${issueKey} — total ${totalHours}h`
          : `### ${result.total} worklog(s) on ${issueKey} — showing ${startAt + 1}–${shownEnd}, page total ${totalHours}h`;
        const lines: string[] = [header, ""];
        for (const w of result.worklogs) {
          const date = w.started.split("T")[0];
          const author = pi.scrub(w.author.displayName) ?? "Unknown";
          const comment = w.comment ? `\n  ${pi.scrubText(w.comment)}` : "";
          lines.push(`- **${date}** ${author} — ${w.timeSpent}${comment}`);
        }
        if (shownEnd < result.total) {
          lines.push("");
          lines.push(`_${result.total - shownEnd} more worklog(s) — call again with startAt=${shownEnd}._`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching worklogs for ${issueKey}: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "add_worklog",
    "Log time on a Jira issue. timeSpent uses Jira format: '30m', '2h', '1d 4h', etc. Always confirm with the user before logging time.",
    {
      issueKey: z.string().describe("Jira issue key (e.g., RRS-123)"),
      timeSpent: z.string().describe("Time spent in Jira format (e.g., '2h 30m', '1d', '45m')"),
      comment: z.string().optional().describe("Optional comment explaining what was done"),
      started: z
        .string()
        .optional()
        .describe("ISO timestamp when the work was performed (e.g., '2026-05-09T09:00:00.000+0000'). Defaults to now."),
    },
    { readOnlyHint: false },
    async ({ issueKey, timeSpent, comment, started }) => {
      try {
        const jira = await getClient();
        const worklog = await jira.addWorklog(issueKey, timeSpent, { comment, started });
        const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;
        return {
          content: [
            {
              type: "text",
              text: `Worklog added to ${issueKey}: ${worklog.timeSpent}.\n**URL:** ${issueUrl}\n**Worklog ID:** ${worklog.id}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error adding worklog to ${issueKey}: ${safeErr(err)}` }],
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
    "List attachments on a Jira issue — filename, author, size, mime type, ID, and download URL. Use download_attachment (with the attachment ID) to fetch and save the actual file contents.",
    {
      issueKey: z.string().describe("Jira issue key (e.g., RRS-123)"),
    },
    { readOnlyHint: true },
    async ({ issueKey }) => {
      try {
        const jira = await getClient();
        const attachments = await jira.listAttachments(issueKey);
        if (attachments.length === 0) {
          return { content: [{ type: "text", text: `No attachments on ${issueKey}.` }] };
        }
        const lines: string[] = [];
        lines.push(`### ${attachments.length} attachment(s) on ${issueKey}\n`);
        for (const att of attachments) {
          const date = att.created.split("T")[0];
          const sizeKb = Math.round(att.size / 1024);
          const author = pi.scrub(att.author.displayName) ?? "Unknown";
          lines.push(
            `- **${att.filename}** (${sizeKb} KB, ${att.mimeType}) — uploaded ${date} by ${author}\n  ID: ${att.id}\n  Download: ${att.content}`
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching attachments for ${issueKey}: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "download_attachment",
    "Download file(s) attached to a Jira ticket. Provide attachmentId to download ONE file — it is saved to disk AND its contents are returned inline (full text for text/PDF, the image itself for screenshots). Provide issueKey to download ALL attachments on the issue — each is saved to disk and a manifest of paths is returned (call again with a specific attachmentId to read one inline). Files save to the current working directory unless destDir is given. NOTE: inlined image content (e.g. screenshots) may contain personal information visible to the AI.",
    {
      attachmentId: z.string().optional().describe("Download a single attachment by ID (from list_attachments)"),
      issueKey: z.string().optional().describe("Download ALL attachments on this issue (e.g., RRS-123)"),
      destDir: z.string().optional().describe("Directory to save into; defaults to the current working directory"),
    },
    { readOnlyHint: false },
    async ({ attachmentId, issueKey, destDir }) => {
      try {
        if ((!attachmentId && !issueKey) || (attachmentId && issueKey)) {
          return {
            content: [{ type: "text", text: "Provide exactly one of attachmentId or issueKey." }],
            isError: true,
          };
        }
        const jira = await getClient();

        if (attachmentId) {
          const { meta, bytes } = await jira.downloadAttachment(attachmentId);
          const path = await saveAttachment(bytes, meta.filename, destDir);
          const content = await buildAttachmentContent(meta, bytes, path, (s) => pi.scrubText(s));
          return { content };
        }

        const attachments = await jira.listAttachments(issueKey as string);
        if (attachments.length === 0) {
          return { content: [{ type: "text", text: `No attachments on ${issueKey}.` }] };
        }
        const lines: string[] = [`### Downloaded ${attachments.length} attachment(s) from ${issueKey}\n`];
        const usedNames = new Set<string>();
        for (const att of attachments) {
          const bytes = await jira.downloadAttachmentContent(att);
          const name = disambiguateFilename(att.filename, att.id, usedNames);
          const path = await saveAttachment(bytes, name, destDir);
          const sizeKb = Math.round(att.size / 1024);
          lines.push(`- **${att.filename}** (${sizeKb} KB, ${att.mimeType}) → ${path}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error downloading attachment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // User search
  // ---------------------------------------------------------------------------

  server.tool(
    "search_users",
    "Search Jira users by username, display name, or email substring. Returns username, display name, and active status. Use this to look up the canonical username before assigning issues or adding watchers.",
    {
      query: z.string().describe("Search text (matches username, display name, or email)"),
      maxResults: z
        .number()
        .min(1)
        .max(50)
        .default(25)
        .describe("Maximum users to return (default 25)"),
    },
    { readOnlyHint: true },
    async ({ query, maxResults }) => {
      try {
        const jira = await getClient();
        const users = await jira.searchUsers(query, maxResults);
        if (users.length === 0) {
          return { content: [{ type: "text", text: `No users found matching '${query}'.` }] };
        }
        const lines = users.map((u) => {
          const inactive = u.active ? "" : " _(inactive)_";
          // The scrubber may strip the email entirely. Only emit angle
          // brackets when there's something to put between them.
          const scrubbedEmail = u.emailAddress ? pi.scrub(u.emailAddress) : null;
          const email = scrubbedEmail ? ` <${scrubbedEmail}>` : "";
          return `- **${pi.scrub(u.displayName) ?? u.name}** (username: ${u.name})${email}${inactive}`;
        });
        return {
          content: [{ type: "text", text: `### ${users.length} user(s) matching '${query}'\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error searching users: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search_assignable_users",
    "Search users who can be assigned to issues in a given Jira project. Narrower than search_users — only returns users with assign-issue permission for that project.",
    {
      projectKey: z.string().describe("Project key (e.g., RRS, DEMO)"),
      query: z
        .string()
        .default("")
        .describe("Optional search text to filter by username/displayName"),
      maxResults: z
        .number()
        .min(1)
        .max(50)
        .default(25)
        .describe("Maximum users to return (default 25)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, query, maxResults }) => {
      try {
        const jira = await getClient();
        const users = await jira.searchAssignableUsers(projectKey, query, maxResults);
        if (users.length === 0) {
          return {
            content: [
              { type: "text", text: `No assignable users found for project ${projectKey}${query ? ` matching '${query}'` : ""}.` },
            ],
          };
        }
        const lines = users.map((u) => {
          const inactive = u.active ? "" : " _(inactive)_";
          return `- **${pi.scrub(u.displayName) ?? u.name}** (username: ${u.name})${inactive}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `### ${users.length} assignable user(s) for ${projectKey}${query ? ` matching '${query}'` : ""}\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error searching assignable users: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Project versions
  // ---------------------------------------------------------------------------

  server.tool(
    "list_versions",
    "List all versions for a Jira project — names, release dates, archived/released flags. Useful before creating a new version (avoid duplicates) or when looking up a version ID for fixVersion fields.",
    {
      projectKey: z.string().describe("Project key (e.g., RRS, DEMO)"),
    },
    { readOnlyHint: true },
    async ({ projectKey }) => {
      try {
        const jira = await getClient();
        const versions = await jira.listProjectVersions(projectKey);
        if (versions.length === 0) {
          return { content: [{ type: "text", text: `No versions defined for ${projectKey}.` }] };
        }
        const lines = versions.map((v) => {
          const flags = [v.released ? "released" : null, v.archived ? "archived" : null, v.overdue ? "overdue" : null]
            .filter(Boolean)
            .join(", ");
          const dates = [v.startDate ? `start ${v.startDate}` : null, v.releaseDate ? `release ${v.releaseDate}` : null]
            .filter(Boolean)
            .join(", ");
          const meta = [flags, dates].filter(Boolean).join(" | ");
          // Version descriptions are user-authored free text — scrub PI
          // like every other Jira free-text field this server emits.
          const desc = v.description ? `\n  ${pi.scrubText(v.description)}` : "";
          return `- **${v.name}** (id: ${v.id})${meta ? ` — ${meta}` : ""}${desc}`;
        });
        return {
          content: [{ type: "text", text: `### ${versions.length} version(s) in ${projectKey}\n\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing versions: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_version",
    "Get a single Jira version by ID — full details including dates, description, released/archived state.",
    { versionId: z.string().describe("Numeric version ID (from list_versions)") },
    { readOnlyHint: true },
    async ({ versionId }) => {
      try {
        const jira = await getClient();
        const v = await jira.getVersion(versionId);
        const lines = [`## ${v.name} (id ${v.id})`];
        if (v.description) lines.push(pi.scrubText(v.description));
        lines.push("");
        lines.push(`**Released:** ${v.released ? "yes" : "no"}${v.releaseDate ? ` (${v.releaseDate})` : ""}`);
        lines.push(`**Archived:** ${v.archived ? "yes" : "no"}`);
        if (v.startDate) lines.push(`**Start:** ${v.startDate}`);
        if (v.overdue) lines.push(`**Overdue:** yes`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching version: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_version",
    "Create a new version in a Jira project. Use ISO dates (YYYY-MM-DD). Always confirm with the user before creating — versions are visible in the project's release planning view.",
    {
      projectKey: z.string().describe("Project key (e.g., RRS, DEMO)"),
      name: z.string().describe("Version name (e.g., '3.2.1' or '2026-Q2')"),
      description: z.string().optional().describe("Description shown in release notes"),
      startDate: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
      releaseDate: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
      released: z.boolean().optional().describe("Set true to mark as already released"),
      archived: z.boolean().optional().describe("Set true to archive immediately"),
    },
    { readOnlyHint: false },
    async ({ projectKey, name, description, startDate, releaseDate, released, archived }) => {
      try {
        const jira = await getClient();
        const v = await jira.createVersion(projectKey, name, {
          description,
          startDate,
          releaseDate,
          released,
          archived,
        });
        return {
          content: [
            {
              type: "text",
              text: `Created version **${v.name}** (id ${v.id}) in ${projectKey}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error creating version: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_version",
    "Update an existing Jira version's metadata. Pass only the fields you want to change. Always confirm with the user before updating released/archived flags.",
    {
      versionId: z.string().describe("Version ID"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      startDate: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
      releaseDate: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
      released: z.boolean().optional().describe("Mark released / unreleased"),
      archived: z.boolean().optional().describe("Mark archived / unarchived"),
    },
    { readOnlyHint: false },
    async ({ versionId, ...updates }) => {
      try {
        // Strip undefined fields, then guard against empty updates — Jira
        // returns a generic 400 for empty bodies, which is confusing.
        const fields = Object.fromEntries(
          Object.entries(updates).filter(([, v]) => v !== undefined)
        );
        if (Object.keys(fields).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No fields to update. Provide at least one of: name, description, startDate, releaseDate, released, archived.",
              },
            ],
            isError: true,
          };
        }
        const jira = await getClient();
        const v = await jira.updateVersion(versionId, fields);
        return {
          content: [{ type: "text", text: `Updated version **${v.name}** (id ${v.id}).` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error updating version: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_version",
    "Delete a Jira version. If issues reference it, pass `moveFixIssuesTo` and/or `moveAffectedIssuesTo` (other version IDs) to relocate the references — otherwise the delete fails. Always confirm with the user — destructive.",
    {
      versionId: z.string().describe("Version ID to delete"),
      moveFixIssuesTo: z
        .string()
        .optional()
        .describe("Move issues whose fixVersion is this version to this version ID instead"),
      moveAffectedIssuesTo: z
        .string()
        .optional()
        .describe("Move issues whose affectedVersion is this version to this version ID instead"),
    },
    { readOnlyHint: false },
    async ({ versionId, moveFixIssuesTo, moveAffectedIssuesTo }) => {
      try {
        const jira = await getClient();
        await jira.deleteVersion(versionId, { moveFixIssuesTo, moveAffectedIssuesTo });
        return {
          content: [{ type: "text", text: `Deleted version ${versionId}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error deleting version: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Watchers
  // ---------------------------------------------------------------------------

  server.tool(
    "list_watchers",
    "List users watching a Jira issue — and whether the authenticated user is among them.",
    { issueKey: z.string().describe("Issue key (e.g., RRS-123)") },
    { readOnlyHint: true },
    async ({ issueKey }) => {
      try {
        const jira = await getClient();
        const w = await jira.getWatchers(issueKey);
        if (w.watchCount === 0) {
          return { content: [{ type: "text", text: `No watchers on ${issueKey}.` }] };
        }
        const youTag = w.isWatching ? " (you are watching)" : "";
        // Match the privacy posture of formatIssue/formatComment: emit
        // the scrubbed display name only, never the raw username. (The
        // search_users / search_assignable_users tools intentionally do
        // expose the username — that's their purpose. list_watchers is
        // just a listing where the username adds nothing for the reader.)
        const lines = w.watchers.map((u) => {
          const inactive = u.active ? "" : " _(inactive)_";
          const name = pi.scrub(u.displayName) ?? "(name redacted)";
          return `- **${name}**${inactive}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `### ${w.watchCount} watcher(s) on ${issueKey}${youTag}\n\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error fetching watchers: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "add_watcher",
    "Add a user as a watcher on a Jira issue. Use search_users to find the canonical username first.",
    {
      issueKey: z.string().describe("Issue key (e.g., RRS-123)"),
      username: z.string().describe("Username to add as a watcher"),
    },
    { readOnlyHint: false },
    async ({ issueKey, username }) => {
      try {
        const jira = await getClient();
        await jira.addWatcher(issueKey, username);
        return {
          content: [{ type: "text", text: `Added ${username} as a watcher on ${issueKey}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error adding watcher: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "remove_watcher",
    "Remove a user from a Jira issue's watcher list.",
    {
      issueKey: z.string().describe("Issue key (e.g., RRS-123)"),
      username: z.string().describe("Username to remove"),
    },
    { readOnlyHint: false },
    async ({ issueKey, username }) => {
      try {
        const jira = await getClient();
        await jira.removeWatcher(issueKey, username);
        return {
          content: [{ type: "text", text: `Removed ${username} from ${issueKey}'s watchers.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error removing watcher: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Sprint management
  // ---------------------------------------------------------------------------

  server.tool(
    "create_sprint",
    "Create a sprint on a Jira Agile board (initial state: future). Pass start/end dates if you want to start it immediately via update_sprint afterwards. Always confirm with the user before creating sprints — they are visible to the whole team.",
    {
      boardId: z.number().describe("Board ID (from list_boards)"),
      name: z.string().describe("Sprint name (e.g., 'RRS Sprint 42')"),
      startDate: z.string().optional().describe("ISO timestamp"),
      endDate: z.string().optional().describe("ISO timestamp"),
      goal: z.string().optional().describe("Sprint goal"),
    },
    { readOnlyHint: false },
    async ({ boardId, name, startDate, endDate, goal }) => {
      try {
        const jira = await getClient();
        const s = await jira.createSprint(boardId, name, { startDate, endDate, goal });
        return {
          content: [
            { type: "text", text: `Created sprint **${s.name}** (id ${s.id}, state ${s.state}) on board ${boardId}.` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error creating sprint: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_sprint",
    `Update a sprint — change name, goal, dates, or transition its state.

State transitions:
- **future → active** ("start sprint"): set state='active' AND provide both startDate and endDate
- **active → closed** ("complete sprint"): set state='closed'
- **active/closed → future**: not generally supported by Jira

Always confirm with the user before transitioning state — these are visible to the team.`,
    {
      sprintId: z.number().describe("Sprint ID"),
      name: z.string().optional().describe("New sprint name"),
      startDate: z.string().optional().describe("ISO timestamp"),
      endDate: z.string().optional().describe("ISO timestamp"),
      goal: z.string().optional().describe("Sprint goal"),
      state: z.enum(["active", "closed", "future"]).optional().describe("New state"),
    },
    { readOnlyHint: false },
    async ({ sprintId, ...updates }) => {
      try {
        // Drop undefined fields and guard against empty updates — Jira
        // returns a generic 400 otherwise.
        const fields = Object.fromEntries(
          Object.entries(updates).filter(([, v]) => v !== undefined)
        );
        if (Object.keys(fields).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No fields to update. Provide at least one of: name, startDate, endDate, goal, state.",
              },
            ],
            isError: true,
          };
        }
        if (fields.state === "active" && (!fields.startDate || !fields.endDate)) {
          return {
            content: [
              {
                type: "text",
                text: "Error: starting a sprint (state='active') requires both startDate and endDate.",
              },
            ],
            isError: true,
          };
        }
        const jira = await getClient();
        const s = await jira.updateSprint(sprintId, fields);
        return {
          content: [
            { type: "text", text: `Updated sprint **${s.name}** (id ${s.id}, state ${s.state}).` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error updating sprint: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_sprint",
    "Delete a sprint. Issues in the sprint are returned to the backlog. Always confirm with the user — destructive and visible to the team.",
    { sprintId: z.number().describe("Sprint ID") },
    { readOnlyHint: false },
    async ({ sprintId }) => {
      try {
        const jira = await getClient();
        await jira.deleteSprint(sprintId);
        return { content: [{ type: "text", text: `Deleted sprint ${sprintId}.` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error deleting sprint: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "move_issues_to_sprint",
    "Move issues into a sprint. Up to 50 issues per call (Jira Agile API limit). The issues are removed from any other sprint they were in.",
    {
      sprintId: z.number().describe("Target sprint ID"),
      issueKeys: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Issue keys to move (1-50)"),
    },
    { readOnlyHint: false },
    async ({ sprintId, issueKeys }) => {
      try {
        const jira = await getClient();
        await jira.moveIssuesToSprint(sprintId, issueKeys);
        return {
          content: [
            {
              type: "text",
              text: `Moved ${issueKeys.length} issue(s) to sprint ${sprintId}: ${issueKeys.join(", ")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error moving issues to sprint: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Comment update / delete
  // ---------------------------------------------------------------------------

  server.tool(
    "update_comment",
    "Update an existing comment on a Jira issue (replace its body). Get the comment ID from list_comments.",
    {
      issueKey: z.string().describe("Issue key (e.g., RRS-123)"),
      commentId: z.string().describe("Comment ID (from list_comments output)"),
      body: z.string().describe("New comment body (Jira wiki markup)"),
    },
    { readOnlyHint: false },
    async ({ issueKey, commentId, body }) => {
      try {
        const jira = await getClient();
        const c = await jira.updateComment(issueKey, commentId, body);
        const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;
        return {
          content: [
            {
              type: "text",
              text: `Updated comment ${c.id} on ${issueKey}.\n**URL:** ${issueUrl}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error updating comment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_comment",
    "Delete a comment from a Jira issue. Always confirm with the user before deleting — this can't be undone through the API.",
    {
      issueKey: z.string().describe("Issue key (e.g., RRS-123)"),
      commentId: z.string().describe("Comment ID (from list_comments output)"),
    },
    { readOnlyHint: false },
    async ({ issueKey, commentId }) => {
      try {
        const jira = await getClient();
        await jira.deleteComment(issueKey, commentId);
        return {
          content: [
            { type: "text", text: `Deleted comment ${commentId} from ${issueKey}.` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error deleting comment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
