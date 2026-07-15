#!/usr/bin/env node
/**
 * Test script: Run DETECT → TRIAGE (AI only) → PLAN (cross-repo source search + AI fix plan).
 * Read-only: no Jira writes, no git operations.
 *
 * Usage:
 *   node packages/pipeline/dist/test-plan.js --server prod01 --app SOS --component cwm-sos-api --bb-project CWM --bb-repo cwm-sos-api
 *   node packages/pipeline/dist/test-plan.js --server prod01 --app DMS --component dms-document-api --model gpt-4.1-mini
 */
import { parseArgs } from "node:util";
import {
  loadEnv,
  createBasicAuthFetch,
  PiScrubber,
} from "@nrs/auth";
import { BitbucketClient } from "@nrs/bitbucket-mcp/client";
import type { BitbucketBrowseResponse } from "@nrs/bitbucket-mcp/client";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AssistantMessageEvent } from "@github/copilot-sdk";
import { detect } from "./steps/detect.js";
import type { PipelineContext } from "./types.js";

loadEnv();

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    app: { type: "string" },
    component: { type: "string" },
    model: { type: "string", default: "gpt-4.1" },
    "bb-project": { type: "string" },
    "bb-repo": { type: "string" },
  },
  strict: true,
});

if (!values.server || !values.app || !values.component) {
  console.error(
    "Usage: test-plan --server <server> --app <APP> --component <component> [--model <model>] [--bb-project <key>] [--bb-repo <slug>]"
  );
  process.exit(1);
}

const model = values.model ?? "gpt-4.1";
const bbProject = values["bb-project"] ?? values.app;
const bbRepo = values["bb-repo"] ?? values.component;

// --- Auth ---
const email = process.env["ATLASSIAN_EMAIL"];
const password = process.env["ATLASSIAN_PASSWORD"];
const baseUrl = process.env["ATLASSIAN_BASE_URL"];
if (!email || !password || !baseUrl) {
  console.error("ATLASSIAN_EMAIL, ATLASSIAN_PASSWORD, and ATLASSIAN_BASE_URL must be set in ~/.raven/.env");
  process.exit(1);
}
const authFetch = createBasicAuthFetch(email, password);
const bbClient = new BitbucketClient(authFetch, `${baseUrl}/int/stash`);

// --- AI (Copilot SDK) ---
const scrubber = new PiScrubber();
const copilotClient = new CopilotClient({ logLevel: "error" });
await copilotClient.start();

// List available models
const models = await copilotClient.listModels();
console.log(`[AI] Available models: ${models.map(m => m.id).join(", ")}`);
console.log(`[AI] Using model: ${model}`);

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
  console.log("\nNo errors found — nothing to plan.");
  process.exit(0);
}

const topError = ctx.errors[0]!;

// --- Step 2: Quick AI Triage (no Jira) ---
console.log(`\n========================================`);
console.log(`  PLAN TEST — model: ${model}`);
console.log(`  Bitbucket: ${bbProject}/${bbRepo}`);
console.log(`========================================\n`);

// --- Step 3: Cross-repo source finding ---
console.log(`[PLAN] Extracting target classes from ALL errors...`);

// Scan ALL errors for class names, not just the top one
const targetClasses = new Set<string>();
const fileHints: string[] = [];
for (const err of ctx.errors) {
  for (const cls of extractTargetClasses(err.message, err.stackTrace)) {
    targetClasses.add(cls);
  }
  for (const hint of extractFileHints(err.stackTrace, err.message)) {
    if (!fileHints.includes(hint)) fileHints.push(hint);
  }
}
console.log(`[PLAN] Target classes: ${[...targetClasses].join(", ") || "(none)"}`);
console.log(`[PLAN] Stack trace file hints: ${fileHints.length}`);

const sourceFiles: Array<{ path: string; content: string; repo: string }> = [];
let sourceRepo = bbRepo;

// Strategy 1: Direct file paths from stack trace
for (const hint of fileHints.slice(0, 5)) {
  try {
    const content = await bbClient.readFile(bbProject, bbRepo, hint);
    sourceFiles.push({ path: hint, content, repo: bbRepo });
    console.log(`[PLAN] Read: ${bbProject}/${bbRepo}/${hint}`);
  } catch {
    // Not found
  }
}

// Strategy 2: Walk the app repo tree
if (targetClasses.size > 0) {
  const remainingClasses = new Set([...targetClasses].filter(
    (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
  ));
  if (remainingClasses.size > 0) {
    console.log(`[PLAN] Searching ${bbProject}/${bbRepo} tree for: ${[...remainingClasses].join(", ")}`);
    const found = await findFilesInRepo(bbClient, bbProject, bbRepo, remainingClasses);
    for (const filePath of found.slice(0, 3)) {
      try {
        const content = await bbClient.readFile(bbProject, bbRepo, filePath);
        sourceFiles.push({ path: filePath, content, repo: bbRepo });
        console.log(`[PLAN] Found in app repo: ${filePath}`);
      } catch { /* skip */ }
    }
  }
}

// Strategy 3: Read pom.xml for internal dependencies — search for unfound classes
const unfoundClasses = new Set([...targetClasses].filter(
  (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
));
if (unfoundClasses.size > 0) {
  console.log(`[PLAN] Still looking for: ${[...unfoundClasses].join(", ")}`);
  console.log(`[PLAN] Checking dependencies...`);
  const depRepos = await findDependencyRepos(bbClient, bbProject, bbRepo);
  console.log(`[PLAN] Found ${depRepos.length} dependency repo(s): ${depRepos.join(", ")}`);

  for (const depRepo of depRepos) {
    if (unfoundClasses.size === 0) break;
    console.log(`[PLAN] Searching dependency: ${bbProject}/${depRepo}`);
    const found = await findFilesInRepo(bbClient, bbProject, depRepo, unfoundClasses);
    for (const filePath of found.slice(0, 3)) {
      try {
        const content = await bbClient.readFile(bbProject, depRepo, filePath);
        sourceFiles.push({ path: filePath, content, repo: depRepo });
        sourceRepo = depRepo;
        const fileName = filePath.split("/").pop();
        if (fileName) unfoundClasses.delete(fileName);
        console.log(`[PLAN] Found in dependency: ${bbProject}/${depRepo}/${filePath}`);
      } catch { /* skip */ }
    }
  }
}

// Strategy 4: Search sibling repos for any still-unfound classes
const stillUnfound = new Set([...targetClasses].filter(
  (cls) => !sourceFiles.some((sf) => sf.path.endsWith(cls))
));
if (stillUnfound.size > 0) {
  console.log(`[PLAN] Searching sibling repos in project ${bbProject} for: ${[...stillUnfound].join(", ")}`);
  try {
    const repos = await bbClient.listRepos(bbProject, 100);
    const siblingRepos = repos.values
      .map((r) => r.slug)
      .filter((slug) => slug !== bbRepo)
      .sort((a, b) => {
        const aLib = isLibraryRepo(a) ? -1 : 0;
        const bLib = isLibraryRepo(b) ? -1 : 0;
        return aLib - bLib;
      });

    console.log(`[PLAN] ${siblingRepos.length} sibling repo(s) to search`);

    for (const sibling of siblingRepos) {
      if (stillUnfound.size === 0) break;
      console.log(`[PLAN] Searching: ${bbProject}/${sibling}`);
      const found = await findFilesInRepo(bbClient, bbProject, sibling, stillUnfound);
      for (const filePath of found.slice(0, 3)) {
        try {
          const content = await bbClient.readFile(bbProject, sibling, filePath);
          sourceFiles.push({ path: filePath, content, repo: sibling });
          sourceRepo = sibling;
          const fileName = filePath.split("/").pop();
          if (fileName) stillUnfound.delete(fileName);
          console.log(`[PLAN] Found in sibling: ${bbProject}/${sibling}/${filePath}`);
        } catch { /* skip */ }
      }
    }
  } catch (e) {
    console.log(`[PLAN] Could not list repos: ${(e as Error).message}`);
  }
}

if (sourceRepo !== bbRepo) {
  console.log(`\n[PLAN] ⚠ Fix targets a DIFFERENT repo: ${bbProject}/${sourceRepo}`);
}

if (sourceFiles.length === 0) {
  console.log(`[PLAN] WARNING: No source files found in any repo`);
}

// --- Step 3b: Ask AI for fix plan ---
console.log(`\n--- AI Fix Plan ---\n`);

const planSystemPrompt = `You are a senior Java developer analyzing a production bug.
Given the error, stack trace, and relevant source files, respond in TWO sections:

SECTION 1 — JSON analysis (on a single line, no newlines inside the JSON):
{"affectedFiles":["path/to/File.java"],"rootCause":"explanation","proposedFix":"description","severity":"medium"}

SECTION 2 — Unified diff patch (after a blank line):
The actual unified diff that can be applied with git apply.

Example response format:
{"affectedFiles":["src/main/java/com/example/Foo.java"],"rootCause":"Null check missing","proposedFix":"Add null guard before access","severity":"medium"}

--- a/src/main/java/com/example/Foo.java
+++ b/src/main/java/com/example/Foo.java
@@ -10,3 +10,5 @@
+  if (value == null) return;
   value.process();`;

const sourceContext = sourceFiles.map((sf) => {
  const trimmed = extractRelevantCode(sf.content, topError.message);
  return `--- ${sf.repo}/${sf.path} ---\n${trimmed}`;
});

const planPrompt =
  `Component: ${values.component}\n` +
  (sourceRepo !== bbRepo ? `Note: The source is in repo ${bbProject}/${sourceRepo}, not ${bbProject}/${bbRepo}\n` : "") +
  `Error (${topError.occurrences}x):\n${topError.stackTrace}\n\n` +
  (sourceContext.length > 0
    ? `Relevant source files:\n\n${sourceContext.join("\n\n")}`
    : "No source files available — analyze based on the stack trace and error message.");

const scrubbedPrompt = scrubber.scrubText(planPrompt);
console.log(`[AI] Sending ${scrubbedPrompt.length} chars to ${model}...`);

const startTime = Date.now();
let aiOutput = "";
try {
  const session = await copilotClient.createSession({
    model,
    onPermissionRequest: approveAll,
    systemMessage: { mode: "replace", content: planSystemPrompt },
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

console.log(`[AI] Response (${elapsed}ms):\n`);
console.log(aiOutput);

// Parse two-section response
const { analysis, patch } = parseAiPlanResponse(aiOutput);

if (analysis) {
  console.log(`\n[PLAN] Analysis parsed OK`);
  console.log(`  Affected files: ${(analysis["affectedFiles"] as string[])?.join(", ") ?? "none"}`);
  console.log(`  Root cause: ${(analysis["rootCause"] as string)?.slice(0, 200) ?? "?"}`);
  console.log(`  Proposed fix: ${(analysis["proposedFix"] as string)?.slice(0, 200) ?? "?"}`);
  console.log(`  Severity: ${(analysis["severity"] as string) ?? "?"}`);
} else {
  console.log(`\n[PLAN] WARNING: Could not parse analysis JSON from response`);
}

if (patch) {
  console.log(`\n[PLAN] Patch (${patch.length} chars):`);
  console.log(patch);
} else {
  console.log(`\n[PLAN] No patch found in response`);
}

// Cleanup
await copilotClient.stop();

// ---- Helper functions ----

function extractTargetClasses(message: string, stackTrace: string): Set<string> {
  const classes = new Set<string>();
  const fullText = `${message}\n${stackTrace}`;

  const exMatches = fullText.matchAll(/\b([\w]+(?:Exception|Error|Adapter|Handler|Impl|Service|Filter|Interceptor))\b/g);
  for (const m of exMatches) {
    const name = m[1]!;
    if (!isStdlibClass(name)) {
      classes.add(`${name}.java`);
    }
  }

  const frameRegex = /at\s+([\w.]+)\.([\w]+)\(([\w]+\.java):\d+\)/g;
  let match;
  while ((match = frameRegex.exec(fullText)) !== null) {
    const pkg = match[1]!;
    const fileName = match[3]!;
    if (pkg === "ca.bc.gov" || pkg.startsWith("ca.bc.gov.")) {
      classes.add(fileName);
    }
  }

  const fqcnMatch = fullText.match(/\b(ca\.bc\.gov[\w.]+)\b/g);
  if (fqcnMatch) {
    for (const fqcn of fqcnMatch) {
      const simpleName = fqcn.split(".").pop();
      if (simpleName && simpleName[0]! >= "A" && simpleName[0]! <= "Z") {
        classes.add(`${simpleName}.java`);
      }
    }
  }

  return classes;
}

function isStdlibClass(name: string): boolean {
  const stdlib = new Set([
    "IllegalArgumentException", "NullPointerException", "RuntimeException",
    "Exception", "Error", "Throwable", "IOException", "ClassNotFoundException",
    "NoSuchMethodException", "UnsupportedOperationException", "SecurityException",
    "ClassCastException", "ArrayIndexOutOfBoundsException", "NumberFormatException",
    "ConcurrentModificationException", "InterruptedException", "IllegalStateException",
    "StackOverflowError", "OutOfMemoryError",
  ]);
  return stdlib.has(name);
}

function isLibraryRepo(slug: string): boolean {
  return /(?:generic|common|shared|lib|utils|core)/i.test(slug);
}

async function findDependencyRepos(
  client: BitbucketClient,
  project: string,
  repo: string
): Promise<string[]> {
  const depRepos: string[] = [];

  let rootPom = "";
  try {
    rootPom = await client.readFile(project, repo, "pom.xml");
  } catch {
    return depRepos;
  }

  const pomPaths = ["pom.xml"];
  const moduleRegex = /<module>([^<]+)<\/module>/g;
  let moduleMatch;
  while ((moduleMatch = moduleRegex.exec(rootPom)) !== null) {
    pomPaths.push(`${moduleMatch[1]}/pom.xml`);
  }

  const allPomContent = [rootPom];
  for (const pomPath of pomPaths.slice(1)) {
    try {
      const content = await client.readFile(project, repo, pomPath);
      allPomContent.push(content);
    } catch { /* skip */ }
  }

  for (const pomContent of allPomContent) {
    const depRegex = /<dependency>\s*<groupId>(ca\.bc\.gov[^<]*)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/gs;
    let depMatch;
    while ((depMatch = depRegex.exec(pomContent)) !== null) {
      const artifactId = depMatch[2]!;
      if (!depRepos.includes(artifactId)) {
        depRepos.push(artifactId);
      }
    }

    const parentMatch = pomContent.match(
      /<parent>\s*<groupId>(ca\.bc\.gov[^<]*)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/s
    );
    if (parentMatch) {
      const parentArtifact = parentMatch[2]!;
      if (!depRepos.includes(parentArtifact)) {
        depRepos.push(parentArtifact);
      }
    }
  }

  depRepos.sort((a, b) => {
    const aLib = isLibraryRepo(a) ? -1 : 0;
    const bLib = isLibraryRepo(b) ? -1 : 0;
    return aLib - bLib;
  });

  return depRepos;
}

function extractFileHints(stackTrace: string, message: string): string[] {
  const hints = new Set<string>();
  const fullText = `${message}\n${stackTrace}`;

  const frameRegex = /at\s+([\w.]+)\.([\w]+)\(([\w]+\.java):\d+\)/g;
  let match;
  while ((match = frameRegex.exec(fullText)) !== null) {
    const packagePath = match[1]!.replace(/\./g, "/");
    const fileName = match[3]!;
    hints.add(`src/main/java/${packagePath}/${fileName}`);
  }

  const classMatch = fullText.match(
    /\b(ca\.bc\.gov[\w.]+(?:Impl|Service|Controller|Handler|Filter))\b/
  );
  if (classMatch) {
    const path = classMatch[1]!.replace(/\./g, "/") + ".java";
    hints.add(`src/main/java/${path}`);
  }

  return Array.from(hints);
}

function extractRelevantCode(source: string, errorMessage: string): string {
  const MAX_CHARS = 6000;
  const lines = source.split("\n");

  if (source.length <= MAX_CHARS) return source;

  const msgWords = errorMessage
    .replace(/[^a-zA-Z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);

  const relevantRanges: Array<[number, number]> = [];
  const CONTEXT = 20;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (msgWords.some((kw) => line.toLowerCase().includes(kw.toLowerCase()))) {
      const start = Math.max(0, i - CONTEXT);
      const end = Math.min(lines.length - 1, i + CONTEXT);
      relevantRanges.push([start, end]);
    }
  }

  if (relevantRanges.length === 0) {
    const head = lines.slice(0, 50).join("\n");
    const tail = lines.slice(-30).join("\n");
    return `${head}\n\n// ... (${lines.length - 80} lines omitted) ...\n\n${tail}`;
  }

  relevantRanges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [relevantRanges[0]!];
  for (let i = 1; i < relevantRanges.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = relevantRanges[i]!;
    if (curr[0] <= prev[1] + 5) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }

  const parts: string[] = [];
  parts.push(lines.slice(0, 15).join("\n"));

  let lastEnd = 15;
  for (const [start, end] of merged) {
    if (start > lastEnd) {
      parts.push(`\n// ... (lines ${lastEnd + 1}-${start - 1} omitted) ...\n`);
    }
    parts.push(lines.slice(Math.max(start, lastEnd), end + 1).join("\n"));
    lastEnd = end + 1;
  }

  const result = parts.join("\n");
  return result.length <= MAX_CHARS
    ? result
    : result.slice(0, MAX_CHARS) + "\n// ... (truncated)";
}

function parseAiPlanResponse(output: string): {
  analysis: Record<string, unknown> | null;
  patch: string | null;
} {
  const jsonMatch = output.match(/^(\{.*\})\s*$/m);
  let analysis: Record<string, unknown> | null = null;
  if (jsonMatch) {
    try {
      analysis = JSON.parse(jsonMatch[1]!) as Record<string, unknown>;
    } catch {
      const fallback = output.match(/\{[^{}]*"affectedFiles"[^{}]*\}/);
      if (fallback) {
        try { analysis = JSON.parse(fallback[0]) as Record<string, unknown>; } catch { /* skip */ }
      }
    }
  }

  const diffMatch = output.match(/((?:diff --git|--- a\/).+)/s);
  const patch = diffMatch ? diffMatch[1]!.trim() : null;

  return { analysis, patch };
}

async function findFilesInRepo(
  client: BitbucketClient,
  project: string,
  repo: string,
  targetNames: Set<string>,
  maxDepth: number = 10
): Promise<string[]> {
  const found: string[] = [];

  const roots = ["src/main/java", "src", ""];
  for (const root of roots) {
    try {
      await walkDir(client, project, repo, root, targetNames, found, 0, maxDepth);
      if (found.length > 0) return found;
    } catch { /* skip */ }
  }

  // Multi-module: check top-level dirs for module src roots
  if (found.length === 0) {
    try {
      const browse: BitbucketBrowseResponse = await client.browseFiles(project, repo, "");
      if (browse.children?.values) {
        for (const child of browse.children.values) {
          if (child.type === "DIRECTORY") {
            const modRoot = `${child.path.toString}/src/main/java`;
            try {
              await walkDir(client, project, repo, modRoot, targetNames, found, 0, maxDepth);
              if (found.length > 0) return found;
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  return found;
}

async function walkDir(
  client: BitbucketClient,
  project: string,
  repo: string,
  path: string,
  targets: Set<string>,
  found: string[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth || found.length >= 3) return;

  const browse: BitbucketBrowseResponse = await client.browseFiles(project, repo, path);
  if (!browse.children?.values) return;

  for (const child of browse.children.values) {
    const childPath = path ? `${path}/${child.path.toString}` : child.path.toString;

    if (child.type === "FILE" && targets.has(child.path.toString)) {
      found.push(childPath);
      console.log(`[PLAN] Found: ${project}/${repo}/${childPath}`);
    } else if (child.type === "DIRECTORY" && found.length < 3) {
      await walkDir(client, project, repo, childPath, targets, found, depth + 1, maxDepth);
    }
  }
}
