import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerNames, getServerDescription, getServerConfig, PiScrubber } from "@nrs/auth";
import { discoverApps, parseDiscoverOutput } from "./commands/discover.js";
import { fetchVersions, detectMismatches } from "./commands/versions.js";
import { searchLogs, searchHttpdLogs } from "./commands/log-search.js";
import { diffConfig } from "./commands/config-diff.js";
import { getJvmHeap, formatHeapReport } from "./commands/jvm-heap.js";
import { runDashboard } from "./commands/dashboard.js";
import type { ConfigFile } from "./commands/config-diff.js";
import type { LogType } from "./commands/log-search.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

// Load server names and descriptions from ~/bin/servers.conf
const serverNames = getServerNames();
if (serverNames.length === 0) {
  throw new Error(
    "No servers configured. Create ~/bin/servers.conf with at least one server entry."
  );
}
const SERVER_NAMES = serverNames as [string, ...string[]];
const serverDesc = `Server name (${getServerDescription()})`;

const serverConfig = getServerConfig();
/** Tomcat/Java app servers only (have sudoUser for service account access) */
const appServerConfig = serverConfig.filter(s => s.sudoUser);
const allServersDefault = appServerConfig.map(s => s.name).join(",");
function getEntry(name: string) {
  const entry = serverConfig.find(s => s.name === name);
  if (!entry) throw new Error(`Server '${name}' not found in servers.conf`);
  return entry;
}

/**
 * Create and configure the Server Monitoring MCP server.
 *
 * All tools are strictly READ-ONLY. They SSH into servers and run
 * grep, cat, readlink, ls, df, ps, jstat — never anything that writes.
 */

const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createServerMonitoringServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN Server Monitor",
      version: "0.1.0",
    },
    {
      instructions: `Server Monitor tools are read-only tools for monitoring BC Gov application servers. Server names: ${getServerDescription()}. These server-monitor tools only read logs, configs, and versions — they do not modify anything on the servers. NOTE: This read-only constraint applies ONLY to these server-monitor tools. Other MCP servers (Confluence, Jira, Bitbucket) have their own write capabilities like create_page, update_page, create_issue, etc. Common apps include: RRS, DMS, CIRRAS, EYOR, FNCS, CWM, SNCSC, EDQA, NRMCFS, RAR2. Use discover_apps first if you need to find available apps and components on a server. For NR Apache httpd reverse proxy servers (DMZ or internal), use search_httpd_logs instead of search_server_logs. Credentials come from ~/.raven/.env (SERVER_A_PASSWORD). If you get a password error, tell the user to add SERVER_A_PASSWORD to their ~/.raven/.env file.${WORKAROUND_NOTE}`,
    }
  );

  // --- Tool: discover_apps ---
  server.tool(
    "discover_apps",
    "Discover all deployed applications on a server. Lists app names, components, deployed versions, and ports. Use this first to find what apps and components are available.",
    {
      server: z
        .enum(SERVER_NAMES)
        .describe(serverDesc),
    },
    { readOnlyHint: true },
    async ({ server: serverName }) => {
      try {
        const entry = getEntry(serverName);
        const { output, exitCode } = await discoverApps(entry);
        if (exitCode !== 0) {
          return {
            content: [{ type: "text", text: pi.scrubText(`Error: ${output}`) }],
            isError: true,
          };
        }
        const apps = parseDiscoverOutput(output);
        if (apps.length === 0) {
          return { content: [{ type: "text", text: "No apps found." }] };
        }
        const lines = apps.map(a =>
          `  ${a.app.padEnd(12)} ${a.component.padEnd(25)} ${a.version.padEnd(20)} ${a.port}`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: search_logs ---
  server.tool(
    "search_server_logs",
    "Search application logs on a remote server for a pattern. Supports date-based log selection and compressed (.gz) log files. Returns matching lines with line numbers. Log types: 'app' for application logs, 'catalina' for Tomcat logs, 'access' for HTTP access logs.",
    {
      server: z
        .enum(SERVER_NAMES)
        .describe(serverDesc),
      app: z
        .string()
        .describe("Application name (e.g., RRS, DMS, CIRRAS)"),
      component: z
        .string()
        .describe(
          "Component name (e.g., rrs-api, rrs-web, dms-document-api)"
        ),
      pattern: z
        .string()
        .describe(
          "Grep pattern to search for (e.g., 'ORA-', 'ERROR', 'NullPointerException')"
        ),
      logType: z
        .enum(["app", "catalina", "access"])
        .default("app")
        .describe(
          "Log type: app (application log), catalina (Tomcat), access (HTTP access log)"
        ),
      date: z
        .string()
        .optional()
        .describe(
          "Date for log file (YYYY-MM-DD or 'today'). Omit for current active log."
        ),
      maxLines: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum lines to return"),
      context: z
        .number()
        .min(0)
        .max(10)
        .default(0)
        .describe("Number of context lines around each match"),
    },
    { readOnlyHint: true },
    async ({ server: serverName, app, component, pattern, logType, date, maxLines, context }) => {
      try {
        const entry = getEntry(serverName);
        const { output, exitCode } = await searchLogs(entry, {
          app, component, pattern,
          logType: logType as LogType,
          date,
          maxLines, contextLines: context,
        });
        return {
          content: [{
            type: "text",
            text: exitCode === 0
              ? output || "No matches found."
              : pi.scrubText(`Error: ${output}`),
          }],
          ...(exitCode !== 0 && { isError: true }),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: search_httpd_logs ---
  server.tool(
    "search_httpd_logs",
    "Search Apache httpd access or error logs on NR reverse proxy servers (DMZ or internal). " +
    "Logs are stored under /sw_ux/httpd01/logs/hot (active) or cold (older rotated files). " +
    "Each virtual-host domain has its own log files named {domain}-{access|error}.{YYYY.MM.DD}.log. " +
    "These servers do not require sudo — the _A account has direct read access. " +
    "Set sudoUser to empty in servers.conf for these servers.",
    {
      server: z
        .enum(SERVER_NAMES)
        .describe(serverDesc),
      domain: z
        .string()
        .describe(
          "Virtual-host domain name (e.g., 'portalext.example.gov.bc.ca') or 'default' for the default server logs"
        ),
      logType: z
        .enum(["access", "error"])
        .default("access")
        .describe("Log type: access (HTTP traffic) or error (Apache error log)"),
      subdir: z
        .enum(["hot", "cold"])
        .default("hot")
        .describe("Log subdirectory: hot (active/recent logs) or cold (older rotated logs)"),
      pattern: z
        .string()
        .describe(
          "Grep pattern to search for (e.g., 'POST /api', '404', 'AH01630')"
        ),
      date: z
        .string()
        .optional()
        .describe(
          "Date for log file (YYYY-MM-DD or 'today'). Omit to search the newest available log file."
        ),
      maxLines: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum lines to return"),
      context: z
        .number()
        .min(0)
        .max(10)
        .default(0)
        .describe("Number of context lines around each match"),
    },
    { readOnlyHint: true },
    async ({ server: serverName, domain, logType, subdir, pattern, date, maxLines, context }) => {
      try {
        const entry = getEntry(serverName);
        const { output, exitCode } = await searchHttpdLogs(entry, {
          domain, logType, subdir, pattern, date,
          maxLines, contextLines: context,
        });
        return {
          content: [{
            type: "text",
            text: exitCode === 0
              ? output || "No matches found."
              : pi.scrubText(`Error: ${output}`),
          }],
          ...(exitCode !== 0 && { isError: true }),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: get_versions ---
  server.tool(
    "get_versions",
    "Check deployed application versions across servers. Reads the 'current' symlink for each app to determine which version is deployed. Can compare versions across environments and flags mismatches.",
    {
      app: z
        .string()
        .optional()
        .describe(
          "Filter to specific app (e.g., RRS). Omit for all apps."
        ),
      server: z
        .enum(SERVER_NAMES)
        .optional()
        .describe(
          "Filter to specific server. Omit for all servers."
        ),
    },
    { readOnlyHint: true },
    async ({ app, server: serverName }) => {
      try {
        const targets = serverName ? [getEntry(serverName)] : appServerConfig;
        const serverData = new Map<string, Map<string, string>>();
        for (const entry of targets) {
          serverData.set(entry.name, await fetchVersions(entry, app));
        }
        const mismatches = detectMismatches(serverData);

        const allKeys = new Set<string>();
        for (const m of serverData.values()) m.forEach((_, k) => allKeys.add(k));
        const lines: string[] = [];
        const header = `  ${"APP/Component".padEnd(30)}` +
          targets.map(e => `  ${e.name.padEnd(22)}`).join("");
        lines.push(header);
        lines.push("  " + "─".repeat(80));
        for (const key of [...allKeys].sort()) {
          const [ap, comp] = key.split("|");
          let row = `  ${`${ap}/${comp}`.padEnd(30)}`;
          for (const entry of targets) {
            const ver = serverData.get(entry.name)?.get(key) ?? "—";
            row += `  ${ver.padEnd(22)}`;
          }
          lines.push(row);
        }
        if (mismatches.length > 0) {
          lines.push("\n  Version Mismatches:");
          mismatches.forEach(m => lines.push(`  ! ${m}`));
        }
        return {
          content: [{ type: "text", text: lines.join("\n") || "No apps found." }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: diff_config ---
  server.tool(
    "diff_server_config",
    "Compare configuration files between servers for an application. Shows differences in context.xml, web.xml, or Tomcat server.xml between environments. Useful for finding 'works in dev, broken in prod' config mismatches.",
    {
      app: z.string().describe("Application name (e.g., RRS, DMS)"),
      component: z
        .string()
        .describe("Component name (e.g., rrs-api, dms-document-api)"),
      file: z
        .enum(["context.xml", "web.xml", "server.xml"])
        .default("context.xml")
        .describe("Config file to compare"),
      servers: z
        .string()
        .default(allServersDefault)
        .describe(
          "Comma-separated server names to compare (default: all)"
        ),
    },
    { readOnlyHint: true },
    async ({ app, component, file, servers }) => {
      try {
        const entries = servers.split(",").map(s => getEntry(s.trim()));
        const output = await diffConfig(entries, app, component, file as ConfigFile);
        return { content: [{ type: "text", text: output }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: server_dashboard ---
  server.tool(
    "server_dashboard",
    "Generate a server status dashboard showing deployed versions, today's error counts, and JVM info across all servers. Best for morning check-ins or getting a quick overview of all environments.",
    {
      app: z
        .string()
        .optional()
        .describe(
          "Filter to specific app (e.g., RRS). Omit for all apps."
        ),
    },
    { readOnlyHint: true },
    async ({ app }) => {
      try {
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const lines: string[] = [
          "",
          "  ╔═══════════════════════════════════════════════════════╗",
          `  ║      Server Dashboard — ${timestamp}          ║`,
          "  ╠═══════════════════════════════════════════════════════╣",
          "",
        ];

        for (const entry of appServerConfig) {
          const data = await runDashboard(entry, app);

          lines.push(`  ┌─ ${entry.name} (${entry.role}) ─────────────────────────`);

          if (data.versions.size === 0) {
            lines.push("  │  No apps found.");
          } else {
            for (const [key, ver] of data.versions) {
              const [ap, comp] = key.split("|");
              const errCount = data.errors.get(key) ?? "—";
              const xmx = data.jvm.get(key) ?? "";
              const errStr = errCount === 0 ? "  OK" : `  ${errCount} errors`;
              const jvmStr = xmx ? `  JVM:${xmx}` : "";
              lines.push(`  │  ${`${ap}/${comp}`.padEnd(35)} ${ver.padEnd(25)}${errStr}${jvmStr}`);
            }
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool: jvm_heap ---
  server.tool(
    "jvm_heap",
    "Show live JVM heap usage for a specific application component on a server. Uses jstat to read actual memory consumption, GC counts, and pause times. Useful for diagnosing memory pressure, OOM risks, or excessive garbage collection.",
    {
      server: z
        .enum(SERVER_NAMES)
        .describe(serverDesc),
      app: z
        .string()
        .describe("Application name (e.g., RRS, DMS, CIRRAS)"),
      component: z
        .string()
        .describe(
          "Component name (e.g., rrs-api, rrs-web, dms-document-api)"
        ),
    },
    { readOnlyHint: true },
    async ({ server: serverName, app, component }) => {
      try {
        const entry = getEntry(serverName);
        const result = await getJvmHeap(entry, app, component);
        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Error: ${result.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: formatHeapReport(entry, app, component, result.metrics) }],
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
