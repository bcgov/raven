import type { JiraClient } from "@nrs/jira-mcp/client";
import { askAI } from "../ai-client.js";
import { startSpinner, stopSpinner } from "../spinner.js";
import type { ErrorInfo, TriageResult } from "../types.js";

/**
 * Extract error information from an existing Jira ticket.
 * Reads description + comments for stack traces and error details.
 * Returns populated errors array and triage result.
 */
export async function extractFromTicket(
  ticketKey: string,
  jiraClient: JiraClient
): Promise<{ errors: ErrorInfo[]; triageResult: TriageResult }> {
  startSpinner(`Reading ${ticketKey}...`);
  const issue = await jiraClient.getIssue(ticketKey);
  const comments = await jiraClient.getComments(ticketKey);
  stopSpinner();

  const description = issue.fields.description ?? "";
  const commentBodies = comments.comments.map((c) => c.body).join("\n\n");
  const fullText = `${description}\n\n${commentBodies}`;

  // Extract stack traces from {code} blocks and raw Exception patterns
  const errors = extractStackTraces(fullText);

  if (errors.length === 0) {
    // No clear stack trace — use the ticket summary/description as the error
    errors.push({
      message: issue.fields.summary,
      stackTrace: description.slice(0, 2000),
      dedupeKey: ticketKey,
      occurrences: 1,
    });
  }

  // Build triage result from ticket metadata + AI if needed
  const triageResult = await buildTriageResult(issue, errors);

  console.log(`[EXTRACT] ${ticketKey}: ${errors.length} error(s) extracted`);
  console.log(`[EXTRACT] Summary: ${triageResult.summary}`);

  return { errors, triageResult };
}

/** Extract stack traces from Jira-formatted text. */
function extractStackTraces(text: string): ErrorInfo[] {
  const errors: ErrorInfo[] = [];

  // Match {code} blocks that contain stack traces
  const codeBlocks = [...text.matchAll(/\{code(?::[\w=|]+)?\}([\s\S]*?)\{code\}/g)];
  for (const match of codeBlocks) {
    const block = match[1]!.trim();
    if (/Exception|Error|at\s+[\w.]+\(/.test(block)) {
      const firstLine = block.split("\n")[0]!.trim();
      errors.push({
        message: firstLine,
        stackTrace: block,
        dedupeKey: extractDedupeKey(block),
        occurrences: 1,
      });
    }
  }

  // Also look for bare stack traces (not in {code} blocks)
  // Lines starting with "at " or containing Exception/Error with class paths
  if (errors.length === 0) {
    const lines = text.split("\n");
    let current: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const isStackLine = /^\s*at\s/.test(line) || /Caused by:/.test(line);
      const isExceptionLine = /[A-Za-z.]+(?:Exception|Error)[:\s]/.test(trimmed) && trimmed.length > 20;

      if (isExceptionLine || isStackLine) {
        current.push(trimmed);
      } else if (current.length > 0) {
        if (current.length >= 2) {
          errors.push({
            message: current[0]!,
            stackTrace: current.join("\n"),
            dedupeKey: extractDedupeKey(current.join("\n")),
            occurrences: 1,
          });
        }
        current = [];
      }
    }
    if (current.length >= 2) {
      errors.push({
        message: current[0]!,
        stackTrace: current.join("\n"),
        dedupeKey: extractDedupeKey(current.join("\n")),
        occurrences: 1,
      });
    }
  }

  return errors;
}

/** Build a dedup key from a stack trace. */
function extractDedupeKey(trace: string): string {
  const exMatch = trace.match(/([A-Za-z.]+(?:Exception|Error))/);
  const frameMatch = trace.match(/^\s+at\s(.+)$/m);
  if (exMatch) {
    return `${exMatch[1]}::${frameMatch?.[1]?.trim() ?? ""}`;
  }
  return trace.slice(0, 150);
}

/** Build a TriageResult from ticket info, using AI if the description is sparse. */
async function buildTriageResult(
  issue: { key: string; fields: { summary: string; description: string | null; priority: { name: string } | null } },
  errors: ErrorInfo[]
): Promise<TriageResult> {
  const description = issue.fields.description ?? "";
  const hasDetail = description.length > 100;

  if (hasDetail) {
    // Try to extract structured info from the description
    const severity = mapPriorityToSeverity(issue.fields.priority?.name);
    return {
      summary: issue.fields.summary,
      rootCause: description.slice(0, 1000),
      severity,
      suggestedTitle: issue.fields.summary,
    };
  }

  // Sparse ticket — ask AI for analysis
  startSpinner("AI analyzing ticket...");
  const aiResponse = await askAI(
    `Jira ticket ${issue.key}: ${issue.fields.summary}\n\nStack trace:\n${errors[0]?.stackTrace ?? "(none)"}`,
    `Analyze this Jira bug ticket and provide a JSON response with: summary, rootCause, severity ("critical"|"high"|"medium"|"low"), suggestedTitle. Respond ONLY with valid JSON.`
  );
  stopSpinner();

  try {
    const cleaned = aiResponse.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
    return JSON.parse(cleaned) as TriageResult;
  } catch {
    return {
      summary: issue.fields.summary,
      rootCause: `See ${issue.key} for details.`,
      severity: mapPriorityToSeverity(issue.fields.priority?.name),
      suggestedTitle: issue.fields.summary,
    };
  }
}

/** Map Jira priority name to pipeline severity. */
function mapPriorityToSeverity(priority?: string): TriageResult["severity"] {
  switch (priority?.toLowerCase()) {
    case "highest":
    case "blocker":
      return "critical";
    case "high":
    case "critical":
      return "high";
    case "low":
    case "lowest":
      return "low";
    default:
      return "medium";
  }
}
