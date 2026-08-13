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
/** Score penalty applied to test files so they don't crowd out main-code candidates. */
const TEST_FILE_PENALTY = 2;

export function rankCandidateFiles(
  fileHits: Map<string, Set<string>>,
  terms: SearchTerm[],
): string[] {
  const weightOf = new Map(terms.map((t) => [t.term.toLowerCase(), t.weight]));
  const scored: Array<{ file: string; score: number; isTest: boolean }> = [];
  for (const [file, matched] of fileHits) {
    if (!SOURCE_EXTENSIONS.test(file)) continue;
    let score = 0;
    const baseName = file.split("/").pop()!.toLowerCase();
    for (const term of matched) {
      score += weightOf.get(term.toLowerCase()) ?? 1;
      if (baseName.includes(term.toLowerCase())) score += 2;
    }
    if (file.includes("src/main")) score += 1;
    const isTest = TEST_PATH.test(file) || TEST_FILE.test(file);
    if (isTest) score -= TEST_FILE_PENALTY;
    scored.push({ file, score, isTest });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  // At most one test file may occupy a candidate slot — large integration-test
  // files otherwise crowd out the main-code files the fix actually belongs in.
  const result: string[] = [];
  let testFileTaken = false;
  for (const s of scored) {
    if (result.length >= MAX_CANDIDATE_FILES) break;
    if (s.isTest) {
      if (testFileTaken) continue;
      testFileTaken = true;
    }
    result.push(s.file);
  }
  return result;
}

const TEST_PATH = /(^|\/)(test|tests)\//i;
const TEST_FILE = /(Test\.java|\.test\.[jt]sx?|\.spec\.[jt]sx?)$/;

export function patchIncludesTests(patch: string): boolean {
  const files = [...patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)].map((m) => m[1]!.trim());
  return files.some((f) => TEST_PATH.test(f) || TEST_FILE.test(f));
}

/**
 * Files a patch touches (`+++ b/<path>`) that are neither a source file
 * shown to the AI nor a test file. The prompt asks for TEST files only when
 * adding new files; this enforces that contract in code so a response can't
 * smuggle an arbitrary new file (e.g., a CI workflow) into the PR.
 */
export function nonTestNewFiles(
  patch: string,
  sourceFiles: Array<{ path: string }>,
): string[] {
  const targets = [...patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)].map((m) => m[1]!.trim());
  return targets.filter((t) => {
    const isKnownSource = sourceFiles.some((sf) => t.endsWith(sf.path) || sf.path.endsWith(t));
    const isTest = TEST_PATH.test(t) || TEST_FILE.test(t);
    return !isKnownSource && !isTest;
  });
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

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_SEARCH_TERM_KINDS = new Set(["label", "entity", "identifier"]);

export async function understandTicket(
  ticketText: string,
  ai: typeof askAI = askAI,
): Promise<TicketUnderstanding> {
  const response = await ai(`Jira ticket:\n\n${ticketText}`, UNDERSTAND_SYSTEM_PROMPT);
  let raw: Record<string, unknown>;
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    raw = JSON.parse(jsonMatch?.[0] ?? "") as Record<string, unknown>;
  } catch {
    throw new FunctionalPlanError("vague", "ticket analysis was not parseable — ticket too vague to plan safely");
  }

  // missingInfo: the prompt asks for a string array, but a model can return
  // a bare string. Treat a non-empty string as a single-item list (the
  // needs-input gate below still fires); anything else non-array collapses
  // to [] rather than silently bypassing the gate.
  let missingInfo: string[];
  if (Array.isArray(raw["missingInfo"])) {
    missingInfo = (raw["missingInfo"] as unknown[]).filter((v): v is string => typeof v === "string");
  } else if (typeof raw["missingInfo"] === "string" && raw["missingInfo"].length > 0) {
    missingInfo = [raw["missingInfo"]];
  } else {
    missingInfo = [];
  }
  if (missingInfo.length > 0) {
    throw new FunctionalPlanError("needs-input", `needs business input — ${missingInfo.join("; ")}`);
  }

  const confidence = raw["confidence"];
  if (typeof confidence !== "string" || !VALID_CONFIDENCE.has(confidence)) {
    throw new FunctionalPlanError("vague", "ticket analysis returned an unrecognized confidence value");
  }
  if (confidence === "low") {
    throw new FunctionalPlanError("vague", "ticket too vague to plan safely (low confidence)");
  }

  // searchTerms: drop anything that isn't a non-blank string term (a blank
  // or whitespace-only term would reach git grep as `-F -e ""`, which
  // matches every file); normalize weight/kind so downstream ranking never
  // sees malformed values.
  const rawTerms = Array.isArray(raw["searchTerms"]) ? (raw["searchTerms"] as unknown[]) : [];
  const searchTerms: SearchTerm[] = [];
  for (const rt of rawTerms) {
    if (typeof rt !== "object" || rt === null) continue;
    const r = rt as Record<string, unknown>;
    const term = r["term"];
    if (typeof term !== "string" || term.trim().length < 2) continue;
    const weight = typeof r["weight"] === "number" && r["weight"] >= 1 && r["weight"] <= 3
      ? (r["weight"] as number)
      : 1;
    const kind = typeof r["kind"] === "string" && VALID_SEARCH_TERM_KINDS.has(r["kind"])
      ? (r["kind"] as SearchTerm["kind"])
      : "label";
    searchTerms.push({ term: term.trim(), kind, weight });
  }
  if (searchTerms.length === 0) {
    throw new FunctionalPlanError("vague", "no usable search terms could be extracted from the ticket");
  }

  return {
    searchTerms,
    buggyBehavior: typeof raw["buggyBehavior"] === "string" ? raw["buggyBehavior"] : "",
    expectedBehavior: typeof raw["expectedBehavior"] === "string" ? raw["expectedBehavior"] : "",
    confidence: confidence as "high" | "medium" | "low",
    missingInfo,
  };
}

/** git grep -i -l per term; returns path → matched terms. Missing/binary-only matches are fine (empty map). */
export function gitGrepFiles(repoDir: string, terms: SearchTerm[]): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const t of terms) {
    let out = "";
    try {
      // -I skips binary files; -F treats the term as a literal fixed string
      // (terms are plain labels/identifiers, not regexes); git grep exits 1
      // on zero matches — not an error.
      out = execFileSync("git", ["grep", "-i", "-l", "-I", "-F", "-e", t.term], {
        cwd: repoDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
      });
    } catch (e) {
      // Exit status 1 means "zero matches" — normal, not an error. Any
      // other failure (missing repo, timeout, ENOENT) is an operational
      // problem and must not be silently treated as "no source found".
      const status = (e as { status?: number | null }).status;
      if (status === 1) continue;
      throw new Error(`git grep failed for term "${t.term}": ${(e as Error).message}`);
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

/**
 * Cap a single file's contribution to the Stage-3 prompt. `extractRelevantCode`
 * still allows up to 50K chars per file — across 5 candidates that produced
 * ~200K-char prompts that reliably timed out the AI call. Append a truncation
 * marker when capped so it's visible in logs and to the model.
 */
export function capFileContext(content: string, maxChars = 12_000): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n// ... (truncated)`;
}

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
    .map((sf) => `--- repo: ${sf.repo} path: ${sf.path} ---\n${capFileContext(extractRelevantCode(sf.content, keywordContext, 12_000))}`)
    .join("\n\n");
  console.log(`[PLAN] Source context: ${sourceContext.length} chars across ${sourceFiles.length} file(s)`);
  const prompt =
    `Jira ticket: ${ctx.ticketKey}\n` +
    `Component: ${ctx.component}\n` +
    `Buggy behavior: ${understanding.buggyBehavior}\n` +
    `Expected behavior: ${understanding.expectedBehavior}\n\n` +
    `Relevant source files:\n${sourceContext}`;

  startSpinner("AI generating functional fix plan...");
  let aiResponse: string;
  try {
    try {
      aiResponse = await ai(prompt, FUNCTIONAL_PLAN_SYSTEM_PROMPT);
    } catch (err) {
      if (err instanceof Error && /timed out/i.test(err.message)) {
        console.log("[PLAN] AI timed out — retrying once");
        aiResponse = await ai(prompt, FUNCTIONAL_PLAN_SYSTEM_PROMPT);
      } else {
        throw err;
      }
    }
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
  const offendingNewFiles = nonTestNewFiles(fixedPatch, sourceFiles);
  if (offendingNewFiles.length > 0) {
    throw new FunctionalPlanError(
      "declined",
      `patch adds non-test file not shown to the AI: ${offendingNewFiles.join(", ")}`,
    );
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
