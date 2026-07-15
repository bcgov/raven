import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PiScrubber } from "@nrs/auth";
import { SonarClient } from "./sonar-client.js";
import { runScan, getMergedSonarProps } from "./sonar-scanner.js";
import type {
  SonarIssue,
  SonarHotspot,
  SonarComponentMeasures,
  SonarQualityGateStatus,
} from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown) => pi.scrubText(err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Global config (server URL + global Sonar properties)
// ---------------------------------------------------------------------------
function getServerUrl(): string {
  const url = process.env.SONARQUBE_URL;
  if (!url) throw new Error("SONARQUBE_URL is not set (see scripts/setup-credentials.ps1)");
  return url;
}
function getToken(): string {
  const t = process.env.SONARQUBE_TOKEN;
  if (!t) throw new Error("SONARQUBE_TOKEN is not set");
  return t;
}

let client: SonarClient | null = null;
function getClient(): SonarClient {
  if (!client) client = new SonarClient(getServerUrl(), getToken());
  return client;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtIssue(i: SonarIssue): string {
  const loc = i.line ? `:${i.line}` : "";
  return `- **[${i.severity}/${i.type}]** ${i.component}${loc} — ${i.message} _(${i.rule})_`;
}
function fmtHotspot(h: SonarHotspot): string {
  const loc = h.line ? `:${h.line}` : "";
  const tag = h.resolution ? `[${h.status}/${h.resolution}]` : `[${h.status}]`;
  return `- **${tag}** (${h.vulnerabilityProbability}) ${h.component}${loc} — ${h.message} _(${h.securityCategory})_`;
}
function ratingLetter(v?: string): string {
  switch (v) {
    case "1.0": return "A";
    case "2.0": return "B";
    case "3.0": return "C";
    case "4.0": return "D";
    case "5.0": return "E";
    default: return "—";
  }
}
function pickMeasure(m: SonarComponentMeasures, key: string): string | undefined {
  return m.component.measures.find((x) => x.metric === key)?.value;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
export function createSonarServer(): McpServer {
  const server = new McpServer(
    { name: "RAVEN SonarQube", version: "0.1.0" },
    {
      instructions:
        "SonarQube tools for RAVEN. Compatible with SonarQube Community Build " +
        " + Community Branch Plugin. All tools accept a branch parameter so " +
        "Copilot can target a specific feature/PR branch.",
    },
  );

  // -------------------------------------------------------------------------
  // 1. Issues for a project + branch (new code, overall, or both)
  // -------------------------------------------------------------------------
  server.tool(
    "sonar_list_issues",
    "List open issues for a project and branch. Use scope='new' for issues in " +
      "the New Code period, 'overall' for the full project, or 'both' to return " +
      "two clearly labeled sections.",
    {
      projectKey: z.string().describe("Sonar projectKey"),
      branch:     z.string().describe("Branch name (e.g. main, feature/x)"),
      scope:      z.enum(["new", "overall", "both"]).default("both"),
      severities: z.array(z.enum(["INFO", "MINOR", "MAJOR", "CRITICAL", "BLOCKER"])).optional(),
      types:      z.array(z.enum(["BUG", "VULNERABILITY", "CODE_SMELL"])).optional(),
      pageSize:   z.number().int().min(1).max(500).default(200),
    },
    { readOnlyHint: true },
    async ({ projectKey, branch, scope, severities, types, pageSize }) => {
      try {
        const c = getClient();
        const sections: string[] = [];

        if (scope === "overall" || scope === "both") {
          const r = await c.searchIssues(projectKey, branch, { severities, types, pageSize });
          sections.push(
            `**Overall code — ${r.total} issue(s)**\n` +
              (r.issues.length ? r.issues.map(fmtIssue).join("\n") : "_None_"),
          );
        }
        if (scope === "new" || scope === "both") {
          const r = await c.searchIssues(projectKey, branch, {
            severities, types, pageSize, inNewCodePeriod: true,
          });
          sections.push(
            `**New code — ${r.total} issue(s)**\n` +
              (r.issues.length ? r.issues.map(fmtIssue).join("\n") : "_None_"),
          );
        }
        return { content: [{ type: "text", text: sections.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 2. Quality gate for a scan, including reasons for failure
  // -------------------------------------------------------------------------
  server.tool(
    "sonar_get_quality_gate",
    "Return the quality gate status for a project/branch and, when it fails, " +
      "the exact conditions that caused the failure (metric, threshold, actual).",
    {
      projectKey: z.string(),
      branch:     z.string().optional(),
    },
    { readOnlyHint: true },
    async ({ projectKey, branch }) => {
      try {
        const c = getClient();
        const qg: SonarQualityGateStatus = await c.getQualityGate(projectKey, branch);
        const s = qg.projectStatus.status;
        const head = `**Quality gate: ${s}**${branch ? ` (branch: ${branch})` : ""}`;

        if (s === "OK") {
          return { content: [{ type: "text", text: `${head}\n\nAll conditions met.` }] };
        }
        const failing = qg.projectStatus.conditions.filter((c) => c.status === "ERROR" || c.status === "WARN");
        const lines = failing.map(
          (c) => `- **${c.metricKey}** ${c.comparator} ${c.errorThreshold ?? "?"} → actual **${c.actualValue ?? "n/a"}** (${c.status})`,
        );
        return {
          content: [{ type: "text", text: `${head}\n\nFailing conditions:\n${lines.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3. Run a scan for a project/branch (delegates to local sonar-scanner CLI)
  // -------------------------------------------------------------------------
  server.tool(
    "sonar_run_scan",
    "Trigger a SonarQube scan from a local working directory using the " +
      "sonar-scanner CLI. Applies the globally configured exclusions, " +
      "cpd.exclusions and coverage.exclusions automatically.",
    {
      projectKey: z.string(),
      branch:     z.string(),
      projectDir: z.string().describe("Absolute path to the project working directory"),
      extraArgs:  z.array(z.string()).optional(),
      timeoutMs:  z.number().int().min(10_000).max(3_600_000).default(900_000),
      useMsBuild: z.boolean().optional().describe("Use MSBuild sonar step sequence for C#/.NET projects (default: auto-detect .NET code)"),
      runTests:   z.boolean().optional().describe("Run tests to calculate/report code coverage (default: auto-detect tests)")
    },
    { readOnlyHint: false },
    async ({ projectKey, branch, projectDir, extraArgs, timeoutMs, useMsBuild, runTests }) => {
      try {
        const props = getMergedSonarProps(projectDir);

        const forbidden = [
          "sonar.host.url",
          "sonar.token",
          "sonar.login",
          "sonar.password",
          "sonar.projectKey",
          "sonar.branch.name",
        ];

        const badArg = (extraArgs ?? []).find((a) => forbidden.some((k) => a.includes(k)));
        if (badArg) {
          throw new Error(`extraArgs may not set protected Sonar properties (received: ${badArg})`);
        }

        const token = getToken();
        const r = await runScan({
          projectKey, branch, projectDir,
          serverUrl: getServerUrl(),
          token,
          ...props,
          extraArgs, timeoutMs,
          useMsBuild,
          runTests,
        });

        const scrubOutput = (s: string) => pi.scrubText(s).split(token).join("[REDACTED]");
        const stdoutTail = scrubOutput(r.stdoutTail);
        const stderrTail = scrubOutput(r.stderrTail);

        const head = r.success
          ? `**Scan completed for ${projectKey}@${branch}**`
          : `**Scan failed for ${projectKey}@${branch} (exit ${r.exitCode})**`;
        return {
          content: [{
            type: "text",
            text: `${head}\n\n_stdout (tail)_\n\`\`\`\n${stdoutTail}\n\`\`\`` +
                  (stderrTail ? `\n\n_stderr (tail)_\n\`\`\`\n${stderrTail}\n\`\`\`` : ""),
          }],
          isError: !r.success,
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 4. Last scan result + quality gate for project/branch
  // -------------------------------------------------------------------------
  server.tool(
    "sonar_get_last_scan",
    "Return the most recent analysis for a project/branch plus its quality " +
      "gate status and failing conditions, if any.",
    { projectKey: z.string(), branch: z.string() },
    { readOnlyHint: true },
    async ({ projectKey, branch }) => {
      try {
        const c = getClient();
        const [analyses, qg] = await Promise.all([
          c.listAnalyses(projectKey, branch, 1),
          c.getQualityGate(projectKey, branch),
        ]);
        const a = analyses.analyses[0];
        if (!a) {
          return { content: [{ type: "text", text: `No analyses found for ${projectKey}@${branch}.` }] };
        }
        const failing = qg.projectStatus.conditions
          .filter((c) => c.status === "ERROR" || c.status === "WARN")
          .map((c) => `  - ${c.metricKey} ${c.comparator} ${c.errorThreshold ?? "?"} → ${c.actualValue ?? "n/a"} (${c.status})`);
        const lines = [
          `**Last scan for ${projectKey}@${branch}**`,
          `- Analysis key: ${a.key}`,
          `- Date: ${a.date}`,
          a.projectVersion ? `- Version: ${a.projectVersion}` : "",
          `- Quality gate: **${qg.projectStatus.status}**`,
          failing.length ? `- Failing conditions:\n${failing.join("\n")}` : "",
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 5. Security hotspots (incl. acknowledged) for project/branch
  // -------------------------------------------------------------------------
  server.tool(
    "sonar_list_security_hotspots",
    "List security hotspots for a project/branch. Set includeAcknowledged=true " +
      "to also include hotspots marked as REVIEWED with resolution=ACKNOWLEDGED.",
    {
      projectKey: z.string(),
      branch:     z.string(),
      includeAcknowledged: z.boolean().default(false),
      pageSize:   z.number().int().min(1).max(500).default(200),
    },
    { readOnlyHint: true },
    async ({ projectKey, branch, includeAcknowledged, pageSize }) => {
      try {
        const r = await getClient().searchHotspots(projectKey, branch, { includeAcknowledged, pageSize });
        const head = `**${r.paging.total} hotspot(s) for ${projectKey}@${branch}**` +
          (includeAcknowledged ? " (incl. acknowledged)" : "");
        const body = r.hotspots.length ? r.hotspots.map(fmtHotspot).join("\n") : "_None_";
        return { content: [{ type: "text", text: `${head}\n\n${body}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 6. Project metrics for the MAIN branch (mirrors the SonarQube project card)
  // -------------------------------------------------------------------------
  server.tool(
    "sonar_get_project_metrics",
    "Return the headline project metrics for the MAIN branch, mirroring the " +
      "SonarQube project card (Security, Reliability, Maintainability, " +
      "Hotspots Reviewed, Coverage, Duplications, plus LOC, languages, tags, " +
      "visibility, last analysis, and overall quality gate).",
    { projectKey: z.string() },
    { readOnlyHint: true },
    async ({ projectKey }) => {
      try {
        const c = getClient();
        const branches = await c.listBranches(projectKey);
        const main = branches.branches.find((b) => b.isMain)?.name ?? "main";

        const METRICS = [
          "alert_status",
          "security_rating", "vulnerabilities",
          "reliability_rating", "bugs",
          "sqale_rating", "code_smells", "sqale_index",
          "security_review_rating", "security_hotspots_reviewed",
          "coverage",
          "duplicated_lines_density",
          "ncloc",
        ];
        const [m, comp, latest] = await Promise.all([
          c.getComponentMeasures(projectKey, METRICS, main),
          c.getComponent(projectKey, main),
          c.listAnalyses(projectKey, main, 1),
        ]);

        const v = (k: string) => pickMeasure(m, k);
        const lastDate = latest.analyses[0]?.date ?? "n/a";
        const tag = (comp.component.tags?.length ? comp.component.tags.join(", ") : "—");

        const table = [
          `| Metric | Rating | Value |`,
          `| --- | --- | --- |`,
          `| Security              | ${ratingLetter(v("security_rating"))}        | ${v("vulnerabilities")          ?? "—"} |`,
          `| Reliability           | ${ratingLetter(v("reliability_rating"))}     | ${v("bugs")                     ?? "—"} |`,
          `| Maintainability       | ${ratingLetter(v("sqale_rating"))}           | ${v("code_smells")              ?? "—"} |`,
          `| Hotspots Reviewed     | ${ratingLetter(v("security_review_rating"))}| ${v("security_hotspots_reviewed")?? "—"}% |`,
          `| Coverage              | —                                            | ${v("coverage")                  ?? "—"}% |`,
          `| Duplications          | —                                            | ${v("duplicated_lines_density") ?? "—"}% |`,
        ].join("\n");

        const header = [
          `**${comp.component.name}** (${comp.component.visibility ?? "?"})`,
          `- Quality gate: **${v("alert_status") ?? "?"}**`,
          `- Last analysis: ${lastDate}`,
          `- ${v("ncloc") ?? "?"} Lines of Code`,
          `- Language: ${comp.component.language ?? "—"}`,
          `- Tags: ${tag}`,
          `- Main branch: ${main}`,
        ].join("\n");

        return { content: [{ type: "text", text: `${header}\n\n${table}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${safeErr(err)}` }], isError: true };
      }
    },
  );

  return server;
}