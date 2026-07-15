import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SessionManager,
  createAuthenticatedFetch,
  createBasicAuthFetch,
  PiScrubber,
  authCliPath,
} from "@nrs/auth";
import { JiraClient } from "@nrs/jira-mcp/client";
import { ConfluenceClient } from "@nrs/confluence-mcp/client";
import { BitbucketClient } from "@nrs/bitbucket-mcp/client";

import type { JiraIssue, JiraSearchResponse, JiraBoard } from "@nrs/jira-mcp/client";
import type { ConfluenceSearchResponse } from "@nrs/confluence-mcp/client";
import type { BitbucketRepo, BitbucketPullRequest, PagedResponse } from "@nrs/bitbucket-mcp/client";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

const JIRA_BASE_URL =
  process.env["JIRA_URL"] ??
  (process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/jira`
    : "https://apps.example.gov.bc.ca/int/jira");
const CONFLUENCE_BASE_URL =
  process.env["CONFLUENCE_URL"] ??
  (process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/confluence`
    : "https://apps.example.gov.bc.ca/int/confluence");

// ---------------------------------------------------------------------------
// Parallel fetch helpers
// ---------------------------------------------------------------------------

/**
 * Auto-discover the project's Agile board and active sprint.
 * Returns sprint metadata and all cross-project issues, or null if no board/sprint found.
 */
async function discoverActiveSprint(
  jira: JiraClient,
  projectKey: string
): Promise<{
  boardName: string;
  boardType: string;
  boardId: number;
  sprintName: string;
  sprintGoal?: string;
  sprintStart?: string;
  sprintEnd?: string;
  issues: JiraIssue[];
} | null> {
  // Step 1: Find boards for this project
  const boards = await jira.listBoards(projectKey);
  if (boards.values.length === 0) return null;

  // Prefer a Scrum board; fall back to whatever is available
  const scrumBoard = boards.values.find((b) => b.type === "scrum");
  const board = scrumBoard ?? boards.values[0]!;

  // Step 2: Get the active sprint on this board
  const sprints = await jira.getBoardSprints(board.id, "active");
  if (sprints.values.length === 0) return null;

  const activeSprint = sprints.values[0]!;

  // Step 3: Fetch ALL issues in the sprint (cross-project)
  const sprintIssues = await jira.getSprintIssues(activeSprint.id, 50);

  return {
    boardName: board.name,
    boardType: board.type,
    boardId: board.id,
    sprintName: activeSprint.name,
    sprintGoal: activeSprint.goal,
    sprintStart: activeSprint.startDate,
    sprintEnd: activeSprint.endDate,
    issues: sprintIssues.issues,
  };
}

async function fetchJiraOverview(
  jira: JiraClient,
  projectKey: string
): Promise<{ section: string; content: string }> {
  const lines: string[] = [];
  lines.push(`## Jira: ${projectKey}`);

  // Fetch recent issues and active sprint in parallel
  const [recentResult, sprintResult] = await Promise.allSettled([
    jira.searchIssues(
      `project = ${projectKey} ORDER BY updated DESC`,
      10
    ),
    discoverActiveSprint(jira, projectKey),
  ]);

  // Recent issues (project-scoped)
  if (recentResult.status === "fulfilled") {
    const recent = recentResult.value;
    if (recent.issues.length > 0) {
      lines.push("");
      lines.push(
        `### Recent Issues (${recent.total} total, showing ${recent.issues.length})`
      );
      for (const issue of recent.issues) {
        const f = issue.fields;
        const issueUrl = `${JIRA_BASE_URL}/browse/${issue.key}`;
        lines.push(
          `- **[${issue.key}](${issueUrl})** ${f.summary} [${f.status.name}] — ${pi.scrub(f.assignee?.displayName) ?? "Unassigned"} (updated ${f.updated.split("T")[0]})`
        );
      }
    } else {
      lines.push("\nNo recent issues found.");
    }
  } else {
    lines.push(`\n*Failed to fetch recent issues: ${recentResult.reason?.message ?? "Unknown error"}*`);
  }

  // Active sprint from board (cross-project)
  if (sprintResult.status === "fulfilled" && sprintResult.value) {
    const sprint = sprintResult.value;
    lines.push("");

    const dates =
      sprint.sprintStart && sprint.sprintEnd
        ? ` (${sprint.sprintStart.split("T")[0]} → ${sprint.sprintEnd.split("T")[0]})`
        : "";
    lines.push(`### Active Sprint: ${sprint.sprintName}${dates}`);
    if (sprint.sprintGoal) lines.push(`**Goal:** ${sprint.sprintGoal}`);
    lines.push(
      `**Board:** ${sprint.boardName} (${sprint.boardType}, ID ${sprint.boardId})`
    );

    if (sprint.issues.length > 0) {
      // Group issues by project key for cross-project visibility
      const byProject: Record<string, JiraIssue[]> = {};
      for (const issue of sprint.issues) {
        const projKey = issue.key.split("-")[0]!;
        if (!byProject[projKey]) byProject[projKey] = [];
        byProject[projKey].push(issue);
      }

      // Project summary line
      const projectSummaries = Object.entries(byProject)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([proj, issues]) => {
          const statusCounts: Record<string, number> = {};
          for (const iss of issues) {
            const s = iss.fields.status.name;
            statusCounts[s] = (statusCounts[s] ?? 0) + 1;
          }
          const breakdown = Object.entries(statusCounts)
            .map(([s, c]) => `${c} ${s}`)
            .join(", ");
          return `- **${proj}** (${issues.length}): ${breakdown}`;
        });

      lines.push("");
      lines.push(`**By Project (${sprint.issues.length} issues total):**`);
      lines.push(projectSummaries.join("\n"));

      // All issues grouped by status
      lines.push("");
      lines.push(`**All Issues (${sprint.issues.length}):**`);

      const byStatus: Record<string, string[]> = {};
      for (const issue of sprint.issues) {
        const status = issue.fields.status.name;
        if (!byStatus[status]) byStatus[status] = [];
        const issueUrl = `${JIRA_BASE_URL}/browse/${issue.key}`;
        byStatus[status].push(
          `  - **[${issue.key}](${issueUrl})** ${issue.fields.summary} (${pi.scrub(issue.fields.assignee?.displayName) ?? "Unassigned"})`
        );
      }
      for (const [status, items] of Object.entries(byStatus)) {
        lines.push(`**${status}** (${items.length}):`);
        lines.push(items.join("\n"));
      }
    } else {
      lines.push("\n*Sprint has no issues.*");
    }
  } else if (sprintResult.status === "rejected") {
    lines.push(`\n*Failed to fetch sprint board: ${sprintResult.reason?.message ?? "Unknown error"}*`);
  } else {
    lines.push("\n*No active sprint board found.*");
  }

  return { section: "jira", content: lines.join("\n") };
}

async function fetchConfluenceOverview(
  confluence: ConfluenceClient,
  projectKey: string
): Promise<{ section: string; content: string }> {
  const lines: string[] = [];
  lines.push(`## Confluence: ${projectKey}`);

  const cql = `text ~ "${projectKey}" AND type = "page" ORDER BY lastModified DESC`;
  const results = await confluence.search(cql, 10);

  if (results.results.length > 0) {
    lines.push(`\nFound ${results.results.length} related pages:\n`);
    for (const result of results.results) {
      const content = result.content;
      const title = content.title ?? "Untitled";
      const pageId = content.id ?? "unknown";

      let dateStr = "Unknown";
      try {
        const raw = content.history?.lastUpdated?.when;
        if (raw) dateStr = raw.split("T")[0]!;
      } catch {
        // ignore
      }

      const webLink = content._links?.webui;
      const pageUrl = webLink
        ? `${CONFLUENCE_BASE_URL}${webLink}`
        : `${CONFLUENCE_BASE_URL}/pages/viewpage.action?pageId=${pageId}`;

      lines.push(`- **[${title}](${pageUrl})** (Updated: ${dateStr})`);
    }
  } else {
    lines.push("\nNo related documentation found.");
  }

  return { section: "confluence", content: lines.join("\n") };
}

async function fetchBitbucketOverview(
  bitbucket: BitbucketClient,
  projectKey: string
): Promise<{ section: string; content: string }> {
  const lines: string[] = [];
  lines.push(`## Bitbucket: ${projectKey}`);

  const repos = await bitbucket.listRepos(projectKey, 25);

  if (repos.values.length === 0) {
    lines.push("\nNo repositories found in this project.");
    return { section: "bitbucket", content: lines.join("\n") };
  }

  lines.push(`\n${repos.size} repositories:\n`);

  // For the first 5 repos, fetch open PRs in parallel
  const reposToCheck = repos.values.slice(0, 5);
  const prResults = await Promise.allSettled(
    reposToCheck.map((repo) =>
      bitbucket.listPullRequests(projectKey, repo.slug, "OPEN", 5)
    )
  );

  for (let i = 0; i < reposToCheck.length; i++) {
    const repo = reposToCheck[i]!;
    let line = `### ${repo.name} (\`${repo.slug}\`)`;
    if (repo.description) line += `\n${repo.description}`;
    lines.push(line);

    const prResult = prResults[i]!;
    if (
      prResult.status === "fulfilled" &&
      prResult.value.values.length > 0
    ) {
      lines.push(`\nOpen PRs (${prResult.value.size}):`);
      for (const pr of prResult.value.values) {
        const date = new Date(pr.createdDate).toISOString().split("T")[0];
        lines.push(
          `- **#${pr.id}: ${pr.title}** [${pr.state}] — ${pi.scrub(pr.author.user.displayName)} (${date})`
        );
      }
    } else {
      lines.push("No open PRs.");
    }
    lines.push("");
  }

  // Mention remaining repos
  if (repos.values.length > 5) {
    const remaining = repos.values.slice(5).map((r) => r.name).join(", ");
    lines.push(`\n*Additional repos:* ${remaining}`);
  }

  return { section: "bitbucket", content: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Create and configure the Project Overview MCP server.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createOverviewServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Project Overview",
      version: "0.1.0",
    },
    {
      instructions: `You have access to a read-only project_overview tool that fetches a cross-system summary from Jira, Confluence, and Bitbucket for a given project key. All access is READ-ONLY — never attempt to create, modify, or delete any resources. Call it once with the project key, then summarize the results for the user. Never call the same tool twice with the same arguments. Never guess or fabricate project keys — if you don't know them, ask the user. If a tool returns an error, explain the error clearly to the user and suggest next steps. If you encounter authentication errors (401 Unauthorized or "No valid SMSESSION found"), inform the user they need to set ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD environment variables for Basic Auth, or re-authenticate via SMSESSION by running: node ${authCliPath}${WORKAROUND_NOTE}`,
    }
  );

  // Single shared SessionManager for all three clients.
  // All Atlassian services are behind the same SiteMinder SSO,
  // so one SMSESSION cookie works for all three.
  let jiraClient: JiraClient | null = null;
  let confluenceClient: ConfluenceClient | null = null;
  let bitbucketClient: BitbucketClient | null = null;

  async function initClients(): Promise<{
    jira: JiraClient;
    confluence: ConfluenceClient;
    bitbucket: BitbucketClient;
  }> {
    if (!jiraClient || !confluenceClient || !bitbucketClient) {
      const email = process.env["ATLASSIAN_EMAIL"];
      const password = process.env["ATLASSIAN_PASSWORD"];
      const baseUrl = process.env["ATLASSIAN_BASE_URL"];

      if (email && password && baseUrl) {
        const authFetch = createBasicAuthFetch(email, password);
        jiraClient = new JiraClient(authFetch, `${baseUrl}/int/jira`);
        confluenceClient = new ConfluenceClient(authFetch, `${baseUrl}/int/confluence`);
        bitbucketClient = new BitbucketClient(authFetch, `${baseUrl}/int/stash`);
      } else {
        const sessionManager = new SessionManager();
        const authFetch = await createAuthenticatedFetch(sessionManager);
        jiraClient = new JiraClient(authFetch);
        confluenceClient = new ConfluenceClient(authFetch);
        bitbucketClient = new BitbucketClient(authFetch);
      }
    }
    return {
      jira: jiraClient,
      confluence: confluenceClient,
      bitbucket: bitbucketClient,
    };
  }

  server.tool(
    "project_overview",
    `Get a cross-system overview of a project. Fetches active sprint status and recent issues from Jira, related documentation from Confluence, and repositories with recent PRs from Bitbucket. Returns a unified markdown summary with links.

IMPORTANT: The project key should match across systems (e.g., "DEMO" is both the Jira project key and the Bitbucket project key). Always include links when referencing results to the user.`,
    {
      projectKey: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,19}$/, "Invalid project key format")
        .describe(
          "Project key (e.g., DEMO, DMS). Used for Jira project, Bitbucket project, and Confluence search."
        ),
      includeJira: z
        .boolean()
        .default(true)
        .describe("Include Jira sprint and issues"),
      includeConfluence: z
        .boolean()
        .default(true)
        .describe("Include Confluence documentation"),
      includeBitbucket: z
        .boolean()
        .default(true)
        .describe("Include Bitbucket repos and PRs"),
    },
    { readOnlyHint: true },
    async ({ projectKey, includeJira, includeConfluence, includeBitbucket }) => {
      try {
        const { jira, confluence, bitbucket } = await initClients();

        // Build parallel tasks — use Promise.allSettled so partial
        // failure doesn't kill the whole overview.
        const tasks: Array<Promise<{ section: string; content: string }>> =
          [];

        if (includeJira) {
          tasks.push(fetchJiraOverview(jira, projectKey));
        }
        if (includeConfluence) {
          tasks.push(fetchConfluenceOverview(confluence, projectKey));
        }
        if (includeBitbucket) {
          tasks.push(fetchBitbucketOverview(bitbucket, projectKey));
        }

        const results = await Promise.allSettled(tasks);

        const sections: string[] = [];
        sections.push(`# Project Overview: ${projectKey}\n`);

        for (const result of results) {
          if (result.status === "fulfilled") {
            sections.push(result.value.content);
          } else {
            sections.push(
              `## Error\n${result.reason?.message ?? "Unknown error"}`
            );
          }
        }

        return {
          content: [
            { type: "text", text: sections.join("\n\n---\n\n") },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error generating project overview: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
