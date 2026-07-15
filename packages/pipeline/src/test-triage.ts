#!/usr/bin/env node
/**
 * Test script: Run DETECT then TRIAGE (AI analysis + Jira duplicate search).
 * No ticket creation, no comments, no git operations.
 *
 * Usage:
 *   node packages/pipeline/dist/test-triage.js --server prod01 --app DMS --component dms-document-api
 *   node packages/pipeline/dist/test-triage.js --server prod01 --app SOS --component cwm-sos-api --model claude-sonnet-4.6
 */
import { parseArgs } from "node:util";
import {
  loadEnv,
  createBasicAuthFetch,
  PiScrubber,
} from "@nrs/auth";
import { JiraClient } from "@nrs/jira-mcp/client";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AssistantMessageEvent } from "@github/copilot-sdk";
import { detect } from "./steps/detect.js";
import type { PipelineContext, TriageResult } from "./types.js";

loadEnv();

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    app: { type: "string" },
    component: { type: "string" },
    model: { type: "string", default: "claude-sonnet-4.6" },
  },
  strict: true,
});

if (!values.server || !values.app || !values.component) {
  console.error(
    "Usage: test-triage --server <server> --app <APP> --component <component> [--model <model>]"
  );
  process.exit(1);
}

const model = values.model ?? "claude-sonnet-4.6";

// --- Step 1: DETECT ---
const ctx: PipelineContext = {
  server: values.server,
  app: values.app,
  component: values.component,
  dryRun: true,
  jiraProject: values.app,
  errors: [],
};

await detect(ctx);

if (ctx.errors.length === 0) {
  console.log("\nNo errors found — nothing to triage.");
  process.exit(0);
}

const topError = ctx.errors[0]!;
console.log(`\n========================================`);
console.log(`  TRIAGE TEST — model: ${model}`);
console.log(`========================================\n`);

// --- Step 2a: AI Analysis via Copilot SDK ---
const scrubber = new PiScrubber();
const copilotClient = new CopilotClient({ logLevel: "error" });
await copilotClient.start();

// Show available models
const models = await copilotClient.listModels();
console.log(`[AI] Available models: ${models.map(m => m.id).join(", ")}`);
console.log(`[AI] Using: ${model}\n`);

const systemPrompt = `You are a senior Java developer triaging production errors for BC Government applications.
Analyze the error and provide a JSON response with these fields:
- summary: one-line description of the issue
- rootCause: technical explanation of what's happening
- severity: "critical", "high", "medium", or "low"
- suggestedTitle: a Jira ticket title (imperative mood, under 80 chars)

Respond ONLY with valid JSON, no markdown fences.`;

const userPrompt = `Production error from ${ctx.app}/${ctx.component} on ${ctx.server}:\n\n${topError.stackTrace}`;
const scrubbedPrompt = scrubber.scrubText(userPrompt);

console.log(`[AI] Sending to ${model} (${scrubbedPrompt.length} chars)...`);

const startTime = Date.now();
let aiOutput = "";
try {
  const session = await copilotClient.createSession({
    model,
    onPermissionRequest: approveAll,
    systemMessage: { mode: "replace", content: systemPrompt },
    availableTools: [],
    infiniteSessions: { enabled: false },
  });

  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("AI timed out after 120s")), 120_000);
    session.on("assistant.message", (event: AssistantMessageEvent) => {
      aiOutput = event.data.content;
    });
    session.on("session.idle", () => { clearTimeout(timeout); resolve(); });
  });

  await session.send({ prompt: scrubbedPrompt });
  await done;
  await session.destroy();
} catch (e) {
  console.error(`[AI] Error: ${(e as Error).message}`);
  await copilotClient.stop();
  process.exit(1);
}
const elapsed = Date.now() - startTime;

console.log(`\n[AI] Response (${elapsed}ms):\n`);
console.log(aiOutput);

let triageResult: TriageResult;
try {
  triageResult = JSON.parse(aiOutput) as TriageResult;
  console.log(`\n[AI] Parsed OK — severity: ${triageResult.severity}`);
} catch {
  console.log(`\n[AI] WARNING: Response was not valid JSON`);
  triageResult = {
    summary: topError.message.slice(0, 200),
    rootCause: aiOutput,
    severity: "medium",
    suggestedTitle: `Fix ${topError.message.slice(0, 60)}`,
  };
}

// --- Step 2b: Jira Duplicate Search (read-only) ---
console.log(`\n--- Jira Duplicate Search ---\n`);

const email = process.env["ATLASSIAN_EMAIL"];
const password = process.env["ATLASSIAN_PASSWORD"];
const baseUrl = process.env["ATLASSIAN_BASE_URL"];
if (!email || !password || !baseUrl) {
  console.error("ATLASSIAN_EMAIL, ATLASSIAN_PASSWORD, and ATLASSIAN_BASE_URL must be set in ~/.raven/.env");
  await copilotClient.stop();
  process.exit(1);
}
const authFetch = createBasicAuthFetch(email, password);
const jiraClient = new JiraClient(authFetch, `${baseUrl}/int/jira`);

// Parse log4j format to extract meaningful keyword
const fullText = `${topError.message}\n${topError.stackTrace}`;
const exMatch = fullText.match(/([A-Za-z.]*[A-Za-z]+(?:Exception|Error))\b/);
let keyword: string;
if (exMatch) {
  keyword = exMatch[1]!.split(".").pop()!;
} else {
  const log4jMatch = topError.message.match(
    /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\w+:\s*\S+\s+([\w.]+(?:Impl|Service|Controller|Handler))\b/
  );
  keyword = log4jMatch ? log4jMatch[1]!.split(".").pop()! : "error";
}
console.log(`[JIRA] Extracted keyword: "${keyword}"`);

const jql = `project = ${ctx.app} AND text ~ "${keyword}" AND status != Done ORDER BY created DESC`;
console.log(`[JIRA] JQL: ${jql}`);

const searchResults = await jiraClient.searchIssues(jql, 5);
console.log(`[JIRA] Found ${searchResults.total} matching ticket(s)\n`);

if (searchResults.issues.length > 0) {
  for (const issue of searchResults.issues) {
    console.log(`  ${issue.key}  [${issue.fields.status.name}]  ${issue.fields.summary}`);
  }
  console.log(`\n[TRIAGE] DUPLICATE — would skip ticket creation`);
} else {
  console.log(`[TRIAGE] NEW ERROR — would create ticket:`);
  console.log(`  Title:    ${triageResult.suggestedTitle}`);
  console.log(`  Severity: ${triageResult.severity}`);
}

// Cleanup
await copilotClient.stop();
