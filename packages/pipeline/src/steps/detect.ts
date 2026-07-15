import { searchLogs } from "@nrs/server-mcp/client";
import { getServerConfig } from "@nrs/auth";
import { startSpinner, stopSpinner } from "../spinner.js";
import type { ErrorInfo, PipelineContext } from "../types.js";

const MAX_LOOKBACK_DAYS = 7;

/**
 * Step 1: DETECT — Scan server logs for errors and extract unique stack traces.
 * Checks the current log first, then walks backwards day by day until errors are found.
 */
export async function detect(ctx: PipelineContext): Promise<void> {
  console.log(`[DETECT] Scanning ${ctx.server}/${ctx.app}/${ctx.component} for errors...`);

  // Try current log first (no --date flag = latest log file)
  startSpinner("Scanning server logs...");
  const currentResult = await scanLogs(ctx);
  stopSpinner();
  if (currentResult.length > 0) {
    ctx.errors = currentResult;
    printErrors(ctx.errors);
    return;
  }

  // Walk backwards day by day
  console.log(`[DETECT] No errors in current log — scanning recent days...`);
  for (let daysAgo = 0; daysAgo <= MAX_LOOKBACK_DAYS; daysAgo++) {
    const date = getDateString(daysAgo);
    console.log(`[DETECT] Checking ${date}...`);
    const result = await scanLogs(ctx, date);
    if (result.length > 0) {
      ctx.errors = result;
      console.log(`[DETECT] Found errors on ${date}`);
      printErrors(ctx.errors);
      return;
    }
  }

  console.log(`[DETECT] No errors found in the last ${MAX_LOOKBACK_DAYS + 1} days`);
  ctx.errors = [];
}

/** Run a single log scan, optionally for a specific date. */
async function scanLogs(ctx: PipelineContext, date?: string): Promise<ErrorInfo[]> {
  const entry = getServerConfig().find((s) => s.name === ctx.server);
  if (!entry) {
    console.log(`[DETECT] Server '${ctx.server}' not found in servers.conf`);
    return [];
  }

  const result = await searchLogs(entry, {
    app: ctx.app,
    component: ctx.component,
    pattern: "ERROR",
    logType: "app",
    date,
    maxLines: 200,
    contextLines: 5,
  });

  if (result.exitCode !== 0 && !result.output) {
    console.log(`[DETECT] Log scan failed (exit ${result.exitCode})`);
    return [];
  }

  return parseErrors(result.output);
}

/** Get a YYYY-MM-DD date string for N days ago. */
function getDateString(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0]!;
}

/** Print a summary of detected errors. */
function printErrors(errors: ErrorInfo[]): void {
  console.log(`[DETECT] Found ${errors.length} unique error(s)`);
  for (const err of errors) {
    console.log(`  - ${err.message.slice(0, 120)} (${err.occurrences}x)`);
  }
}

/** Parse log output into deduplicated ErrorInfo entries. */
function parseErrors(logOutput: string): ErrorInfo[] {
  const lines = logOutput.split("\n");
  const errorMap = new Map<string, ErrorInfo>();

  let currentError: { message: string; traceLines: string[] } | null = null;

  for (const line of lines) {
    // Skip shell noise from expect scripts (prompts, commands, status messages)
    if (isShellNoise(line)) continue;

    // Match actual log lines with ERROR/Exception/FATAL
    // An Exception line without a log4j timestamp prefix is a stack trace continuation,
    // not a new error (e.g., "oracle.stellent.ridc.protocol.ServiceException: ..." following an ERROR line)
    const hasLogPrefix = /^\d*[:-]?\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(line) || /\b(ERROR|FATAL)\b/.test(line);
    const isExceptionOnly = /Exception[:\s]/.test(line) && !hasLogPrefix;
    const isErrorLine = hasLogPrefix && (/\bERROR\b/.test(line) || /\bFATAL\b/.test(line));
    const isStackFrame = /^\s+at\s/.test(line) || /^\s+\.\.\.\s\d+\smore/.test(line);
    const isCausedBy = /^Caused by:/.test(line.trim());

    if (isErrorLine && !isStackFrame) {
      // Flush previous error
      if (currentError) {
        addError(errorMap, currentError);
      }
      currentError = { message: line.trim(), traceLines: [line.trim()] };
    } else if (currentError && (isStackFrame || isCausedBy || isExceptionOnly)) {
      currentError.traceLines.push(line.trimEnd());
    } else if (currentError) {
      // Non-stack line ends the current trace
      addError(errorMap, currentError);
      currentError = null;
    }
  }

  // Flush last error
  if (currentError) {
    addError(errorMap, currentError);
  }

  // Merge errors that share the same app-specific class (ca.bc.gov.*)
  // e.g., FolderServiceImpl ERROR + ServiceException from the same method are one issue
  const merged = mergeRelatedErrors(Array.from(errorMap.values()));
  return merged.sort((a, b) => b.occurrences - a.occurrences);
}

/** Merge errors that reference the same app-specific class into one entry. */
function mergeRelatedErrors(errors: ErrorInfo[]): ErrorInfo[] {
  if (errors.length <= 1) return errors;

  // Group key narrow enough that two different bugs (different method or
  // different message) coming from the same class don't collapse into
  // one ErrorInfo with inflated occurrence counts. Prefer class+method
  // from a stack frame; fall back to class+message-prefix when only the
  // log4j class column is available.
  const getAppClass = (err: ErrorInfo): string | null => {
    const fullText = `${err.message}\n${err.stackTrace}`;
    // Stack frame: "at ca.bc.gov.nrs.cwm.FolderServiceImpl.getFolder(FolderServiceImpl.java:42)"
    const frameMatch = fullText.match(/\bat\s+ca\.bc\.gov[\w.]*\.([A-Z]\w+)\.(\w+)\(/);
    if (frameMatch) return `${frameMatch[1]}.${frameMatch[2]}`;
    // Log4j class column: "ERROR thread FolderServiceImpl:70" — no method.
    // Combine class with a message prefix so the same class throwing two
    // different errors yields two groups.
    const msgPrefix = err.message.slice(0, 60);
    const log4jMatch = err.message.match(
      /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\S+\s+([\w]+(?:Impl|Service|Controller|Handler|Task|Adapter))\b/
    );
    if (log4jMatch) return `${log4jMatch[1]}::${msgPrefix}`;
    // ca.bc.gov class without a stack frame
    const govMatch = fullText.match(/\bca\.bc\.gov[\w.]*\.([A-Z]\w+)\b/);
    if (govMatch) return `${govMatch[1]}::${msgPrefix}`;
    return null;
  };

  const groups = new Map<string, ErrorInfo[]>();
  const ungrouped: ErrorInfo[] = [];

  for (const err of errors) {
    const cls = getAppClass(err);
    if (cls) {
      const group = groups.get(cls) ?? [];
      group.push(err);
      groups.set(cls, group);
    } else {
      ungrouped.push(err);
    }
  }

  const result: ErrorInfo[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      result.push(group[0]!);
    } else {
      // Merge: keep the one with the most context, sum occurrences
      group.sort((a, b) => b.stackTrace.length - a.stackTrace.length);
      const primary = group[0]!;
      for (const other of group.slice(1)) {
        primary.occurrences += other.occurrences;
        // Append other stack traces if they add new info
        if (!primary.stackTrace.includes(other.message)) {
          primary.stackTrace += `\n\n--- Related error ---\n${other.stackTrace}`;
        }
      }
      result.push(primary);
    }
  }
  result.push(...ungrouped);
  return result;
}

/** Filter out shell/expect script noise that isn't actual log content. */
function isShellNoise(line: string): boolean {
  // Terminal control sequences
  if (/\[\?\d+[hl]/.test(line)) return true;
  // Shell prompts (e.g., "[wwwsvr@prod01 jsmith_a]$")
  if (/\[.*@.*\]\$/.test(line)) return true;
  // Script status messages (e.g., "Searching 'ERROR' in app logs on...")
  if (/Searching .* in .* logs on/.test(line)) return true;
  // Shell commands (if/elif/else/fi, grep, zgrep, ls, tail)
  if (/^\s*if \[|^\s*elif \[|^\s*else\b|^\s*fi\b/.test(line)) return true;
  if (/^\s*(grep|zgrep|tail|ls|newest=)\b/.test(line)) return true;
  // Empty or separator lines
  if (/^\s*[-—=]+\s*$/.test(line)) return true;
  return false;
}

/** Build a dedup key and merge into the error map. */
function addError(
  map: Map<string, ErrorInfo>,
  raw: { message: string; traceLines: string[] }
): void {
  // Dedup key: exception class + first stack frame, or normalized message
  const exceptionMatch = raw.message.match(
    /([A-Za-z.]+(?:Exception|Error))/
  );
  const firstFrame = raw.traceLines.find((l) => /^\s+at\s/.test(l))?.trim() ?? "";

  // For the message-based key, normalize out variable parts (GUIDs, IDs, paths, timestamps, line numbers)
  const normalizedMsg = raw.message
    .replace(/^\d+[:-]/, "")                          // strip leading line number
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/, "")  // strip timestamp
    .replace(/[A-F0-9]{16,}/gi, "<ID>")               // hex GUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/[A-Z]{2,}(?:API|UI)[A-F0-9]+/gi, "<REQ>") // request IDs like DMSAPI28BC6060D772, SNCUIEB45C5223957
    .replace(/'path:[^']+'/g, "'path:<PATH>'")         // path references
    .replace(/#\d+/g, "#<NUM>")                        // ticket/ID numbers
    .trim();

  const key = exceptionMatch
    ? `${exceptionMatch[1]}::${firstFrame || normalizedMsg}`
    : normalizedMsg.slice(0, 150);

  const existing = map.get(key);
  if (existing) {
    existing.occurrences += 1;
    // Keep the longer stack trace
    if (raw.traceLines.length > existing.stackTrace.split("\n").length) {
      existing.stackTrace = raw.traceLines.join("\n");
    }
  } else {
    map.set(key, {
      message: raw.message,
      stackTrace: raw.traceLines.join("\n"),
      dedupeKey: key,
      occurrences: 1,
    });
  }
}
