import { askAI } from "../ai-client.js";

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
