import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SessionManager,
  createAuthenticatedFetch,
  createBasicAuthFetch,
  PiScrubber,
} from "@nrs/auth";
import { JiraClient } from "@nrs/jira-mcp/client";
import { ConfluenceClient } from "@nrs/confluence-mcp/client";
import { BitbucketClient } from "@nrs/bitbucket-mcp/client";

import type {
  JiraIssue,
  JiraSearchResponse,
  JiraSprint,
  JiraBoard,
} from "@nrs/jira-mcp/client";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

/** Zod schema for a Jira project key — uppercase alphanumeric, prevents JQL/CQL injection. */
const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, "Invalid project key format (uppercase letters, digits, underscore)");

const JIRA_BASE_URL =
  process.env["JIRA_URL"] ??
  (process.env["ATLASSIAN_BASE_URL"]
    ? `${process.env["ATLASSIAN_BASE_URL"]}/int/jira`
    : "https://apps.example.gov.bc.ca/int/jira");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Days since a date string (ISO format). Returns null if unparseable. */
function daysSince(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  try {
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  } catch {
    return null;
  }
}

/** Check if a Jira status name represents a completed issue. */
function isCompletedStatus(statusName: string): boolean {
  const lower = statusName.toLowerCase();
  return lower === "done" || lower === "closed" || lower === "resolved";
}

/** Discover the primary Scrum board for a project. Returns null if none found. */
async function discoverBoard(
  jira: JiraClient,
  projectKey: string
): Promise<JiraBoard | null> {
  const boards = await jira.listBoards(projectKey);
  if (boards.values.length === 0) return null;
  return boards.values.find((b) => b.type === "scrum") ?? boards.values[0]!;
}

// ---------------------------------------------------------------------------
// Health score computation (shared by analyze_project_health + portfolio_health)
// ---------------------------------------------------------------------------

interface HealthDimension {
  name: string;
  score: number;
  max: number;
  detail: string;
}

interface HealthResult {
  projectKey: string;
  totalScore: number;
  maxScore: number;
  rating: string;
  dimensions: HealthDimension[];
  riskFlags: string[];
  recommendations: string[];
}

function healthRating(pct: number): string {
  if (pct >= 80) return "Healthy";
  if (pct >= 60) return "Needs Attention";
  if (pct >= 40) return "At Risk";
  return "Critical";
}

/**
 * Compute a composite project health score (0-100) from Jira, Confluence, and Bitbucket.
 *
 * Key design principles:
 *   - Dynamic scoring: dimensions that don't apply (no Bitbucket repos, no sprint
 *     board) are excluded, not penalized. Score is normalized to applicable max.
 *   - Stability-aware: a mature app with few open issues and no blockers is healthy,
 *     not neglected. Low activity is only a risk when combined with stale issues.
 *   - Softer thresholds: 60-day staleness (not 30), only In Progress tickets
 *     flagged as stalled.
 *
 * Uses Promise.allSettled so partial failures don't kill the whole analysis.
 */
async function computeProjectHealth(
  jira: JiraClient,
  confluence: ConfluenceClient,
  bitbucket: BitbucketClient,
  projectKey: string
): Promise<HealthResult> {
  const dimensions: HealthDimension[] = [];
  const riskFlags: string[] = [];
  const recommendations: string[] = [];

  // --- Parallel fetch across all 3 systems + FLARE security ---
  const [jiraResult, confluenceResult, bitbucketResult, flareResult] =
    await Promise.allSettled([
      // Jira: board discovery + open issues
      (async () => {
        const [boardResult, openResult] = await Promise.allSettled([
          (async () => {
            const board = await discoverBoard(jira, projectKey);
            if (!board) return null;
            const sprints = await jira.getBoardSprints(board.id, "closed");
            if (sprints.values.length === 0) return null;
            const lastSprint = sprints.values[sprints.values.length - 1]!;
            const issues = await jira.getSprintIssues(lastSprint.id, 50);
            return { sprint: lastSprint, issues: issues.issues };
          })(),
          jira.searchIssues(
            `project = ${projectKey} AND status NOT IN (Done, Closed, Resolved) ORDER BY updated ASC`,
            50
          ),
        ]);
        return { boardResult, openResult };
      })(),
      // Confluence: page freshness
      confluence.search(
        `text ~ "${projectKey}" AND type = "page" ORDER BY lastModified DESC`,
        10
      ),
      // Bitbucket: repos + PRs
      (async () => {
        try {
          const repos = await bitbucket.listRepos(projectKey, 5);
          if (repos.values.length === 0) return null; // No repos — skip Bitbucket scoring
          const firstRepo = repos.values[0]!;
          const [openPRs, mergedPRs] = await Promise.allSettled([
            bitbucket.listPullRequests(projectKey, firstRepo.slug, "OPEN", 10),
            bitbucket.listPullRequests(projectKey, firstRepo.slug, "MERGED", 10),
          ]);
          return {
            repos: repos.values,
            openPRs: openPRs.status === "fulfilled" ? openPRs.value.values : [],
            mergedPRs: mergedPRs.status === "fulfilled" ? mergedPRs.value.values : [],
          };
        } catch {
          return null; // Bitbucket unavailable or project not found — skip
        }
      })(),
      // FLARE: security vulnerability issues linked to this project
      (async () => {
        try {
          const result = await jira.searchIssues(
            `project = FLARE AND summary ~ "${projectKey}" AND status NOT IN (Done, Closed, Resolved) ORDER BY created DESC`,
            50
          );
          return result;
        } catch {
          return null; // FLARE project may not exist or be inaccessible
        }
      })(),
    ]);

  // Track open issue count for stability bonus calculation
  let totalOpen = 0;
  let hasBlockers = false;

  // --- Score Jira dimensions ---
  if (jiraResult.status === "fulfilled") {
    const { boardResult, openResult } = jiraResult.value;

    // Sprint velocity (20 pts) — only scored if project uses sprints
    if (boardResult.status === "fulfilled" && boardResult.value) {
      const { issues } = boardResult.value;
      const total = issues.length;
      const completed = issues.filter((i) =>
        isCompletedStatus(i.fields.status.name)
      ).length;
      const rate = total > 0 ? (completed / total) * 100 : 0;
      let score = 5;
      if (rate >= 80) score = 20;
      else if (rate >= 60) score = 15;
      else if (rate >= 40) score = 10;
      dimensions.push({
        name: "Sprint velocity",
        score,
        max: 20,
        detail: `Last sprint: ${Math.round(rate)}% completion (${completed}/${total})`,
      });
      if (rate < 60) {
        riskFlags.push(`Low sprint completion rate (${Math.round(rate)}%)`);
        recommendations.push("Review sprint planning — reduce scope or address blockers");
      }
    }
    // No sprint board → dimension simply excluded (not penalized)

    // Issue aging (20 pts) + Unassigned (10 pts)
    if (openResult.status === "fulfilled") {
      const openIssues = openResult.value.issues;
      totalOpen = openResult.value.total;

      // Check for blockers
      hasBlockers = openIssues.some((i) => {
        const pri = (i.fields.priority?.name ?? "").toLowerCase();
        return pri === "blocker" || pri === "critical";
      });

      // Aging — uses 60-day threshold (not 30)
      const staleCount = openIssues.filter((i) => {
        const days = daysSince(i.fields.updated);
        return days !== null && days > 60;
      }).length;
      const staleRatio = totalOpen > 0 ? staleCount / totalOpen : 0;
      let agingScore = 5;
      if (staleRatio === 0) agingScore = 20;
      else if (staleRatio < 0.1) agingScore = 15;
      else if (staleRatio < 0.25) agingScore = 10;
      dimensions.push({
        name: "Issue aging",
        score: agingScore,
        max: 20,
        detail: `${Math.round(staleRatio * 100)}% of ${totalOpen} open issues stale >60 days`,
      });
      if (staleRatio >= 0.25) {
        riskFlags.push(`${staleCount} issues stale >60 days (${Math.round(staleRatio * 100)}%)`);
        recommendations.push("Triage stale backlog — close, reassign, or update aging tickets");
      }

      // Stalled In Progress (only In Progress, not backlog items)
      const stalledIP = openIssues.filter((i) => {
        const status = i.fields.status.name.toLowerCase();
        const stale = daysSince(i.fields.updated);
        return status.includes("progress") && stale !== null && stale > 14;
      });
      if (stalledIP.length > 0) {
        riskFlags.push(`${stalledIP.length} tickets stalled In Progress >14 days`);
        recommendations.push("Review stalled in-progress tickets for blockers");
      }

      // Unassigned (10 pts)
      const unassigned = openIssues.filter(
        (i) => !i.fields.assignee
      ).length;
      const unassignedRatio = totalOpen > 0 ? unassigned / totalOpen : 0;
      let unassignedScore = 2;
      if (totalOpen === 0 || unassignedRatio === 0) unassignedScore = 10;
      else if (unassignedRatio < 0.1) unassignedScore = 7;
      else if (unassignedRatio < 0.25) unassignedScore = 4;
      dimensions.push({
        name: "Unassigned work",
        score: unassignedScore,
        max: 10,
        detail: totalOpen === 0
          ? "No open issues"
          : `${unassigned}/${totalOpen} open issues unassigned (${Math.round(unassignedRatio * 100)}%)`,
      });
      if (unassignedRatio >= 0.25) {
        riskFlags.push(`${Math.round(unassignedRatio * 100)}% of work unassigned`);
        recommendations.push("Assign owners to open tickets to ensure accountability");
      }
    } else {
      dimensions.push(
        { name: "Issue aging", score: 0, max: 20, detail: "Failed to fetch open issues" },
        { name: "Unassigned work", score: 0, max: 10, detail: "Failed to fetch open issues" }
      );
    }
  } else {
    dimensions.push(
      { name: "Issue aging", score: 0, max: 20, detail: "Jira unavailable" },
      { name: "Unassigned work", score: 0, max: 10, detail: "Jira unavailable" }
    );
  }

  // --- Stability bonus (15 pts) ---
  // Rewards well-maintained apps: few open issues and no blockers
  {
    let stabilityScore = 0;
    let stabilityDetail = "";
    if (totalOpen === 0) {
      stabilityScore = 15;
      stabilityDetail = "No open issues — clean backlog";
    } else if (totalOpen <= 5 && !hasBlockers) {
      stabilityScore = 12;
      stabilityDetail = `Only ${totalOpen} open issues, no blockers`;
    } else if (totalOpen <= 15 && !hasBlockers) {
      stabilityScore = 8;
      stabilityDetail = `${totalOpen} open issues, no blockers`;
    } else if (totalOpen <= 15) {
      stabilityScore = 5;
      stabilityDetail = `${totalOpen} open issues (has blockers/critical)`;
    } else {
      stabilityScore = 3;
      stabilityDetail = `${totalOpen} open issues`;
    }
    dimensions.push({
      name: "Stability",
      score: stabilityScore,
      max: 15,
      detail: stabilityDetail,
    });
  }

  // --- Security posture (15 pts) — FLARE vulnerability issues ---
  if (flareResult.status === "fulfilled" && flareResult.value) {
    const flareData = flareResult.value;
    const totalFlare = flareData.total;
    const flareIssues = flareData.issues;

    // Count PROD-specific issues (higher severity)
    const prodFlare = flareIssues.filter((i) =>
      (i.fields.summary ?? "").toUpperCase().includes("PROD")
    ).length;

    let secScore = 0;
    if (totalFlare === 0) secScore = 15;
    else if (totalFlare <= 5) secScore = 12;
    else if (totalFlare <= 15) secScore = 8;
    else if (totalFlare <= 30) secScore = 4;

    const prodNote = prodFlare > 0 ? `, ${prodFlare} in PROD` : "";
    dimensions.push({
      name: "Security posture",
      score: secScore,
      max: 15,
      detail: `${totalFlare} open FLARE issues${prodNote}`,
    });

    if (totalFlare > 15) {
      riskFlags.push(`${totalFlare} open security vulnerabilities (FLARE)${prodNote}`);
      recommendations.push("Prioritize security remediation — address PROD vulnerabilities first");
    } else if (prodFlare > 0) {
      riskFlags.push(`${prodFlare} PROD security vulnerabilities open`);
      recommendations.push("Review and remediate PROD FLARE issues");
    }

    // Flag known high-risk libraries
    const highRiskLibs = ["log4j", "struts", "spring-security", "jackson-databind"];
    const foundHighRisk = flareIssues
      .filter((i) => {
        const summary = (i.fields.summary ?? "").toLowerCase();
        return summary.includes("prod") && highRiskLibs.some((lib) => summary.includes(lib));
      })
      .map((i) => i.fields.summary ?? i.key);
    if (foundHighRisk.length > 0) {
      riskFlags.push(`High-risk PROD vulnerabilities: ${foundHighRisk.slice(0, 3).join(", ")}${foundHighRisk.length > 3 ? ` (+${foundHighRisk.length - 3} more)` : ""}`);
    }
  }
  // No FLARE data → dimension excluded (not penalized)

  // --- Score Confluence dimension ---
  if (confluenceResult.status === "fulfilled") {
    const pages = confluenceResult.value.results;
    if (pages.length > 0) {
      const ages = pages
        .map((p) => daysSince(p.content.history?.lastUpdated?.when))
        .filter((d): d is number => d !== null);
      const avgAge = ages.length > 0
        ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length)
        : 999;
      let docScore = 2;
      if (avgAge < 90) docScore = 15;
      else if (avgAge < 180) docScore = 10;
      else if (avgAge < 365) docScore = 5;
      dimensions.push({
        name: "Documentation freshness",
        score: docScore,
        max: 15,
        detail: `${pages.length} pages found, avg age ${avgAge} days`,
      });
      if (avgAge >= 365) {
        riskFlags.push(`Documentation is stale (avg ${avgAge} days old)`);
        recommendations.push("Schedule a documentation review/refresh sprint");
      }
    } else {
      dimensions.push({
        name: "Documentation freshness",
        score: 2,
        max: 15,
        detail: "No Confluence pages found for this project",
      });
      riskFlags.push("No documentation found in Confluence");
      recommendations.push("Create project documentation in Confluence");
    }
  } else {
    dimensions.push({
      name: "Documentation freshness",
      score: 0,
      max: 15,
      detail: "Confluence unavailable",
    });
  }

  // --- Score Bitbucket dimensions (only if repos exist) ---
  const bbData = bitbucketResult.status === "fulfilled" ? bitbucketResult.value : null;

  if (bbData) {
    // Code activity (15 pts) — recent merged PRs
    const recentMerged = bbData.mergedPRs.filter((pr) => {
      const age = daysSince(new Date(pr.updatedDate).toISOString());
      return age !== null && age <= 30;
    });
    let codeScore = 3;
    if (recentMerged.length >= 5) codeScore = 15;
    else if (recentMerged.length >= 3) codeScore = 12;
    else if (recentMerged.length >= 1) codeScore = 8;
    dimensions.push({
      name: "Code activity",
      score: codeScore,
      max: 15,
      detail: `${recentMerged.length} PRs merged in last 30 days (${bbData.repos.length} repos)`,
    });
    if (recentMerged.length === 0) {
      riskFlags.push("No PRs merged in the last 30 days");
      recommendations.push("Verify development is active — no recent code merges detected");
    }

    // PR health (10 pts) — open PR age
    if (bbData.openPRs.length > 0) {
      const prAges = bbData.openPRs.map((pr) =>
        daysSince(new Date(pr.createdDate).toISOString()) ?? 0
      );
      const avgPrAge = Math.round(
        prAges.reduce((a, b) => a + b, 0) / prAges.length
      );
      let prScore = 2;
      if (avgPrAge < 7) prScore = 10;
      else if (avgPrAge < 14) prScore = 7;
      else if (avgPrAge < 30) prScore = 4;
      dimensions.push({
        name: "PR review health",
        score: prScore,
        max: 10,
        detail: `${bbData.openPRs.length} open PRs, avg age ${avgPrAge} days`,
      });
      if (avgPrAge >= 14) {
        riskFlags.push(`${bbData.openPRs.length} open PRs averaging ${avgPrAge} days old`);
        recommendations.push("Address aging PRs to maintain code review velocity");
      }
    } else {
      dimensions.push({
        name: "PR review health",
        score: 10,
        max: 10,
        detail: "No open PRs (clean queue)",
      });
    }
  }
  // No Bitbucket repos → dimensions excluded entirely (not penalized)

  // --- Compute normalized score ---
  const totalScore = dimensions.reduce((sum, d) => sum + d.score, 0);
  const maxScore = dimensions.reduce((sum, d) => sum + d.max, 0);
  const normalizedScore = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  return {
    projectKey,
    totalScore: normalizedScore,
    maxScore: 100,
    rating: healthRating(normalizedScore),
    dimensions,
    riskFlags,
    recommendations,
  };
}

/** Format a HealthResult as markdown. */
function formatHealthResult(result: HealthResult): string {
  const lines: string[] = [];

  lines.push(`# Project Health: ${result.projectKey}`);
  lines.push("");
  const rawTotal = result.dimensions.reduce((s, d) => s + d.score, 0);
  const rawMax = result.dimensions.reduce((s, d) => s + d.max, 0);
  lines.push(`## Overall Score: ${result.totalScore}/100 (${result.rating})`);
  lines.push(`*Raw: ${rawTotal}/${rawMax} across ${result.dimensions.length} applicable dimensions*`);
  lines.push("");
  lines.push("| Dimension | Score | Max | Assessment |");
  lines.push("|-----------|-------|-----|------------|");
  for (const d of result.dimensions) {
    lines.push(`| ${d.name} | ${d.score} | ${d.max} | ${d.detail} |`);
  }

  if (result.riskFlags.length > 0) {
    lines.push("");
    lines.push("## Risk Flags");
    for (const flag of result.riskFlags) {
      lines.push(`- ${flag}`);
    }
  }

  if (result.recommendations.length > 0) {
    lines.push("");
    lines.push("## Recommendations");
    for (const rec of result.recommendations) {
      lines.push(`- ${rec}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Create and configure the Project Health Analysis MCP server.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createHealthServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Project Health",
      version: "0.1.0",
    },
    {
      instructions: `You have access to read-only project health analysis tools that compute derived metrics from Jira, Confluence, and Bitbucket data. All access is READ-ONLY — never attempt to create, modify, or delete any resources. Keep API calls to a minimum. Call a tool once, then summarize the results for the user — never call the same tool twice with the same arguments. Never guess or fabricate project keys. If a tool returns an error, explain it clearly and suggest next steps. If you encounter authentication errors (401 Unauthorized), inform the user they need to check their ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD in ~/.raven/.env.${WORKAROUND_NOTE}`,
    }
  );

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

  // --- Tool 1: analyze_sprint_velocity ---

  server.tool(
    "analyze_sprint_velocity",
    "Analyze sprint velocity trends from closed sprint history. Shows planned vs completed issues per sprint, average velocity, completion rate, and trend direction (improving/stable/declining). Velocity is measured by issue count.",
    {
      projectKey: projectKeySchema
        .describe("Jira project key (e.g., DEMO, DMS, PROJ1)"),
      sprintCount: z
        .number()
        .min(2)
        .max(10)
        .default(5)
        .describe("Number of recent closed sprints to analyze (2-10, default 5)"),
    },
    { readOnlyHint: true },
    async ({ projectKey, sprintCount }) => {
      try {
        const { jira } = await initClients();

        // Step 1: Discover board
        const board = await discoverBoard(jira, projectKey);
        if (!board) {
          return {
            content: [
              {
                type: "text",
                text: `No Agile board found for project ${projectKey}. Sprint velocity analysis requires a Scrum board.`,
              },
            ],
          };
        }

        // Step 2: Get closed sprints
        const sprints = await jira.getBoardSprints(board.id, "closed");
        if (sprints.values.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No closed sprints found on board "${board.name}" (ID ${board.id}). Need at least 2 closed sprints for velocity analysis.`,
              },
            ],
          };
        }

        // Sort by completeDate descending, take last N
        const sorted = [...sprints.values]
          .filter((s) => s.completeDate)
          .sort(
            (a, b) =>
              new Date(b.completeDate!).getTime() -
              new Date(a.completeDate!).getTime()
          )
          .slice(0, sprintCount);

        if (sorted.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: `Only ${sorted.length} closed sprint(s) found. Need at least 2 for velocity analysis.`,
              },
            ],
          };
        }

        // Step 3: Fetch issues for each sprint
        const sprintData: Array<{
          sprint: JiraSprint;
          total: number;
          completed: number;
          rate: number;
        }> = [];

        for (const sprint of sorted) {
          const issues = await jira.getSprintIssues(sprint.id, 50);
          const total = issues.issues.length;
          const completed = issues.issues.filter((i) =>
            isCompletedStatus(i.fields.status.name)
          ).length;
          const rate = total > 0 ? (completed / total) * 100 : 0;
          sprintData.push({ sprint, total, completed, rate });
        }

        // Step 4: Compute aggregates
        const avgVelocity =
          sprintData.reduce((sum, s) => sum + s.completed, 0) /
          sprintData.length;
        const avgRate =
          sprintData.reduce((sum, s) => sum + s.rate, 0) /
          sprintData.length;

        // Trend: compare most recent sprint to average of earlier ones
        const latest = sprintData[0]!;
        const earlierAvg =
          sprintData.length > 1
            ? sprintData
                .slice(1)
                .reduce((sum, s) => sum + s.completed, 0) /
              (sprintData.length - 1)
            : latest.completed;
        const trendPct =
          earlierAvg > 0
            ? ((latest.completed - earlierAvg) / earlierAvg) * 100
            : 0;
        let trend = "Stable";
        if (trendPct > 10) trend = "Improving";
        else if (trendPct < -10) trend = "Declining";

        // Step 5: Format output
        const lines: string[] = [];
        lines.push(`# Sprint Velocity Analysis: ${projectKey}`);
        lines.push(`**Board:** ${board.name} (${board.type}, ID ${board.id})`);
        lines.push("");
        lines.push("## Summary");
        lines.push(`- **Sprints analyzed:** ${sprintData.length}`);
        lines.push(
          `- **Average velocity:** ${avgVelocity.toFixed(1)} issues/sprint`
        );
        lines.push(`- **Average completion rate:** ${Math.round(avgRate)}%`);
        lines.push(
          `- **Trend:** ${trend} (${trendPct >= 0 ? "+" : ""}${Math.round(trendPct)}% vs prior average)`
        );
        lines.push("");
        lines.push("## Sprint Breakdown");
        lines.push("| Sprint | Dates | Planned | Completed | Rate |");
        lines.push("|--------|-------|---------|-----------|------|");

        // Reverse so oldest is first (chronological order)
        for (const s of [...sprintData].reverse()) {
          const start = s.sprint.startDate?.split("T")[0] ?? "?";
          const end = s.sprint.completeDate?.split("T")[0] ?? "?";
          lines.push(
            `| ${s.sprint.name} | ${start} → ${end} | ${s.total} | ${s.completed} | ${Math.round(s.rate)}% |`
          );
        }

        // Observations
        lines.push("");
        lines.push("## Observations");
        if (trend === "Improving") {
          lines.push(
            `- Velocity is trending upward — latest sprint completed ${latest.completed} issues vs average of ${avgVelocity.toFixed(1)}`
          );
        } else if (trend === "Declining") {
          lines.push(
            `- Velocity is declining — latest sprint completed ${latest.completed} issues vs average of ${avgVelocity.toFixed(1)}`
          );
          lines.push("- Consider reviewing scope, blockers, or team capacity");
        }
        const lowSprints = sprintData.filter((s) => s.rate < 60);
        if (lowSprints.length > 0) {
          lines.push(
            `- ${lowSprints.length} sprint(s) had completion rate below 60% — may indicate scope creep or blockers`
          );
        }
        lines.push("");
        lines.push(
          "*Note: Velocity is measured by issue count, not story points. \"Planned\" is the total issue count at sprint close.*"
        );

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing sprint velocity: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool 2: analyze_issue_aging ---

  server.tool(
    "analyze_issue_aging",
    "Analyze open issue aging distribution and stalled work for a project. Shows aging buckets (30/60/90+ days), average age by status, stalled In Progress tickets, and unassigned work.",
    {
      projectKey: projectKeySchema
        .describe("Jira project key (e.g., DEMO, DMS, PROJ1)"),
    },
    { readOnlyHint: true },
    async ({ projectKey }) => {
      try {
        const { jira } = await initClients();

        const result = await jira.searchIssues(
          `project = ${projectKey} AND status NOT IN (Done, Closed, Resolved) ORDER BY updated ASC`,
          50
        );

        if (result.issues.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No open issues found for project ${projectKey}.`,
              },
            ],
          };
        }

        const issues = result.issues;
        const totalOpen = result.total;

        // Age buckets (by created date)
        const buckets = { "<30d": 0, "30-60d": 0, "60-90d": 0, "90+d": 0 };
        const agesByStatus: Record<string, number[]> = {};

        for (const issue of issues) {
          const daysOpen = daysSince(issue.fields.created) ?? 0;
          if (daysOpen < 30) buckets["<30d"]++;
          else if (daysOpen < 60) buckets["30-60d"]++;
          else if (daysOpen < 90) buckets["60-90d"]++;
          else buckets["90+d"]++;

          const status = issue.fields.status.name;
          if (!agesByStatus[status]) agesByStatus[status] = [];
          agesByStatus[status].push(daysOpen);
        }

        // Stalled In Progress (updated >14 days ago)
        const stalledIP = issues.filter((i) => {
          const status = i.fields.status.name.toLowerCase();
          const stale = daysSince(i.fields.updated);
          return status.includes("progress") && stale !== null && stale > 14;
        });

        // Unassigned
        const unassigned = issues.filter((i) => !i.fields.assignee);

        // Aging 90+ day tickets
        const aging90 = issues.filter((i) => {
          const days = daysSince(i.fields.created);
          return days !== null && days >= 90;
        });

        // Format output
        const lines: string[] = [];
        lines.push(`# Issue Aging Analysis: ${projectKey}`);
        lines.push("");
        lines.push(
          `## Distribution (${totalOpen} open issues, showing ${issues.length})`
        );
        lines.push("| Age Bucket | Count | % |");
        lines.push("|------------|-------|---|");
        for (const [bucket, count] of Object.entries(buckets)) {
          const pct = issues.length > 0 ? Math.round((count / issues.length) * 100) : 0;
          lines.push(`| ${bucket} | ${count} | ${pct}% |`);
        }

        lines.push("");
        lines.push("## Average Age by Status");
        for (const [status, ages] of Object.entries(agesByStatus)) {
          const avg = Math.round(
            ages.reduce((a, b) => a + b, 0) / ages.length
          );
          lines.push(`- **${status}:** ${avg} days (${ages.length} issues)`);
        }

        if (stalledIP.length > 0) {
          lines.push("");
          lines.push(
            `## Risk: Stalled In Progress (${stalledIP.length} tickets not updated >14 days)`
          );
          for (const issue of stalledIP) {
            const stale = daysSince(issue.fields.updated) ?? 0;
            const issueUrl = `${JIRA_BASE_URL}/browse/${issue.key}`;
            lines.push(
              `- **[${issue.key}](${issueUrl})** ${issue.fields.summary} — ${stale} days stale, ${pi.scrub(issue.fields.assignee?.displayName) ?? "Unassigned"}`
            );
          }
        }

        if (unassigned.length > 0) {
          lines.push("");
          lines.push(`## Unassigned Work (${unassigned.length} issues)`);
          const highPri = unassigned.filter((i) => {
            const pri = (i.fields.priority?.name ?? "").toLowerCase();
            return (
              pri === "blocker" ||
              pri === "critical" ||
              pri === "high" ||
              pri === "highest"
            );
          });
          if (highPri.length > 0) {
            lines.push(`- **${highPri.length} high priority** items need an owner`);
          }
          for (const issue of unassigned.slice(0, 10)) {
            const issueUrl = `${JIRA_BASE_URL}/browse/${issue.key}`;
            lines.push(
              `- **[${issue.key}](${issueUrl})** ${issue.fields.summary} [${issue.fields.status.name}] (${issue.fields.priority?.name ?? "None"})`
            );
          }
        }

        if (aging90.length > 0) {
          lines.push("");
          lines.push(`## Aging Tickets — 90+ Days (${aging90.length})`);
          for (const issue of aging90.slice(0, 10)) {
            const daysOpen = daysSince(issue.fields.created) ?? 0;
            const issueUrl = `${JIRA_BASE_URL}/browse/${issue.key}`;
            lines.push(
              `- **[${issue.key}](${issueUrl})** ${issue.fields.summary} [${issue.fields.status.name}] — ${daysOpen} days old`
            );
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
              text: `Error analyzing issue aging: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool 3: analyze_project_health ---

  server.tool(
    "analyze_project_health",
    "Compute a composite project health score (0-100) drawing from Jira, Confluence, and Bitbucket. Evaluates sprint velocity, issue aging, unassigned work, documentation freshness, code activity, and PR review health. Returns a score with dimensional breakdown, risk flags, and recommendations.",
    {
      projectKey: projectKeySchema
        .describe(
          "Project key (e.g., DEMO, DMS). Used across Jira, Confluence, and Bitbucket."
        ),
    },
    { readOnlyHint: true },
    async ({ projectKey }) => {
      try {
        const { jira, confluence, bitbucket } = await initClients();
        const result = await computeProjectHealth(
          jira,
          confluence,
          bitbucket,
          projectKey
        );
        return {
          content: [{ type: "text", text: formatHealthResult(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing project health: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool 4: analyze_workload ---

  server.tool(
    "analyze_workload",
    "Analyze work distribution across team members for one or more projects. Shows active issues per person grouped by status and priority. Flags overloaded individuals (>10 active issues or >3 concurrent In Progress).",
    {
      projectKeys: z
        .union([projectKeySchema, z.array(projectKeySchema)])
        .describe(
          "Single project key or array of project keys (e.g., 'DEMO' or ['DEMO', 'DMS'])"
        ),
    },
    { readOnlyHint: true },
    async ({ projectKeys }) => {
      try {
        const { jira } = await initClients();

        const keys = Array.isArray(projectKeys)
          ? projectKeys
          : [projectKeys];
        const projectFilter =
          keys.length === 1
            ? `project = ${keys[0]}`
            : `project IN (${keys.join(", ")})`;

        const result = await jira.searchIssues(
          `${projectFilter} AND status NOT IN (Done, Closed, Resolved) ORDER BY assignee ASC`,
          50
        );

        if (result.issues.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No active issues found for ${keys.join(", ")}.`,
              },
            ],
          };
        }

        // Group by assignee
        const byPerson: Record<
          string,
          {
            total: number;
            inProgress: number;
            toDo: number;
            blocked: number;
            highPriority: number;
          }
        > = {};

        for (const issue of result.issues) {
          const person =
            pi.scrub(issue.fields.assignee?.displayName) ?? "Unassigned";
          if (!byPerson[person]) {
            byPerson[person] = {
              total: 0,
              inProgress: 0,
              toDo: 0,
              blocked: 0,
              highPriority: 0,
            };
          }
          const entry = byPerson[person]!;
          entry.total++;

          const status = issue.fields.status.name.toLowerCase();
          if (status.includes("progress")) entry.inProgress++;
          else if (
            status === "open" ||
            status === "to do" ||
            status === "reopened"
          )
            entry.toDo++;
          else if (status.includes("block") || status.includes("hold"))
            entry.blocked++;

          const pri = (issue.fields.priority?.name ?? "").toLowerCase();
          if (
            pri === "blocker" ||
            pri === "critical" ||
            pri === "high" ||
            pri === "highest"
          )
            entry.highPriority++;
        }

        // Format output
        const lines: string[] = [];
        lines.push(
          `# Workload Analysis: ${keys.join(", ")}`
        );
        lines.push("");
        lines.push(
          `## Team Distribution (${result.total} active issues, showing ${result.issues.length})`
        );
        lines.push(
          "| Person | Total | In Progress | To Do | Blocked | High/Critical |"
        );
        lines.push(
          "|--------|-------|-------------|-------|---------|---------------|"
        );

        // Sort by total descending
        const sorted = Object.entries(byPerson).sort(
          ([, a], [, b]) => b.total - a.total
        );
        for (const [person, stats] of sorted) {
          lines.push(
            `| ${person} | ${stats.total} | ${stats.inProgress} | ${stats.toDo} | ${stats.blocked} | ${stats.highPriority} |`
          );
        }

        // Overload warnings
        const overloaded = sorted.filter(
          ([name, stats]) =>
            name !== "Unassigned" &&
            (stats.total > 10 || stats.inProgress > 3)
        );
        if (overloaded.length > 0) {
          lines.push("");
          lines.push("## Overload Warnings");
          for (const [name, stats] of overloaded) {
            const reasons: string[] = [];
            if (stats.total > 10)
              reasons.push(`${stats.total} active issues`);
            if (stats.inProgress > 3)
              reasons.push(`${stats.inProgress} concurrent In Progress`);
            if (stats.blocked > 0)
              reasons.push(`${stats.blocked} blocked`);
            lines.push(`- **${name}** — ${reasons.join(", ")}`);
          }
        }

        // Unassigned summary
        const unassignedStats = byPerson["Unassigned"];
        if (unassignedStats && unassignedStats.total > 0) {
          lines.push("");
          lines.push(
            `## Unassigned Work: ${unassignedStats.total} issues (${unassignedStats.highPriority} high priority)`
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing workload: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- Tool 5: portfolio_health ---

  server.tool(
    "portfolio_health",
    "Compare project health scores across multiple projects side by side. Runs health analysis for each project in parallel and presents a comparative dashboard with portfolio-wide risks.",
    {
      projectKeys: z
        .array(projectKeySchema)
        .min(2)
        .max(6)
        .describe(
          "Array of project keys to compare (2-6, e.g., ['DEMO', 'DMS', 'PROJ1'])"
        ),
    },
    { readOnlyHint: true },
    async ({ projectKeys }) => {
      try {
        const { jira, confluence, bitbucket } = await initClients();

        // Run health analysis for all projects in parallel
        const results = await Promise.allSettled(
          projectKeys.map((key) =>
            computeProjectHealth(jira, confluence, bitbucket, key)
          )
        );

        const healthResults: HealthResult[] = [];
        const errors: string[] = [];

        for (let i = 0; i < results.length; i++) {
          const result = results[i]!;
          if (result.status === "fulfilled") {
            healthResults.push(result.value);
          } else {
            errors.push(
              `${projectKeys[i]}: ${result.reason?.message ?? "Unknown error"}`
            );
          }
        }

        if (healthResults.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to analyze any projects:\n${errors.join("\n")}`,
              },
            ],
            isError: true,
          };
        }

        // Format portfolio dashboard
        const lines: string[] = [];
        lines.push("# Portfolio Health Dashboard");
        lines.push("");

        // Scores overview table
        lines.push("## Scores Overview");
        lines.push("| Project | Score | Rating | Key Signal |");
        lines.push("|---------|-------|--------|------------|");
        for (const r of healthResults.sort(
          (a, b) => b.totalScore - a.totalScore
        )) {
          const topRisk =
            r.riskFlags.length > 0
              ? r.riskFlags[0]
              : "No significant risks";
          lines.push(
            `| **${r.projectKey}** | ${r.totalScore}/${r.maxScore} | ${r.rating} | ${topRisk} |`
          );
        }

        // Dimension comparison table
        if (healthResults.length >= 2) {
          lines.push("");
          lines.push("## Dimension Comparison");

          // Build header
          const header =
            "| Dimension | " +
            healthResults.map((r) => r.projectKey).join(" | ") +
            " |";
          const separator =
            "|-----------|" +
            healthResults.map(() => "---").join("|") +
            "|";
          lines.push(header);
          lines.push(separator);

          // All projects should have same dimensions in same order
          const dimCount = healthResults[0]!.dimensions.length;
          for (let d = 0; d < dimCount; d++) {
            const dimName = healthResults[0]!.dimensions[d]!.name;
            const cells = healthResults.map((r) => {
              const dim = r.dimensions[d];
              return dim ? `${dim.score}/${dim.max}` : "—";
            });
            lines.push(`| ${dimName} | ${cells.join(" | ")} |`);
          }
        }

        // Portfolio-wide risks
        const allRisks = healthResults.flatMap((r) =>
          r.riskFlags.map((flag) => `**${r.projectKey}:** ${flag}`)
        );
        if (allRisks.length > 0) {
          lines.push("");
          lines.push("## Portfolio Risks");
          for (const risk of allRisks) {
            lines.push(`- ${risk}`);
          }
        }

        // Recommendations
        const atRisk = healthResults.filter(
          (r) => r.rating === "At Risk" || r.rating === "Critical"
        );
        if (atRisk.length > 0) {
          lines.push("");
          lines.push("## Priority Actions");
          for (const r of atRisk) {
            lines.push(`- **${r.projectKey}** (${r.rating}) — needs immediate attention`);
            for (const rec of r.recommendations.slice(0, 2)) {
              lines.push(`  - ${rec}`);
            }
          }
        }

        if (errors.length > 0) {
          lines.push("");
          lines.push("## Errors");
          for (const err of errors) {
            lines.push(`- ${err}`);
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
              text: `Error analyzing portfolio health: ${safeErr(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
