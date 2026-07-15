import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export type LogType = "app" | "catalina" | "access";

export interface LogSearchParams {
  logsBase: string;
  app: string;
  component: string;
  pattern: string;
  logType: LogType;
  date?: string;      // YYYY-MM-DD or "today"
  dateFrom?: string;
  dateTo?: string;
  maxLines: number;
  contextLines: number;
}

/**
 * Parameters for searching NR Apache httpd server logs.
 *
 * Log files are located at:
 *   {logsBase}/hot/   — active/recent logs (default)
 *   {logsBase}/cold/  — older rotated logs
 *
 * Domain-specific filenames follow the pattern:
 *   {domain}-{access|error}.{YYYY.MM.DD}.log
 * e.g. portalext.example.gov.bc.ca-access.2026.03.18.log
 *
 * The logsBase for Apache servers is typically /sw_ux/httpd01/logs.
 */
export interface HttpdLogSearchParams {
  logsBase: string;
  domain: string;               // e.g. "portalext.example.gov.bc.ca" or "default"
  logType: "access" | "error";
  subdir?: "hot" | "cold";      // defaults to "hot"
  pattern: string;
  date?: string;                // YYYY-MM-DD or "today"
  dateFrom?: string;            // YYYY-MM-DD (inclusive)
  dateTo?: string;              // YYYY-MM-DD (inclusive)
  maxLines: number;
  contextLines: number;
}

/** Shell metacharacters that would allow injection in grep patterns. */
const PATTERN_META = /[;&`$(){}\\<>]/;

/** Valid characters for an httpd virtual-host domain name or "default". */
const HTTPD_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*$/;

/**
 * Valid app / component identifier. Same spirit as HTTPD_DOMAIN_RE:
 * alphanumeric start, then letters/digits/dot/dash/underscore. Blocks "/",
 * whitespace, shell metacharacters, and path traversal ("../"), since both
 * values are interpolated unquoted into the remote `logDir` and shell globs.
 */
const APP_COMPONENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-]*$/;

function logFilePrefix(component: string, logType: LogType): string {
  switch (logType) {
    case "app":      return component;
    case "catalina": return "catalina";
    case "access":   return "localhost_access_log";
  }
}

/**
 * Build the remote grep command for searching logs.
 * Mirrors the logic in ~/bin/server-log-search.
 * Throws if pattern contains shell metacharacters.
 */
export function buildLogSearchCommand(params: LogSearchParams): string {
  const { logsBase, app, component, pattern, logType, date, dateFrom, dateTo, maxLines, contextLines } = params;

  if (PATTERN_META.test(pattern)) {
    throw new Error("Pattern contains shell metacharacters");
  }
  if (!APP_COMPONENT_RE.test(app) || !APP_COMPONENT_RE.test(component)) {
    throw new Error("App or component contains invalid characters");
  }

  const logDir = `${logsBase}/${app}/${component}`;
  const prefix = logFilePrefix(component, logType);
  const grepOpts = `-E -n -a${contextLines > 0 ? ` -C ${contextLines}` : ""}`;

  // When the conventional ${component}.log isn't present, discover the real
  // app log by listing the dir and excluding Tomcat's own logs (catalina,
  // localhost, localhost_access_log, host-manager, manager, gc). This picks
  // up non-conventional names like FTA's APP-FTA.log without hardcoding them.
  // For catalina/access logs the fixed prefix glob is correct, so only
  // broaden discovery for the app log type. The [._-] anchor requires a
  // separator after the token so an app like "gcal-war" isn't excluded by "gc".
  const fallbackLs = logType === "app"
    ? `ls -t ${logDir}/*.log 2>/dev/null | grep -vE '/(catalina|localhost|host-manager|manager|gc)[._-]'`
    : `ls -t ${logDir}/${prefix}*.log 2>/dev/null`;

  // Date range mode
  if (dateFrom && dateTo) {
    return [
      `( d='${dateFrom}'; end='${dateTo}';`,
      ` while [ "$d" != "$end" ] && [ "$d" \\< "$end" ] || [ "$d" = "$end" ]; do`,
      `   f="${logDir}/${prefix}.$\{d}.log"; fgz="$\{f}.gz";`,
      `   if [ -f "$f" ]; then grep ${grepOpts} '${pattern}' "$f" 2>/dev/null;`,
      `   elif [ -f "$fgz" ]; then zgrep ${grepOpts} '${pattern}' "$fgz" 2>/dev/null; fi;`,
      `   d=$(date -d "$d + 1 day" +%Y-%m-%d); done`,
      `) | tail -${maxLines}`,
    ].join("\n");
  }

  // Specific date mode
  if (date) {
    const dateStr = date === "today" ? "$(date +%Y-%m-%d)" : date;
    const current = `${logDir}/${prefix}.log`;
    const dated   = `${logDir}/${prefix}.${dateStr}.log`;
    const gz      = `${logDir}/${prefix}.${dateStr}.log.gz`;

    if (date === "today") {
      return (
        `if [ -f ${current} ]; then grep ${grepOpts} '${pattern}' ${current} | tail -${maxLines};` +
        ` elif [ -f ${dated} ]; then grep ${grepOpts} '${pattern}' ${dated} | tail -${maxLines};` +
        ` elif [ -f ${gz} ]; then zgrep ${grepOpts} '${pattern}' ${gz} | tail -${maxLines};` +
        ` else newest=$(${fallbackLs} | head -1);` +
        `   if [ -n "$newest" ]; then grep ${grepOpts} '${pattern}' "$newest" | tail -${maxLines};` +
        `   else echo 'Log file not found in ${logDir}'; fi; fi`
      );
    }
    return (
      `if [ -f ${dated} ]; then grep ${grepOpts} '${pattern}' ${dated} | tail -${maxLines};` +
      ` elif [ -f ${gz} ]; then zgrep ${grepOpts} '${pattern}' ${gz} | tail -${maxLines};` +
      ` else echo 'Log file not found: ${dated}'; fi`
    );
  }

  // Current (active) log
  const logFile = logType === "app"
    ? `${logDir}/${component}.log`
    : `${logDir}/${prefix}.$(date +%Y-%m-%d).log`;

  return (
    `if [ -f ${logFile} ]; then grep ${grepOpts} '${pattern}' ${logFile} | tail -${maxLines};` +
    ` else newest=$(${fallbackLs} | head -1);` +
    `   if [ -n "$newest" ]; then grep ${grepOpts} '${pattern}' "$newest" | tail -${maxLines};` +
    `   else echo 'Log file not found: ${logFile}'; fi; fi`
  );
}

/**
 * Build the remote grep command for searching NR Apache httpd server logs.
 *
 * Apache httpd log files use a different directory layout and filename
 * convention from Tomcat application logs:
 *   {logsBase}/{subdir}/{domain}-{access|error}.{YYYY.MM.DD}.log
 *
 * Note: dates in filenames use dots (YYYY.MM.DD), not dashes (YYYY-MM-DD).
 *
 * These servers store logs in a hot/cold split:
 *   hot  — recently active log files
 *   cold — older rotated log files
 *
 * Throws if pattern contains shell metacharacters.
 */
export function buildHttpdLogSearchCommand(params: HttpdLogSearchParams): string {
  const {
    logsBase, domain, logType, subdir = "hot", pattern,
    date, dateFrom, dateTo, maxLines, contextLines,
  } = params;

  if (PATTERN_META.test(pattern)) {
    throw new Error("Pattern contains shell metacharacters");
  }

  if (!HTTPD_DOMAIN_RE.test(domain)) {
    throw new Error("Domain contains invalid characters");
  }

  const logDir = `${logsBase}/${subdir}`;
  const prefix = `${domain}-${logType}`;
  const grepOpts = `-E -n -a${contextLines > 0 ? ` -C ${contextLines}` : ""}`;

  // Date range mode — loop over each day, converting YYYY-MM-DD to YYYY.MM.DD
  if (dateFrom && dateTo) {
    return [
      `( d='${dateFrom}'; end='${dateTo}';`,
      ` while [ "$d" != "$end" ] && [ "$d" \\< "$end" ] || [ "$d" = "$end" ]; do`,
      `   fd=$(echo "$d" | tr '-' '.'); f="${logDir}/${prefix}.$\{fd}.log";`,
      `   if [ -f "$f" ]; then grep ${grepOpts} '${pattern}' "$f" 2>/dev/null; fi;`,
      `   d=$(date -d "$d + 1 day" +%Y-%m-%d); done`,
      `) | tail -${maxLines}`,
    ].join("\n");
  }

  // Specific date mode
  if (date) {
    if (date === "today") {
      const dated = `${logDir}/${prefix}.$(date +%Y.%m.%d).log`;
      return (
        `if [ -f ${dated} ]; then grep ${grepOpts} '${pattern}' ${dated} | tail -${maxLines};` +
        ` else newest=$(ls -t ${logDir}/${prefix}*.log 2>/dev/null | head -1);` +
        `   if [ -n "$newest" ]; then grep ${grepOpts} '${pattern}' "$newest" | tail -${maxLines};` +
        `   else echo 'No log files found in ${logDir} for ${prefix}'; fi; fi`
      );
    }
    // Convert YYYY-MM-DD to YYYY.MM.DD for the filename
    const fileDate = date.replace(/-/g, ".");
    const dated = `${logDir}/${prefix}.${fileDate}.log`;
    return (
      `if [ -f ${dated} ]; then grep ${grepOpts} '${pattern}' ${dated} | tail -${maxLines};` +
      ` else echo 'Log file not found: ${dated}'; fi`
    );
  }

  // No date specified — search the newest available log file
  return (
    `newest=$(ls -t ${logDir}/${prefix}*.log 2>/dev/null | head -1);` +
    ` if [ -n "$newest" ]; then grep ${grepOpts} '${pattern}' "$newest" | tail -${maxLines};` +
    ` else echo 'No log files found in ${logDir} for ${prefix}'; fi`
  );
}

/** Search Tomcat/Java application logs on a remote server. */
export async function searchLogs(
  entry: ServerEntry,
  params: Omit<LogSearchParams, "logsBase">,
  timeoutMs: number = 120_000,
): Promise<{ output: string; exitCode: number }> {
  const fullParams: LogSearchParams = { ...params, logsBase: entry.logsBase };
  const command = buildLogSearchCommand(fullParams);
  const result = await sshExec(entry, command, timeoutMs);
  // A search that found matches (or hit the "Log file not found" echo) has
  // stdout. Empty stdout means zero matches / empty log — report that plainly
  // rather than falling back to stderr, which would otherwise surface noise.
  if (result.stdout.trim()) {
    return { output: result.stdout, exitCode: result.exitCode };
  }
  const err = result.stderr.trim();
  return { output: err || "No matching lines found.", exitCode: result.exitCode };
}

/**
 * Search Apache httpd logs on a remote NR Apache server.
 *
 * These servers store logs under /sw_ux/httpd01/logs/hot (or cold) and use
 * the {domain}-{access|error}.{YYYY.MM.DD}.log filename convention.
 * The _A account has direct read access; no sudo is required (ensure
 * sudoUser is left empty in servers.conf for these servers).
 */
export async function searchHttpdLogs(
  entry: ServerEntry,
  params: Omit<HttpdLogSearchParams, "logsBase">,
  timeoutMs: number = 120_000,
): Promise<{ output: string; exitCode: number }> {
  const fullParams: HttpdLogSearchParams = { ...params, logsBase: entry.logsBase };
  const command = buildHttpdLogSearchCommand(fullParams);
  const result = await sshExec(entry, command, timeoutMs);
  return { output: result.stdout || result.stderr, exitCode: result.exitCode };
}
