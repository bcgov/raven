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
