import type { JiraClient } from "@nrs/jira-mcp/client";
import { askAI } from "../ai-client.js";
import { startSpinner, stopSpinner } from "../spinner.js";
import type { ErrorInfo, PipelineContext, TriageResult } from "../types.js";

const TRIAGE_SYSTEM_PROMPT = `You are a senior Java developer triaging production errors for BC Government applications.
Analyze the error and provide a JSON response with these fields:
- summary: one-line description of the issue
- rootCause: technical explanation of what's happening
- severity: "critical", "high", "medium", or "low"
- suggestedTitle: a Jira ticket title (imperative mood, under 80 chars)

Respond ONLY with valid JSON, no markdown fences.`;

/**
 * Step 2: TRIAGE — Analyze errors with AI, check for duplicates, create Jira ticket.
 */
export async function triage(
  ctx: PipelineContext,
  jiraClient: JiraClient
): Promise<void> {
  if (ctx.errors.length === 0) {
    console.log("[TRIAGE] No errors to triage — skipping");
    return;
  }

  // Deduplicate errors by their dedupeKey root (group related stack traces)
  // Try each unique error until we find one that isn't a known duplicate
  const duplicatesFound: Array<{ errorIdx: number; ticketKey: string }> = [];
  let topError = ctx.errors[0]!;
  let triageResult: TriageResult | null = null;

  for (let errIdx = 0; errIdx < ctx.errors.length; errIdx++) {
    const currentError = ctx.errors[errIdx]!;
    console.log(`[TRIAGE] Analyzing error ${errIdx + 1}/${ctx.errors.length}: ${currentError.message.slice(0, 100)}...`);

    // Ask AI for root cause analysis (only for first error, or if previous was duplicate)
    if (!triageResult || duplicatesFound.length > 0) {
      startSpinner("AI analyzing error...");
      const aiResponse = await askAI(
        `Production error from ${ctx.app}/${ctx.component} on ${ctx.server}:\n\n${currentError.stackTrace}`,
        TRIAGE_SYSTEM_PROMPT
      );
      stopSpinner();

      try {
        const cleaned = aiResponse.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
        triageResult = JSON.parse(cleaned) as TriageResult;
      } catch {
        console.log("[TRIAGE] AI returned non-JSON response, using raw output");
        triageResult = {
          summary: currentError.message.slice(0, 200),
          rootCause: aiResponse,
          severity: "medium",
          suggestedTitle: `Fix ${currentError.message.slice(0, 60)}`,
        };
      }
      console.log(`[TRIAGE] Severity: ${triageResult.severity}`);
      console.log(`[TRIAGE] Root cause: ${triageResult.rootCause.slice(0, 200)}`);
    }

    // Search for existing Jira tickets
    const keyword = extractKeyword(currentError.message, currentError.stackTrace);
    const jql = `project = ${ctx.jiraProject} AND text ~ "${keyword}" AND status NOT IN (Done, Closed, Resolved) AND created >= -90d ORDER BY created DESC`;
    console.log(`[TRIAGE] Searching Jira: ${jql}`);

    let searchResults: { issues: Array<{ key: string; fields: { summary: string; status: { name: string }; created: string } }>; total: number };
    try {
      startSpinner("Searching Jira for duplicates...");
      searchResults = await jiraClient.searchIssues(jql, 5);
      stopSpinner();
    } catch (e) {
      stopSpinner();
      console.log(`[TRIAGE] Jira search failed: ${(e as Error).message}`);
      searchResults = { issues: [], total: 0 };
    }

    if (searchResults.issues.length > 0 && !ctx.forceNew) {
      const existing = searchResults.issues[0]!;
      console.log(
        `[TRIAGE] Duplicate found: ${existing.key} — ${existing.fields.summary}`
      );
      duplicatesFound.push({ errorIdx: errIdx, ticketKey: existing.key });

      if (!ctx.dryRun) {
        await jiraClient.addComment(
          existing.key,
          `[RAVEN Pipeline] This error was detected again on ${ctx.server} (${new Date().toISOString()}).\n\n` +
            `Occurrences in current scan: ${currentError.occurrences}\n` +
            `AI analysis: ${triageResult.rootCause}`
        );
        console.log(`[TRIAGE] Added comment to ${existing.key}`);
      }

      if (errIdx < ctx.errors.length - 1) {
        console.log(`[TRIAGE] Trying next error...`);
        triageResult = null; // Re-analyze next error
        continue;
      }

      // All errors are duplicates
      console.log(`[TRIAGE] All ${ctx.errors.length} error(s) are known duplicates`);
      ctx.isDuplicate = true;
      ctx.ticketKey = duplicatesFound[0]!.ticketKey;
      ctx.triageResult = triageResult;
      return;
    }

    if (searchResults.issues.length > 0 && ctx.forceNew) {
      console.log(`[TRIAGE] Duplicate(s) found but --force-new set — creating new ticket anyway`);
    }

    // This error is new — use it as the primary error
    topError = currentError;
    ctx.triageResult = triageResult;
    // Reorder ctx.errors so this one is first (plan/implement steps use errors[0])
    if (errIdx > 0) {
      ctx.errors.splice(errIdx, 1);
      ctx.errors.unshift(topError);
      console.log(`[TRIAGE] Using error ${errIdx + 1} as primary (${duplicatesFound.length} duplicate(s) skipped)`);
    }
    break;
  }

  // Check for old resolved tickets — regression detection
  // Search without status/date filters to find historical matches
  const keyword = extractKeyword(topError.message, topError.stackTrace);
  let regressionRef: string | undefined;
  if (!ctx.forceNew) {
    const historyJql = `project = ${ctx.jiraProject} AND text ~ "${keyword}" ORDER BY created DESC`;
    try {
      const historyResults = await jiraClient.searchIssues(historyJql, 3);
      if (historyResults.issues.length > 0) {
        const oldTicket = historyResults.issues[0]!;
        console.log(
          `[TRIAGE] Possible regression — previously seen in ${oldTicket.key} (${oldTicket.fields.status.name}): ${oldTicket.fields.summary}`
        );
        regressionRef = oldTicket.key;
      }
    } catch {
      // Non-critical — continue without regression context
    }
  }

  // Create new Jira ticket
  if (!triageResult) {
    console.log("[TRIAGE] No triage result — skipping ticket creation");
    return;
  }
  ctx.isDuplicate = false;
  if (ctx.dryRun) {
    console.log(`[TRIAGE] DRY RUN — would create ticket: "${triageResult.suggestedTitle}"`);
    if (regressionRef) {
      console.log(`[TRIAGE] DRY RUN — would reference regression from ${regressionRef}`);
    }
    return;
  }

  const regressionNote = regressionRef
    ? `h3. Regression\nThis error was previously tracked in ${regressionRef} (now resolved). It may have regressed or resurfaced.\n\n`
    : "";

  startSpinner("Creating Jira ticket...");
  const issueResponse = await jiraClient.createIssue({
    project: { key: ctx.jiraProject },
    summary: triageResult.suggestedTitle,
    description:
      `h3. Error Details\n` +
      `*Server:* ${ctx.server}\n` +
      `*Component:* ${ctx.component}\n` +
      `*Occurrences:* ${topError.occurrences}\n` +
      `*Severity:* ${triageResult.severity}\n\n` +
      regressionNote +
      `h3. Root Cause Analysis\n` +
      `${triageResult.rootCause}\n\n` +
      `h3. Stack Trace\n` +
      `{code}\n${topError.stackTrace}\n{code}\n\n` +
      `_Created by RAVEN Autonomous Pipeline_`,
    issuetype: { name: "Bug" },
    priority: { name: severityToPriority(triageResult.severity) },
    labels: ["raven-pipeline", "auto-detected"],
  });

  stopSpinner();
  ctx.ticketKey = issueResponse.key;
  console.log(`[TRIAGE] Created ticket: ${ctx.ticketKey}`);
}

/**
 * Extract the most distinctive keyword from an error for Jira search.
 * Prefers app-specific class names over generic JDK exceptions.
 *
 * Priority:
 * 1. App-specific classes from log4j format (e.g., UUIDJAXBAdapter, FolderServiceImpl)
 * 2. App-specific exception/class from ca.bc.gov.* package
 * 3. Non-stdlib exception class name
 * 4. Fully-qualified class name
 * 5. Distinctive word from the error message
 */
export function extractKeyword(message: string, stackTrace: string): string {
  const fullText = `${message}\n${stackTrace}`;

  // 1. App-specific class from log4j format (most distinctive)
  const log4jMatch = message.match(
    /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\w+\s+\S+\s+([\w.]*[A-Z][\w]*(?:Adapter|Impl|Service|Controller|Handler|Filter|Interceptor|Task|Subtask))\b/
  );
  if (log4jMatch) {
    return log4jMatch[1]!.split(".").pop()!;
  }

  // 2. ca.bc.gov.* class references (app-specific)
  const govMatch = fullText.match(/\b(ca\.bc\.gov[\w.]+)\b/);
  if (govMatch) {
    const simple = govMatch[1]!.split(".").pop()!;
    if (simple[0]! >= "A" && simple[0]! <= "Z") return simple;
  }

  // 3. Non-stdlib exception class
  const stdlibExceptions = new Set([
    "IllegalArgumentException", "NullPointerException", "RuntimeException",
    "Exception", "Error", "Throwable", "IOException", "ClassNotFoundException",
    "NoSuchMethodException", "UnsupportedOperationException", "SecurityException",
    "ClassCastException", "ArrayIndexOutOfBoundsException", "NumberFormatException",
    "ConcurrentModificationException", "InterruptedException", "IllegalStateException",
    "StackOverflowError", "OutOfMemoryError", "SQLException",
  ]);
  const exMatches = [...fullText.matchAll(/\b([A-Za-z.]*[A-Z][\w]*(?:Exception|Error))\b/g)];
  for (const m of exMatches) {
    const simple = m[1]!.split(".").pop()!;
    if (!stdlibExceptions.has(simple)) return simple;
  }

  // 4. Fall back to any exception (even stdlib — better than nothing)
  if (exMatches.length > 0) {
    return exMatches[0]![1]!.split(".").pop()!;
  }

  // 5. Look for any fully-qualified Java class name
  const fqcnMatch = fullText.match(/\b((?:[a-z]+\.){2,}[A-Z]\w+)\b/);
  if (fqcnMatch) return fqcnMatch[1]!.split(".").pop()!;

  // 6. Distinctive word from the error message
  const noise = new Set(["error", "ERROR", "FATAL", "WARN", "INFO", "null", "could", "because", "does", "exist"]);
  const words = message
    .replace(/^\d+[:-]/, "")
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/, "")
    .split(/\s+/)
    .filter((w) => w.length > 4 && /^[A-Za-z]/.test(w) && !noise.has(w));
  return words[0] ?? "error";
}

/**
 * Select the error from `errors` that best matches a Jira ticket's text.
 * Used when --ticket is supplied so PLAN/IMPLEMENT operate on the error
 * the ticket describes — not just whichever error has the most occurrences.
 *
 * Returns the index of the best-matching error, or -1 if no error matches
 * (caller should fall back to errors[0]).
 */
export function selectErrorMatchingTicket(
  errors: ErrorInfo[],
  ticketText: string
): number {
  if (errors.length === 0) return -1;

  // Extract candidate Java class names from the ticket text. Tickets typically
  // name the class in the title (e.g., "FileServiceImpl date parsing fails"),
  // so CamelCase identifiers with common Java suffixes are the strongest signal.
  const classPattern =
    /\b([A-Z][a-zA-Z0-9]*(?:Impl|Service|Controller|Handler|Filter|Interceptor|Task|Subtask|Adapter|Endpoint|Repository|DAO|Manager|Provider|Resolver|Listener|Builder|Factory|Validator|Mapper|Converter|Helper|Util)|[A-Z][a-zA-Z0-9]*(?:Exception|Error))\b/g;
  const candidates = new Set(
    [...ticketText.matchAll(classPattern)].map((m) => m[1]!)
  );
  if (candidates.size === 0) return -1;

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < errors.length; i++) {
    const err = errors[i]!;
    const haystack = `${err.message}\n${err.stackTrace}`;
    let score = 0;
    for (const candidate of candidates) {
      if (haystack.includes(candidate)) score++;
    }
    // Bonus when the error's primary keyword (the most distinctive token
    // chosen by extractKeyword) is named in the ticket — that's a near-certain
    // match.
    const keyword = extractKeyword(err.message, err.stackTrace);
    if (candidates.has(keyword)) score += 2;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Map AI severity to Jira priority names.
 * Uses standard Jira Cloud priority names (Highest/High/Medium/Low/Lowest).
 * Falls back gracefully if the project uses a custom priority scheme.
 */
function severityToPriority(
  severity: TriageResult["severity"]
): string {
  switch (severity) {
    case "critical":
      return "Highest";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
  }
}
