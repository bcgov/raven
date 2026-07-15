import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PiScrubber } from "@nrs/auth";
import { ImisClient } from "./imis-client.js";
import { validateCommand, validateSudoUser, sanitizePath, sshExec, ALLOWED_SUDO_USER_LIST } from "./ssh-executor.js";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ImisServer } from "./types.js";

const pi = new PiScrubber();
const safeErr = (err: unknown): string =>
  pi.scrubText(err instanceof Error ? err.message : String(err));

function getCsvPath(): string {
  return (
    process.env["IMIS_CSV_PATH"] ??
    join(homedir(), ".raven", "imis-servers.csv")
  );
}

function formatServerRow(s: ImisServer): string {
  return `${s.serverName.padEnd(16)} ${s.primaryIp.padEnd(18)} ${s.type.padEnd(14)} ${s.status.padEnd(12)} ${(s.os || "").substring(0, 35).padEnd(36)} ${pi.scrub(s.businessArea)}`;
}

function formatServerDetail(s: ImisServer): string {
  const sections: string[] = [];

  sections.push(`# ${s.serverName}`);
  sections.push("");
  sections.push("## Identity");
  sections.push(`- **Server Name:** ${s.serverName}`);
  sections.push(`- **FQDN:** ${s.fullName}`);
  if (s.aliasName) sections.push(`- **Alias:** ${s.aliasName}`);
  sections.push(`- **Description:** ${pi.scrubText(s.description)}`);
  sections.push(`- **Business Area:** ${pi.scrub(s.businessArea)}`);
  sections.push(`- **Status:** ${s.status}`);
  sections.push(`- **Type:** ${s.type}`);
  sections.push(`- **Physical/Virtual:** ${s.pOrV}`);

  sections.push("");
  sections.push("## Network");
  sections.push(`- **Primary IP:** ${s.primaryIp}`);
  if (s.totalIps) sections.push(`- **Total IPs:** ${s.totalIps}`);
  sections.push(`- **Zone:** ${s.zone}`);
  if (s.subnet) sections.push(`- **Subnet:** ${s.subnet}`);
  if (s.vlan) sections.push(`- **VLAN:** ${s.vlan}`);
  if (s.physicalLocation) sections.push(`- **Location:** ${s.physicalLocation}`);

  sections.push("");
  sections.push("## Operating System");
  sections.push(`- **OS:** ${s.os}`);
  if (s.os1) sections.push(`- **OS Detail 1:** ${s.os1}`);
  if (s.os2) sections.push(`- **OS Detail 2:** ${s.os2}`);
  if (s.os3) sections.push(`- **OS Detail 3:** ${s.os3}`);
  if (s.osBits) sections.push(`- **Bits:** ${s.osBits}`);
  if (s.buildDate) sections.push(`- **Build Date:** ${s.buildDate}`);
  if (s.lastBootDate) sections.push(`- **Last Boot:** ${s.lastBootDate}`);
  if (s.retireDate) sections.push(`- **Retire Date:** ${s.retireDate}`);

  sections.push("");
  sections.push("## Hardware");
  if (s.makeModel) sections.push(`- **Make/Model:** ${s.makeModel}`);
  if (s.coreCpu) sections.push(`- **Cores/CPUs:** ${s.coreCpu}`);
  if (s.cpuType) sections.push(`- **CPU Type:** ${s.cpuType}`);
  if (s.ram) sections.push(`- **RAM:** ${s.ram}`);
  if (s.serialNumber) sections.push(`- **Serial:** ${s.serialNumber}`);
  if (s.hardwareEol) sections.push(`- **Hardware EOL:** ${s.hardwareEol}`);

  sections.push("");
  sections.push("## Storage");
  if (s.internalDisk) sections.push(`- **Internal Disk:** ${s.internalDisk}`);
  if (s.tier0) sections.push(`- **Tier 0:** ${s.tier0}`);
  if (s.tier1) sections.push(`- **Tier 1:** ${s.tier1}`);
  if (s.tier2) sections.push(`- **Tier 2:** ${s.tier2}`);
  if (s.tier3) sections.push(`- **Tier 3:** ${s.tier3}`);
  if (s.external) sections.push(`- **External:** ${s.external}`);
  if (s.otherStorage) sections.push(`- **Other:** ${s.otherStorage}`);

  sections.push("");
  sections.push("## Services");
  if (s.web && s.web !== "No") sections.push(`- **Web Server:** ${s.web}`);
  if (s.iis && s.iis !== "0.0") sections.push(`- **IIS:** ${s.iis}`);
  if (s.ftp && s.ftp !== "No") sections.push(`- **FTP:** ${s.ftp}`);
  if (s.smtp && s.smtp !== "No") sections.push(`- **SMTP:** ${s.smtp}`);
  if (s.citrix && s.citrix !== "No") sections.push(`- **Citrix:** ${s.citrix}`);

  sections.push("");
  sections.push("## IMIS Agent");
  if (s.imisAgent) sections.push(`- **Agent Version:** ${s.imisAgent}`);
  if (s.agentStatus) sections.push(`- **Agent Status:** ${s.agentStatus}`);
  if (s.agentUpdate) sections.push(`- **Last Agent Update:** ${s.agentUpdate}`);
  if (s.imisControl) sections.push(`- **Control Version:** ${s.imisControl}`);

  const customFields: string[] = [];
  if (s.item1 && s.content1) customFields.push(`- **${s.item1}:** ${s.content1}`);
  if (s.item2 && s.content2) customFields.push(`- **${s.item2}:** ${s.content2}`);
  if (s.item3 && s.content3) customFields.push(`- **${s.item3}:** ${s.content3}`);
  if (s.item4 && s.content4) customFields.push(`- **${s.item4}:** ${s.content4}`);
  if (s.item5 && s.content5) customFields.push(`- **${s.item5}:** ${s.content5}`);
  if (s.item6 && s.content6) customFields.push(`- **${s.item6}:** ${s.content6}`);
  if (customFields.length > 0) {
    sections.push("");
    sections.push("## Custom Fields");
    sections.push(...customFields);
  }

  if (s.notes) {
    sections.push("");
    sections.push("## Notes");
    sections.push(pi.scrubText(s.notes));
  }

  if (s.lastUpdate) {
    sections.push("");
    sections.push(`*Last updated: ${s.lastUpdate}*`);
  }

  return sections.join("\n");
}

function formatStats(stats: ReturnType<ImisClient["getStats"]>): string {
  const lines: string[] = [];

  lines.push("# IMIS Server Inventory Statistics");
  lines.push(`**Total servers:** ${stats.total}`);
  lines.push(`**Latest agent update:** ${stats.latestAgentUpdate || "unknown"}`);

  lines.push("");
  lines.push("## By Status");
  for (const [k, v] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v}`);
  }

  lines.push("");
  lines.push("## By Type");
  for (const [k, v] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v}`);
  }

  lines.push("");
  lines.push("## By OS Family");
  for (const [k, v] of Object.entries(stats.byOsFamily).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v}`);
  }

  lines.push("");
  lines.push("## By Zone");
  for (const [k, v] of Object.entries(stats.byZone).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v}`);
  }

  lines.push("");
  lines.push("## By Business Area (top 15)");
  const bizEntries = Object.entries(stats.byBusinessArea).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of bizEntries.slice(0, 15)) {
    lines.push(`- ${pi.scrub(k)}: ${v}`);
  }
  if (bizEntries.length > 15) {
    lines.push(`- ... and ${bizEntries.length - 15} more`);
  }

  return lines.join("\n");
}


const WORKAROUND_NOTE = process.env["RAVEN_FLAG_WORKAROUNDS"]
  ? " If a tool call failed, returned unexpected results, or required a workaround (e.g. calling multiple tools where one should have worked, or converting input formats manually), append a ⚠️ WORKAROUND note at the end of your response stating: what limitation you hit, what workaround you used, and what fix in the MCP code would eliminate it."
  : "";

export function createImisServer(): McpServer {
  const server = new McpServer(
    { name: "RAVEN IMIS", version: "0.1.0" },
    {
      instructions: `IMIS (Infrastructure Management Information System) server inventory tools.

Discovery tools search a local CSV export of the IMIS database — no network needed.
Exploration tools SSH into servers to inspect apps, software, and configs — requires VPN and SERVER_A_PASSWORD in ~/.raven/.env.

Use search_servers to find servers, get_server for full details, then list_server_apps / explore_server / read_server_file to inspect them remotely.

The CSV is loaded from IMIS_CSV_PATH env var or ~/.raven/imis-servers.csv.
If the CSV is not found, discovery tools will return an error — the user needs to export a fresh CSV from the IMIS client.

If SSH tools return auth errors, the user needs SERVER_A_PASSWORD set in ~/.raven/.env.${WORKAROUND_NOTE}`,
    }
  );

  let client: ImisClient | null = null;

  function getClient(): ImisClient {
    if (!client) {
      client = new ImisClient(getCsvPath());
    }
    return client;
  }

  // ── Discovery Tools ──────────────────────────────────────────────

  server.tool(
    "search_servers",
    "Search the IMIS server inventory. Filter by type (Application, Database, GIS, Proxy, Web, File, etc.), status (Production, Test, Development, RETIRED), business area (Wildfire, Forests, WLRS, etc.), OS (Linux, Windows, RedHat, Solaris), or zone (Zone A, Zone B, DMZ). Free-text query searches server name, FQDN, description, notes, and IP address. Returns up to 50 results. Excludes RETIRED/TRANSFERRED by default.",
    {
      query: z.string().optional().describe("Free-text search across name, FQDN, description, notes, IP"),
      type: z.string().optional().describe("Server type: Application, Database, GIS, Web, File, Proxy, etc."),
      status: z.string().optional().describe("Status: Production, Test, Development, Delivery, RETIRED"),
      business_area: z.string().optional().describe("Ministry/team: Wildfire, Forests, WLRS, CSNR, etc."),
      os: z.string().optional().describe("OS filter: Linux, Windows, RedHat, Solaris, etc."),
      zone: z.string().optional().describe("Network zone: Zone A, Zone B, DMZ"),
      include_retired: z.boolean().optional().describe("Include RETIRED/TRANSFERRED servers (default: false)"),
    },
    { readOnlyHint: true },
    async ({ query, type, status, business_area, os, zone, include_retired }) => {
      try {
        const svc = getClient();
        const results = svc.search({
          query, type, status, businessArea: business_area, os, zone, includeRetired: include_retired,
        });

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: "No servers found matching the criteria." }] };
        }

        const header = `${"SERVER".padEnd(16)} ${"IP".padEnd(18)} ${"TYPE".padEnd(14)} ${"STATUS".padEnd(12)} ${"OS".padEnd(36)} BUSINESS AREA`;
        const divider = "\u2500".repeat(130);
        const rows = results.slice(0, 50).map(formatServerRow);
        const footer = results.length > 50
          ? `\n... showing 50 of ${results.length} results. Refine your search to see more.`
          : `\n${results.length} server(s) found.`;

        return { content: [{ type: "text" as const, text: `${header}\n${divider}\n${rows.join("\n")}${footer}` }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_server",
    "Get full details for a specific IMIS server by name. Returns all fields: identity, network, OS, hardware, storage, services, IMIS agent status, custom fields, and notes.",
    {
      name: z.string().describe("Server name (case-insensitive), e.g. TEST01, int01, DB01"),
    },
    { readOnlyHint: true },
    async ({ name }) => {
      try {
        const svc = getClient();
        const srv = svc.getServer(name);
        if (!srv) {
          return { content: [{ type: "text" as const, text: `Server '${name}' not found in IMIS inventory.` }] };
        }
        return { content: [{ type: "text" as const, text: formatServerDetail(srv) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "server_stats",
    "Get summary statistics of the IMIS server inventory. Shows totals and breakdowns by status, type, OS family, zone, and business area. Also shows data freshness (latest agent update).",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const svc = getClient();
        const stats = svc.getStats();
        return { content: [{ type: "text" as const, text: formatStats(stats) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ── Exploration Tools (SSH) ──────────────────────────────────────

  server.tool(
    "list_server_apps",
    "List application directories on a remote server. By default checks /apps_ux and /sw_ux. The server must exist in the IMIS inventory. Requires VPN connection and SERVER_A_PASSWORD in ~/.raven/.env.",
    {
      server: z.string().describe("Server name from IMIS inventory (case-insensitive)"),
      paths: z.array(z.string()).optional().describe("Directories to list (default: [\"/apps_ux\", \"/sw_ux\"])"),
    },
    { readOnlyHint: true },
    async ({ server: serverName, paths }) => {
      try {
        const svc = getClient();
        const srv = svc.getServer(serverName);
        if (!srv) {
          return { content: [{ type: "text" as const, text: `Server '${serverName}' not found in IMIS inventory.` }] };
        }

        const host = srv.fullName || srv.primaryIp;
        const dirs = paths ?? ["/apps_ux", "/sw_ux"];
        const results: string[] = [];
        for (const dir of dirs) {
          const safePath = sanitizePath(dir);
          const cmd = `ls -la ${safePath}`;
          if (!validateCommand(cmd)) {
            results.push(`## ${dir}\n(rejected: invalid path or command)`);
            continue;
          }
          const result = await sshExec(host, cmd);
          results.push(`## ${dir}\n${result.stdout || result.stderr || "(empty or not found)"}`);
        }

        return { content: [{ type: "text" as const, text: pi.scrubText(`# ${srv.serverName} (${srv.primaryIp})\n\n${results.join("\n\n")}`) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "explore_server",
    `Run a read-only command on a remote IMIS server. The server must exist in the IMIS inventory.
Allowed commands: ls, cat, head, tail, grep, zgrep, zcat, find, df, du, ps, stat, file, echo, date, hostname, uptime, free, wc, readlink, basename, vmstat, rpm, mount, sort, uniq, tr, cut, diff, which, jstat, strings, lsof.
Requires VPN connection and SERVER_A_PASSWORD in ~/.raven/.env.`,
    {
      server: z.string().describe("Server name from IMIS inventory (case-insensitive)"),
      command: z.string().describe("Read-only command to execute (must start with an allowed command)"),
      sudo_user: z.string().optional().describe("If provided, sudo to this user before running command (e.g. wwwsvr, oracle)"),
    },
    { readOnlyHint: true },
    async ({ server: serverName, command, sudo_user }) => {
      try {
        const svc = getClient();
        const srv = svc.getServer(serverName);
        if (!srv) {
          return { content: [{ type: "text" as const, text: `Server '${serverName}' not found in IMIS inventory.` }] };
        }

        if (!validateCommand(command)) {
          return {
            content: [{ type: "text" as const, text: "Command rejected. Only read-only commands are allowed: ls, cat, head, tail, grep, find, df, du, ps, stat, rpm, mount, etc. No shell operators (;, |, &, $, `) allowed." }],
            isError: true,
          };
        }

        if (sudo_user && !validateSudoUser(sudo_user)) {
          return {
            content: [{ type: "text" as const, text: `sudo_user rejected. Allowed values: ${ALLOWED_SUDO_USER_LIST}.` }],
            isError: true,
          };
        }

        const host = srv.fullName || srv.primaryIp;
        const result = await sshExec(host, command, sudo_user);
        const output = result.stdout || result.stderr || "(no output)";
        return { content: [{ type: "text" as const, text: pi.scrubText(output) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "read_server_file",
    "Read a file from a remote IMIS server. The server must exist in the IMIS inventory. Path must be absolute and contain no traversal (..) or shell metacharacters. Requires VPN connection and SERVER_A_PASSWORD in ~/.raven/.env.",
    {
      server: z.string().describe("Server name from IMIS inventory (case-insensitive)"),
      path: z.string().describe("Absolute file path to read (e.g. /sw_ux/tomcat/conf/server.xml)"),
      lines: z.number().optional().describe("Max lines to return (default: 200)"),
      sudo_user: z.string().optional().describe("If provided, sudo to this user before reading"),
    },
    { readOnlyHint: true },
    async ({ server: serverName, path, lines, sudo_user }) => {
      try {
        const svc = getClient();
        const srv = svc.getServer(serverName);
        if (!srv) {
          return { content: [{ type: "text" as const, text: `Server '${serverName}' not found in IMIS inventory.` }] };
        }

        const safePath = sanitizePath(path);
        const maxLines = lines ?? 200;
        const command = `head -n ${maxLines} ${safePath}`;

        if (!validateCommand(command)) {
          return {
            content: [{ type: "text" as const, text: "Invalid path or command construction." }],
            isError: true,
          };
        }

        if (sudo_user && !validateSudoUser(sudo_user)) {
          return {
            content: [{ type: "text" as const, text: `sudo_user rejected. Allowed values: ${ALLOWED_SUDO_USER_LIST}.` }],
            isError: true,
          };
        }

        const host = srv.fullName || srv.primaryIp;
        const result = await sshExec(host, command, sudo_user);
        const output = result.stdout || result.stderr || "(empty file or not found)";
        return { content: [{ type: "text" as const, text: pi.scrubText(`# ${safePath} on ${srv.serverName}\n\n${output}`) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
