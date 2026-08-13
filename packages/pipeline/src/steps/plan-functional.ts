import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BitbucketClient } from "@nrs/bitbucket-mcp/client";
import type { PipelineContext } from "../types.js";
import { askAI } from "../ai-client.js";
import { ensureRepoClone } from "../repo-clone.js";
import { parseAiPlanResponse, fixPatchPaths, validatePatchTargets, extractRelevantCode } from "./plan.js";
import { startSpinner, stopSpinner } from "../spinner.js";

export type FunctionalFailureCategory = "needs-input" | "vague" | "no-source" | "declined" | "no-tests";

/** A categorized, human-actionable planning failure for one ticket. */
export class FunctionalPlanError extends Error {
  constructor(
    public readonly category: FunctionalFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "FunctionalPlanError";
  }
}

export interface SearchTerm {
  term: string;
  kind: "label" | "entity" | "identifier";
  weight: number;
}

const SOURCE_EXTENSIONS = /\.(java|xhtml|jsp|jsx?|tsx?|properties|xml)$/i;
const MAX_CANDIDATE_FILES = 5;

export function rankCandidateFiles(
  fileHits: Map<string, Set<string>>,
  terms: SearchTerm[],
): string[] {
  const weightOf = new Map(terms.map((t) => [t.term.toLowerCase(), t.weight]));
  const scored: Array<{ file: string; score: number }> = [];
  for (const [file, matched] of fileHits) {
    if (!SOURCE_EXTENSIONS.test(file)) continue;
    let score = 0;
    const baseName = file.split("/").pop()!.toLowerCase();
    for (const term of matched) {
      score += weightOf.get(term.toLowerCase()) ?? 1;
      if (baseName.includes(term.toLowerCase())) score += 2;
    }
    if (file.includes("src/main")) score += 1;
    scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, MAX_CANDIDATE_FILES).map((s) => s.file);
}

const TEST_PATH = /(^|\/)(test|tests)\//i;
const TEST_FILE = /(Test\.java|\.test\.[jt]sx?|\.spec\.[jt]sx?)$/;

export function patchIncludesTests(patch: string): boolean {
  const files = [...patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)].map((m) => m[1]!.trim());
  return files.some((f) => TEST_PATH.test(f) || TEST_FILE.test(f));
}

const UNDERSTAND_SYSTEM_PROMPT = `You are analyzing a Jira bug ticket that has NO error stack trace, to prepare a code search.
Respond with ONLY a single-line JSON object:
{"searchTerms":[{"term":"...","kind":"label|entity|identifier","weight":1-3}],"buggyBehavior":"...","expectedBehavior":"...","confidence":"high|medium|low","missingInfo":["..."]}

Rules:
- searchTerms are strings likely to appear in the code: UI labels, field names, entity nouns, screen names, identifiers. Weight 3 = most distinctive.
- missingInfo lists ONLY gaps that BLOCK a safe fix (unknown business values, undecided requirements). Details inferable from code do NOT belong here.
- confidence reflects whether the ticket describes concrete wrong behavior with enough detail to fix.`;

export interface TicketUnderstanding {
  searchTerms: SearchTerm[];
  buggyBehavior: string;
  expectedBehavior: string;
  confidence: "high" | "medium" | "low";
  missingInfo: string[];
}

export async function understandTicket(
  ticketText: string,
  ai: typeof askAI = askAI,
): Promise<TicketUnderstanding> {
  const response = await ai(`Jira ticket:\n\n${ticketText}`, UNDERSTAND_SYSTEM_PROMPT);
  let parsed: TicketUnderstanding;
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] ?? "") as TicketUnderstanding;
  } catch {
    throw new FunctionalPlanError("vague", "ticket analysis was not parseable — ticket too vague to plan safely");
  }
  if (Array.isArray(parsed.missingInfo) && parsed.missingInfo.length > 0) {
    throw new FunctionalPlanError("needs-input", `needs business input — ${parsed.missingInfo.join("; ")}`);
  }
  if (parsed.confidence === "low") {
    throw new FunctionalPlanError("vague", "ticket too vague to plan safely (low confidence)");
  }
  if (!Array.isArray(parsed.searchTerms) || parsed.searchTerms.length === 0) {
    throw new FunctionalPlanError("vague", "no usable search terms could be extracted from the ticket");
  }
  return parsed;
}

/** git grep -i -l per term; returns path → matched terms. Missing/binary-only matches are fine (empty map). */
export function gitGrepFiles(repoDir: string, terms: SearchTerm[]): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const t of terms) {
    let out = "";
    try {
      // -I skips binary files; git grep exits 1 on zero matches — not an error.
      out = execFileSync("git", ["grep", "-i", "-l", "-I", "-e", t.term], {
        cwd: repoDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      continue;
    }
    for (const file of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (!hits.has(file)) hits.set(file, new Set());
      hits.get(file)!.add(t.term);
    }
  }
  return hits;
}

export interface LocatedFile { path: string; content: string; }

/** Rank hits, read top files from disk. Throws FunctionalPlanError("no-source") when nothing matches. */
export function locateSourceFiles(
  repoDir: string,
  terms: SearchTerm[],
  search: typeof gitGrepFiles = gitGrepFiles,
): LocatedFile[] {
  const ranked = rankCandidateFiles(search(repoDir, terms), terms);
  const files: LocatedFile[] = [];
  for (const path of ranked) {
    try {
      files.push({ path, content: readFileSync(join(repoDir, path), "utf-8") });
    } catch { /* file listed but unreadable — skip */ }
  }
  if (files.length === 0) {
    throw new FunctionalPlanError(
      "no-source",
      `no matching source found for [${terms.map((t) => t.term).join(", ")}]`,
    );
  }
  return files;
}

const FUNCTIONAL_PLAN_SYSTEM_PROMPT = `You are a senior Java developer fixing a FUNCTIONAL bug (wrong behavior, no exception).
Given the buggy behavior, the expected behavior, and the relevant source files, respond in TWO sections:

SECTION 1 — JSON analysis (single line):
{"affectedFiles":["full/path/from/repo/root/File.java"],"rootCause":"explanation","proposedFix":"description","patch":""}

SECTION 2 — Unified diff patch (after a blank line), applyable with git apply.
File paths MUST match the paths shown in the source file headers.

HARD REQUIREMENTS:
- The patch MUST add or update at least one test that demonstrates the expected behavior.
- Only modify files shown to you. New TEST files may be added.
- If the fix requires a business decision, or the code cannot support the described behavior, respond with exactly: NO_PATCH: <one-line reason>`;

export interface FunctionalPlanDeps {
  ai?: typeof askAI;
  ensureClone?: typeof ensureRepoClone;
  locate?: typeof locateSourceFiles;
}

/** Populates ctx.fixPlan or throws FunctionalPlanError. */
export async function planFunctional(
  ctx: PipelineContext,
  bitbucketClient: BitbucketClient,
  deps: FunctionalPlanDeps = {},
): Promise<void> {
  const ai = deps.ai ?? askAI;
  const ensureClone = deps.ensureClone ?? ensureRepoClone;
  const locate = deps.locate ?? locateSourceFiles;

  const project = ctx.bitbucketProject ?? ctx.app;
  const repo = ctx.bitbucketRepo ?? ctx.component;

  // Stage 1: UNDERSTAND (throws needs-input / vague)
  startSpinner("AI analyzing ticket...");
  let understanding: TicketUnderstanding;
  try {
    understanding = await understandTicket(ctx.ticketText!, ai);
  } finally {
    stopSpinner();
  }
  console.log(`[PLAN] Search terms: ${understanding.searchTerms.map((t) => t.term).join(", ")}`);

  // Stage 2: LOCATE (throws no-source). Functional path is app-repo-only,
  // so ctx.branch applies directly. Dry runs clone too — local disk only.
  startSpinner(`Preparing clone of ${project}/${repo}...`);
  let repoDir: string;
  try {
    repoDir = ensureClone(bitbucketClient, project, repo, ctx.branch);
  } finally {
    stopSpinner();
  }
  const located = locate(repoDir, understanding.searchTerms);
  for (const f of located) console.log(`[PLAN] Located: ${f.path}`);

  // Stage 3: PLAN (throws declined / no-tests)
  const keywordContext = understanding.searchTerms.map((t) => t.term).join(" ");
  const sourceFiles = located.map((f) => ({ path: f.path, content: f.content, repo, project }));
  const sourceContext = sourceFiles
    .map((sf) => `--- repo: ${sf.repo} path: ${sf.path} ---\n${extractRelevantCode(sf.content, keywordContext)}`)
    .join("\n\n");
  const prompt =
    `Jira ticket: ${ctx.ticketKey}\n` +
    `Component: ${ctx.component}\n` +
    `Buggy behavior: ${understanding.buggyBehavior}\n` +
    `Expected behavior: ${understanding.expectedBehavior}\n\n` +
    `Relevant source files:\n${sourceContext}`;

  startSpinner("AI generating functional fix plan...");
  let aiResponse: string;
  try {
    aiResponse = await ai(prompt, FUNCTIONAL_PLAN_SYSTEM_PROMPT);
  } finally {
    stopSpinner();
  }

  const noPatch = aiResponse.match(/NO_PATCH:\s*(.+)/);
  if (noPatch) {
    throw new FunctionalPlanError("declined", `NO_PATCH — ${noPatch[1]!.trim()}`);
  }

  const { analysis, patch: rawPatch } = parseAiPlanResponse(aiResponse);
  let fixedPatch = rawPatch ? fixPatchPaths(rawPatch, sourceFiles) : "";
  if (!fixedPatch || !validatePatchTargets(fixedPatch, sourceFiles)) {
    throw new FunctionalPlanError("declined", "generated patch modified files that were never read (fabrication guard)");
  }
  if (!patchIncludesTests(fixedPatch)) {
    throw new FunctionalPlanError("no-tests", "plan discarded — no tests in patch");
  }

  ctx.fixPlan = {
    affectedFiles: (analysis?.["affectedFiles"] as string[]) ?? sourceFiles.map((s) => s.path),
    rootCause: (analysis?.["rootCause"] as string) ?? understanding.buggyBehavior,
    proposedFix: (analysis?.["proposedFix"] as string) ?? understanding.expectedBehavior,
    patch: fixedPatch,
  };
  console.log(`\n[PLAN] ── Functional Fix Plan ───────────────────`);
  console.log(`[PLAN] Files affected: ${ctx.fixPlan.affectedFiles.join(", ")}`);
  console.log(`[PLAN] Root cause:\n  ${ctx.fixPlan.rootCause}`);
  console.log(`[PLAN] Proposed fix:\n  ${ctx.fixPlan.proposedFix}`);
  console.log(`[PLAN] Patch (${fixedPatch.length} chars):\n${fixedPatch}`);
  console.log(`[PLAN] ─────────────────────────────────────────────\n`);
}
