import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PiScrubber } from "@nrs/auth";
import { RfcBuddyClient } from "./rfcbuddy-client.js";
import type { RfcResult } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown) => pi.scrubText(err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Global config (server URL + PAT)
// ---------------------------------------------------------------------------
function getServerUrl(): string {
  const url = process.env.RFCBUDDY_URL;
  if (!url) {
    throw new Error(
      "RFCBUDDY_URL is not set (see scripts/setup-credentials.ps1)"
    );
  }
  return url;
}

function getToken(): string {
  const token = process.env.RFCBUDDY_PAT;
  if (!token) {
    throw new Error(
      "RFCBUDDY_PAT is not set in environment or ~/.raven/.env"
    );
  }
  return token;
}

let client: RfcBuddyClient | null = null;
function getClient(): RfcBuddyClient {
  if (!client) {
    client = new RfcBuddyClient(getServerUrl(), getToken());
  }
  return client;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function getChangeStatusString(status: string | number): string {
  if (status === 0 || status === "New") return "New";
  if (status === 1 || status === "Changed") return "Changed";
  if (status === 2 || status === "Unchanged") return "Unchanged";
  return String(status);
}

function fmtRfc(r: RfcResult): string {
  const statusStr = getChangeStatusString(r.changeStatus);
  const scrub = (s: string) => pi.scrubText(s);
  return [
    `- **[${scrub(statusStr)}]** **${scrub(r.rfcNumber)}** (Status: ${scrub(r.approvalStatus)}) — Platform: ${scrub(r.platform)}`,
    `  - **Start/End (UTC):** ${scrub(r.startDateUtc)} / ${scrub(r.endDateUtc)}`,
    `  - **Asset Tags:** ${scrub(r.assetTags)}`,
    `  - **Description:** ${scrub(r.description)}`,
    `  - **Risk Assessment:** ${scrub(r.riskAssessment)}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
export function createRfcBuddyServer(): McpServer {
  const server = new McpServer(
    { name: "RAVEN RFC Buddy", version: "0.1.0" },
    {
      instructions:
        "RFC Buddy tools for RAVEN. Query and track change baselines of " +
        "RFC schedules inside the environment.",
    }
  );

  // -------------------------------------------------------------------------
  // 1. Search/filter and baseline RFCs
  // -------------------------------------------------------------------------
  server.tool(
    "rfcbuddy_search_rfcs",
    "Filter and search RFCs from the current and completed schedule. This matches " +
      "inclusion/exclusion keywords and updates/advances the API-side baseline tracking " +
      "representing the last seen status for the caller.",
    {
      includeKeywords: z
        .array(z.string())
        .min(1)
        .describe("Keywords that must be present in the RFC tag/metadata (e.g. ['payments', 'jira'])"),
      ignoreKeywords: z
        .array(z.string())
        .optional()
        .describe("Keywords to exclude/ignore (e.g. ['sandbox'])"),
    },
    { readOnlyHint: false },
    async ({ includeKeywords, ignoreKeywords }) => {
      try {
        const c = getClient();
        const r = await c.searchRfcs(includeKeywords, ignoreKeywords);

        const summary = `**RFC Search matched ${r.totalMatched} result(s)** (Generated at: ${r.generatedAtUtc})\n\n` +
          (r.rfcs.length ? r.rfcs.map(fmtRfc).join("\n") : "_No matching RFCs found_");

        return { content: [{ type: "text", text: summary }] };
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
