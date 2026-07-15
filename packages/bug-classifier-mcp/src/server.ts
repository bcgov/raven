import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PiScrubber } from "@nrs/auth";
import { fetchTickets, getJiraBaseUrl } from "./ingest/jira-client.js";
import { scoreAllPairs } from "./engine/scorer.js";
import { buildClusters } from "./engine/clusterer.js";
import { generateReport } from "./output/markdown-report.js";
import { config } from "./config.js";
import type { Cluster } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

/**
 * Jira project keys: uppercase letter followed by 1–19 letters/digits/underscores
 * (2–20 total chars). Same shape used by health-mcp and overview-mcp. Validating
 * here also prevents path traversal via the cache-file path: without this
 * check, projects="../../foo" would escape the .cache dir when passed to
 * getCachePath.
 *
 * Exported for unit-testing.
 */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

const SIGNAL_LABELS: Record<string, string> = {
  textSimilarity: 'Text Similarity',
  errorPattern: 'Error Pattern',
  componentLabel: 'Component/Label',
  affectedArea: 'Affected Area',
  temporalProximity: 'Temporal Proximity',
};

function formatClusterSummary(clusters: Cluster[], totalTickets: number): string {
  const clusteredCount = clusters.reduce((sum, c) => sum + c.tickets.length, 0);
  const crossProjectCount = clusters.filter((c) => c.isCrossProject).length;
  // "Unclustered" rather than "unmatched": this set includes both tickets
  // that had no peer above threshold AND tickets dropped by oversized-
  // cluster pruning (star-shape clusters that shattered to singletons).
  const unclusteredCount = totalTickets - clusteredCount;

  const lines: string[] = [];
  lines.push(`Analyzed ${totalTickets} tickets — ${clusters.length} clusters found (${clusteredCount} clustered, ${unclusteredCount} unclustered, ${crossProjectCount} cross-project)`);
  lines.push('');

  for (const c of clusters) {
    const crossTag = c.isCrossProject ? ' [CROSS-PROJECT]' : '';
    const signals = c.matchingSignals.map((s) => SIGNAL_LABELS[s] ?? s).join(', ');
    lines.push(`### Cluster ${c.id}: ${c.title} (${c.tickets.length} tickets)${crossTag}`);
    lines.push(`Confidence: ${c.confidenceLevel} (${c.avgConfidence.toFixed(2)}) | Signals: ${signals}`);
    lines.push(`Cause: ${c.probableCause}`);
    lines.push(`Action: ${c.suggestedAction}`);
    lines.push(`Tickets: ${c.tickets.map((t) => t.key).join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Create and configure the Bug Classifier MCP server.
 *
 * Tools fetch bug tickets from Jira, score pairs using 5 heuristic signals,
 * cluster by shared root cause, and return structured analysis.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createBugClassifierServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Bug Classifier",
      version: "0.1.0",
    },
    {
      instructions: "Bug pattern classifier that groups Jira bug tickets by shared root cause using multi-signal analysis (text similarity, error patterns, component/label overlap, affected area keywords, temporal proximity). Use classify_bugs to analyze projects. The tool fetches tickets from Jira (cached 24h), scores all pairs, and clusters related bugs. Results include probable cause, suggested action, and confidence level for each cluster. Authentication: Basic Auth requires ATLASSIAN_EMAIL + ATLASSIAN_PASSWORD + ATLASSIAN_BASE_URL all three set in ~/.raven/.env (the BWA host pointed at by ATLASSIAN_BASE_URL is what accepts Basic Auth). If any of those is missing, falls back to SiteMinder/SMSESSION — same flow as jira-mcp / assets-mcp." + WORKAROUND_NOTE,
    }
  );

  // --- Tool: classify_bugs ---
  server.tool(
    "classify_bugs",
    "Analyze Jira bug tickets across one or more projects and group them by shared root cause. " +
    "Uses 5 heuristic signals: text similarity (30%), error patterns (25%), component/label overlap (15%), " +
    "affected area keywords (15%), and temporal proximity (15%). " +
    "Returns clusters ranked by cross-project impact, size, recency, and confidence.",
    {
      projects: z
        .array(z.string().regex(PROJECT_KEY_RE, "Invalid project key — must be 2–20 uppercase letters/digits/underscores starting with a letter"))
        .min(1)
        .describe("Jira project keys to analyze (e.g., ['RRS','DMS','CWM']). Each key is validated up-front."),
      months: z
        .number()
        .min(1)
        .max(120)
        .default(config.lookbackMonths)
        .describe(`Lookback window in months (default: ${config.lookbackMonths})`),
      threshold: z
        .number()
        .min(0.1)
        .max(1)
        .default(config.matchThreshold)
        .describe(
          `Match score threshold (default: ${config.matchThreshold}). ` +
          `Floor at 0.1 — threshold=0 keeps every pair, which at the 2000-ticket ` +
          `cap is ~2M edges (each with a signalScores object) and can OOM.`,
        ),
      maxTickets: z
        .number()
        .min(1)
        .max(2000)
        .default(config.maxTickets)
        .describe(
          `Max tickets to analyze (default: ${config.maxTickets}). ` +
          `Capped at 2000 because scoring is O(n²) — 5000 tickets meant ~12.5M ` +
          `pair comparisons per request and could stall the process.`,
        ),
      noCache: z
        .boolean()
        .default(false)
        .describe("Skip ticket cache and fetch fresh from Jira"),
      format: z
        .enum(["summary", "report"])
        .default("summary")
        .describe("Output format: 'summary' for structured clusters, 'report' for full markdown report"),
    },
    { readOnlyHint: true },
    async ({ projects, months, threshold, maxTickets, noCache, format }) => {
      try {
        // De-duplicate so classify_bugs(["RRS","RRS","DMS"]) doesn't fetch
        // RRS twice. The Zod array schema already validates each key
        // against PROJECT_KEY_RE up-front, so no need to re-check here.
        const projectList = [...new Set(projects.map((p) => p.trim()).filter(Boolean))];
        if (projectList.length === 0) {
          return {
            content: [{ type: "text", text: "Error: No valid project keys provided" }],
            isError: true,
          };
        }

        // (Per-key validation is enforced by the Zod array schema above.)


        const tickets = await fetchTickets(projectList, months, noCache, false, maxTickets);
        if (tickets.length === 0) {
          return {
            content: [{ type: "text", text: `No bug tickets found for ${projectList.join(', ')} in the last ${months} months.` }],
          };
        }

        const pairs = scoreAllPairs(tickets, threshold);
        const clusters = buildClusters(tickets, pairs);

        if (format === "report") {
          const clusteredCount = clusters.reduce((sum, c) => sum + c.tickets.length, 0);
          const report = generateReport({
            clusters,
            projects: projectList,
            totalTickets: tickets.length,
            unclusteredCount: tickets.length - clusteredCount,
            // Pass the resolved Jira URL (includes /int/jira) — passing the
            // raw ATLASSIAN_BASE_URL produces broken /browse/KEY links at
            // the site root rather than under /int/jira.
            baseUrl: getJiraBaseUrl(),
          });
          return {
            content: [{ type: "text", text: pi.scrubText(report) }],
          };
        }

        const summary = formatClusterSummary(clusters, tickets.length);
        return {
          content: [{ type: "text", text: pi.scrubText(summary) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
