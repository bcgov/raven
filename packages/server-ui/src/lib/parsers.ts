/**
 * Parsers for CLI tool stdout → structured JSON.
 *
 * Each parser takes raw CLI text output and returns a typed object
 * suitable for JSON API responses.
 */

/**
 * Strip SSH session noise from CLI tool output.
 *
 * The expect-based SSH sessions produce preamble (spawn, banners,
 * password prompts, MOTD) and postamble (exit, logout, Connection closed).
 * This function removes those lines so only the actual command output remains.
 */
export function cleanSshOutput(stdout: string): string {
  // Strip ANSI escape codes and terminal control sequences
  const stripped = stdout
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\[\?[0-9]+[a-zA-Z]/g, "");

  const noisePatterns = [
    // SSH session preamble
    /^spawn\s+ssh\b/,
    /^\*\*\s*(WARNING|This session)/,
    /^\*\*\s*The server may/,
    /^\+[-+]+\+$/,
    /^\|\s+Access to/,
    /^\|\s+person other/,
    /^\|\s+prohibited/,
    /password:\s*$/i,
    /^Last login:/,
    // Shell prompts — standard [user@host]$ format
    /^\[.*@.*\]\$\s/,
    /^\[.*@.*\]\$$/,
    // Shell prompts — non-standard formats (bash-4.2$, user@host:~$, -bash-4.2$)
    /^-?bash-[\d.]+\$\s/,
    /^-?bash-[\d.]+\$$/,
    /^[\w.-]+@[\w.-]+:.*\$\s/,
    // Prompt-followed-by-known-command (catches any prompt format)
    /\$\s+unset HISTFILE/,
    /\$\s+set \+o history/,
    /\$\s+sudo\s+-su\s/,
    /\$\s+exit\s*$/,
    // sudo/su
    /^\[sudo\]\s*password/,
    // History suppression (when echoed without prompt prefix)
    /^unset HISTFILE/,
    /^set \+o history/,
    // SSH session postamble
    /^exit$/,
    /^logout$/,
    /^Connection to .* closed/,
    // Script informational lines (server-log-search, server-discover)
    /^Searching\s+'/,
    /^Path:\s+\//,
    // Remote command echo-back fragments
    /^if \[ -f .*\]; then/,
    /^\(?\s*d='/,
    // Prompt + command echo-back (catches full line: [user@host dir]$ <command>)
    /^\[[\w.-]+@[\w.-]+[^\]]*\]\$\s*.+/,
    // Bare command echo-back from expect (grep, ls, tail, etc. on remote)
    /^\$\s+(grep|ls|tail|head|cat|find|df|du|wc|ps|stat|hostname|uptime|free)\s/,
  ];

  return stripped
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Preserve blank lines — callers can strip them if needed
      if (!trimmed) return true;
      return !noisePatterns.some((p) => p.test(trimmed));
    })
    .join("\n");
}

/** A single deployed component on a server. */
export interface DiscoverApp {
  app: string;
  component: string;
  version: string;
  port: string;
}

/**
 * Parse `server-discover` output.
 *
 * The CLI outputs printf-formatted columns (not pipe-delimited):
 *   RRS           rrs-api                   20.1.5               port:8080
 *
 * Split on 2+ whitespace to separate the fixed-width columns.
 * Skip decorative lines (headers, separators, "Discovering..." messages).
 */
export function parseDiscover(stdout: string): DiscoverApp[] {
  const apps: DiscoverApp[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty, headers, separators, status messages
    if (
      !trimmed ||
      trimmed.includes("---") ||
      trimmed.includes("Discovering") ||
      /^APP\s/i.test(trimmed)
    ) {
      continue;
    }
    // Split on 2+ whitespace chars
    const parts = trimmed.split(/\s{2,}/).map((s) => s.trim());
    if (parts.length >= 3 && /^[A-Z]/.test(parts[0])) {
      apps.push({
        app: parts[0],
        component: parts[1],
        version: parts[2],
        port: parts[3] ?? "",
      });
    }
  }
  return apps;
}

/** Version info for one app across servers. */
export interface VersionRow {
  app: string;
  component: string;
  /** Server name → version string (dynamic keys). */
  servers: Record<string, string>;
  mismatch: boolean;
}

/**
 * Parse `server-versions` output.
 *
 * The CLI outputs printf-formatted columns:
 *   APP/Component                    server1                 server2               server3
 *   ─────────────────────────────────────────────────────────────────────────────────────
 *   RRS/rrs-api                      20.1.5                  20.1.5                20.1.5
 *
 * Columns are mapped positionally to the provided serverNames array.
 * Also parses "Version Mismatches:" section at the end.
 */
export function parseVersions(
  stdout: string,
  serverNames: string[]
): VersionRow[] {
  const rows: VersionRow[] = [];
  const lines = stdout.split("\n");

  // Collect mismatch keys from the summary section
  const mismatchKeys = new Set<string>();
  let inMismatchSection = false;
  for (const line of lines) {
    if (line.includes("Version Mismatches:")) {
      inMismatchSection = true;
      continue;
    }
    if (inMismatchSection) {
      const m = line.match(/!\s*(.+)/);
      if (m) mismatchKeys.add(m[1].trim());
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty, headers, separators, status messages, mismatch section
    if (
      !trimmed ||
      trimmed.includes("───") ||
      trimmed.includes("Querying") ||
      trimmed.includes("Deployment Status") ||
      trimmed.includes("Version Mismatches") ||
      trimmed.startsWith("!") ||
      /^APP/i.test(trimmed)
    ) {
      continue;
    }
    // Split on 2+ whitespace
    const parts = trimmed.split(/\s{2,}/).map((s) => s.trim());
    // First column is "APP/component", rest are versions per server
    if (parts.length >= 2 && parts[0].includes("/")) {
      const [app, component] = parts[0].split("/", 2);
      const servers: Record<string, string> = {};
      for (let i = 0; i < serverNames.length; i++) {
        servers[serverNames[i]] = parts[i + 1] || "—";
      }
      rows.push({
        app,
        component,
        servers,
        mismatch: mismatchKeys.has(parts[0]),
      });
    }
  }
  return rows;
}

/** Heap data for a JVM process. */
export interface HeapData {
  pid: string;
  heapUsedMb: number;
  heapMaxMb: number;
  heapPercent: number;
  edenUsedMb: number;
  edenMaxMb: number;
  edenPercent: number;
  oldUsedMb: number;
  oldMaxMb: number;
  oldPercent: number;
  metaUsedMb: number;
  metaMaxMb: number;
  metaPercent: number;
  youngGcCount: number;
  youngGcTime: number;
  fullGcCount: number;
  fullGcTime: number;
}

/**
 * Parse `server-heap` output.
 *
 * Actual CLI format:
 *   PID:        12345
 *   Max Heap:   2048m
 *
 *   Heap:       [████████░░░░] 60% (500 MB / 1024 MB)
 *
 *   Eden:          100 MB /    256 MB
 *   Old Gen:       400 MB /    768 MB
 *   Metaspace:      80 MB /    128 MB
 *
 *   Young GCs:  1234 (12.5s)
 *   Full GCs:   5 (2.1s)
 */
export function parseHeap(stdout: string): HeapData | null {
  const pid = stdout.match(/PID:\s*(\d+)/)?.[1];
  if (!pid) return null;

  // Heap line: "Heap: [...] 60% (500 MB / 1024 MB)"
  const heapMatch = stdout.match(
    /Heap:\s*\[.*?\]\s*(\d+)%\s*\((\d+)\s*MB\s*\/\s*(\d+)\s*MB\)/
  );
  const heapPct = parseInt(heapMatch?.[1] ?? "0", 10);
  const heapUsed = parseInt(heapMatch?.[2] ?? "0", 10);
  const heapMax = parseInt(heapMatch?.[3] ?? "0", 10);

  // Sub-sections: "Eden:  100 MB / 256 MB"
  const parseSection = (
    tag: string
  ): { used: number; max: number; pct: number } => {
    const re = new RegExp(
      `${tag}:\\s*(\\d+)\\s*MB\\s*/\\s*(\\d+)\\s*MB`
    );
    const m = stdout.match(re);
    const used = parseInt(m?.[1] ?? "0", 10);
    const max = parseInt(m?.[2] ?? "0", 10);
    return { used, max, pct: max > 0 ? (used * 100) / max : 0 };
  };

  const eden = parseSection("Eden");
  const old = parseSection("Old Gen");
  const meta = parseSection("Metaspace");

  const ygcMatch = stdout.match(/Young GCs:\s*(\d+)\s*\(([\d.]+)s\)/);
  const fgcMatch = stdout.match(/Full GCs:\s*(\d+)\s*\(([\d.]+)s\)/);

  return {
    pid,
    heapUsedMb: heapUsed,
    heapMaxMb: heapMax,
    heapPercent: heapPct,
    edenUsedMb: eden.used,
    edenMaxMb: eden.max,
    edenPercent: eden.pct,
    oldUsedMb: old.used,
    oldMaxMb: old.max,
    oldPercent: old.pct,
    metaUsedMb: meta.used,
    metaMaxMb: meta.max,
    metaPercent: meta.pct,
    youngGcCount: parseInt(ygcMatch?.[1] ?? "0", 10),
    youngGcTime: parseFloat(ygcMatch?.[2] ?? "0"),
    fullGcCount: parseInt(fgcMatch?.[1] ?? "0", 10),
    fullGcTime: parseFloat(fgcMatch?.[2] ?? "0"),
  };
}

/** A row of dashboard data with dynamic server columns. */
export interface DashboardRow {
  appComponent: string;
  /** Server name → value string (dynamic keys). */
  servers: Record<string, string>;
}

/** Dashboard data parsed from server-dashboard CLI output. */
export interface DashboardData {
  versions: DashboardRow[];
  errors: DashboardRow[];
  jvmHeap: DashboardRow[];
}

/**
 * Parse `server-dashboard` output.
 *
 * The CLI outputs 3 boxed sections with printf-formatted columns.
 * Columns are mapped positionally to the provided serverNames array.
 */
export function parseDashboard(
  stdout: string,
  serverNames: string[]
): DashboardData | null {
  const lines = stdout.split("\n");
  const result: DashboardData = { versions: [], errors: [], jvmHeap: [] };

  type Section = "versions" | "errors" | "jvm" | null;
  let section: Section = null;
  let sawAnySection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section starts
    if (trimmed.includes("DEPLOYMENT STATUS")) {
      section = "versions";
      sawAnySection = true;
      continue;
    }
    if (trimmed.includes("ERROR SUMMARY")) {
      section = "errors";
      sawAnySection = true;
      continue;
    }
    if (trimmed.includes("JVM HEAP")) {
      section = "jvm";
      sawAnySection = true;
      continue;
    }
    // Detect section ends
    if (trimmed.startsWith("└") || trimmed.startsWith("╠") || trimmed.startsWith("╚")) {
      section = null;
      continue;
    }

    // Skip decorative / non-data lines
    if (
      !trimmed ||
      trimmed.startsWith("┌") ||
      trimmed.startsWith("╔") ||
      trimmed.startsWith("║") ||
      trimmed.includes("───") ||
      trimmed.includes("═══") ||
      /^APP/i.test(trimmed) ||
      trimmed.startsWith("Querying") ||
      trimmed.startsWith("No errors") ||
      trimmed.startsWith("No running")
    ) {
      continue;
    }

    if (!section) continue;

    // Parse data rows: split on 2+ whitespace
    const parts = trimmed.split(/\s{2,}/).map((s) => s.trim());
    if (parts.length >= 2 && parts[0].includes("/")) {
      const servers: Record<string, string> = {};
      for (let i = 0; i < serverNames.length; i++) {
        servers[serverNames[i]] = parts[i + 1] || "—";
      }
      const row: DashboardRow = { appComponent: parts[0], servers };
      if (section === "versions") result.versions.push(row);
      else if (section === "errors") result.errors.push(row);
      else if (section === "jvm") result.jvmHeap.push(row);
    }
  }

  // Only fall back to raw text if we couldn't detect any sections at all
  if (!sawAnySection) {
    return null;
  }

  return result;
}

/** JDBC connection pool configuration extracted from context.xml. */
export interface PoolConfigEntry {
  name: string;
  url: string;
  maxActive: string;
  maxIdle: string;
  minIdle: string;
  maxWait: string;
  validationQuery: string;
  driverClassName: string;
}

/**
 * Parse JDBC connection pool config from context.xml content.
 *
 * Extracts <Resource> elements with JDBC attributes.
 * IMPORTANT: Passwords are always masked.
 */
export function parsePoolConfig(xml: string): PoolConfigEntry[] {
  const entries: PoolConfigEntry[] = [];
  // Match <Resource ... /> elements (may span multiple lines)
  const resourceRe = /<Resource\s[^>]*type\s*=\s*"javax\.sql\.DataSource"[^>]*\/?>/gi;
  const matches = xml.match(resourceRe) || [];

  for (const tag of matches) {
    const attr = (name: string): string => {
      const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
      return m?.[1] ?? "";
    };

    // Mask the password — never expose it
    const rawUrl = attr("url");
    // Also mask any password embedded in the URL (e.g. jdbc:oracle:thin:user/pass@host)
    const maskedUrl = rawUrl.replace(/\/([^/@]+)@/, "/****@");

    entries.push({
      name: attr("name"),
      url: maskedUrl,
      maxActive: attr("maxActive") || attr("maximumPoolSize"),
      maxIdle: attr("maxIdle"),
      minIdle: attr("minIdle") || attr("minimumIdle"),
      maxWait: attr("maxWait") || attr("connectionTimeout"),
      validationQuery: attr("validationQuery"),
      driverClassName: attr("driverClassName"),
    });
  }

  return entries;
}

/** System load data for a server. */
export interface LoadData {
  uptime: string;
  load1: number;
  load5: number;
  load15: number;
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  disks: Array<{
    filesystem: string;
    size: string;
    used: string;
    available: string;
    usePercent: string;
    mountpoint: string;
  }>;
}

/**
 * Parse `server-load` output.
 *
 * Expected tagged format:
 *   UPTIME: 45 days, 3:21
 *   LOAD: 1.23 0.89 0.67
 *   MEM: 16384 12288 (75.0%)
 *   DISK: /dev/sda1 | 50G | 30G | 20G | 60% | /
 *   DISK: /dev/sdb1 | 200G | 150G | 50G | 75% | /apps_ux
 */
export function parseLoad(stdout: string): LoadData | null {
  const uptimeMatch = stdout.match(/UPTIME:\s*(.+)/);
  if (!uptimeMatch) return null;

  const loadMatch = stdout.match(
    /LOAD:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/
  );
  const memMatch = stdout.match(
    /MEM:\s*(\d+)\s+(\d+)\s*\(([\d.]+)%\)/
  );

  const disks: LoadData["disks"] = [];
  const diskLines = stdout.matchAll(
    /DISK:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)/g
  );
  for (const m of diskLines) {
    disks.push({
      filesystem: m[1].trim(),
      size: m[2].trim(),
      used: m[3].trim(),
      available: m[4].trim(),
      usePercent: m[5].trim(),
      mountpoint: m[6].trim(),
    });
  }

  return {
    uptime: uptimeMatch[1].trim(),
    load1: parseFloat(loadMatch?.[1] ?? "0"),
    load5: parseFloat(loadMatch?.[2] ?? "0"),
    load15: parseFloat(loadMatch?.[3] ?? "0"),
    memTotalMb: parseInt(memMatch?.[1] ?? "0", 10),
    memUsedMb: parseInt(memMatch?.[2] ?? "0", 10),
    memPercent: parseFloat(memMatch?.[3] ?? "0"),
    disks,
  };
}
