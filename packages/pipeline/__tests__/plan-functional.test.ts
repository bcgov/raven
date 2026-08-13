import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  rankCandidateFiles,
  patchIncludesTests,
  FunctionalPlanError,
  understandTicket,
  gitGrepFiles,
  locateSourceFiles,
  planFunctional,
  capFileContext,
} from "../src/steps/plan-functional.js";
import type { PipelineContext } from "../src/types.js";

const TERMS = [
  { term: "Representative", kind: "label" as const, weight: 3 },
  { term: "AgreementParty", kind: "entity" as const, weight: 2 },
];

describe("rankCandidateFiles", () => {
  it("ranks by summed term weight, filename match, and src/main boost", () => {
    const hits = new Map<string, Set<string>>([
      ["src/main/java/ca/bc/gov/nrs/arts/AgreementPartyBean.java", new Set(["Representative", "AgreementParty"])],
      ["src/main/webapp/agreementParties.xhtml", new Set(["Representative"])],
      ["docs/notes.txt", new Set(["Representative", "AgreementParty"])],
    ]);
    const ranked = rankCandidateFiles(hits, TERMS);
    expect(ranked[0]).toBe("src/main/java/ca/bc/gov/nrs/arts/AgreementPartyBean.java");
    expect(ranked).not.toContain("docs/notes.txt"); // not a source extension
  });

  it("caps results at 5", () => {
    const hits = new Map<string, Set<string>>();
    for (let i = 0; i < 8; i++) hits.set(`src/main/java/F${i}.java`, new Set(["Representative"]));
    expect(rankCandidateFiles(hits, TERMS)).toHaveLength(5);
  });

  it("returns empty for no hits", () => {
    expect(rankCandidateFiles(new Map(), TERMS)).toEqual([]);
  });

  it("down-ranks a test file with more term hits so it still ranks after a main file", () => {
    // Score without penalty: main = 3 (Alpha weight) + 1 (src/main boost) = 4.
    //                         test = 3 + 2 (Alpha + Beta weight) = 5, penalty -2 = 3.
    // So the test file has MORE term hits (2 vs 1) and a higher pre-penalty
    // score (5 vs 4), but the penalty flips the final order (3 < 4).
    const terms = [
      { term: "Alpha", kind: "label" as const, weight: 3 },
      { term: "Beta", kind: "entity" as const, weight: 2 },
    ];
    const hits = new Map<string, Set<string>>([
      ["src/main/java/ca/bc/gov/nrs/arts/Handler.java", new Set(["Alpha"])],
      ["src/test/java/ca/bc/gov/nrs/arts/BigIntegrationTest.java", new Set(["Alpha", "Beta"])],
    ]);
    const ranked = rankCandidateFiles(hits, terms);
    expect(ranked).toEqual([
      "src/main/java/ca/bc/gov/nrs/arts/Handler.java",
      "src/test/java/ca/bc/gov/nrs/arts/BigIntegrationTest.java",
    ]);
  });

  it("allows at most one test file among the candidates", () => {
    const hits = new Map<string, Set<string>>([
      ["src/main/java/Foo.java", new Set(["Representative"])],
      ["src/main/java/Bar.java", new Set(["AgreementParty"])],
      ["src/test/java/Foo1Test.java", new Set(["Representative"])],
      ["src/test/java/Foo2Test.java", new Set(["Representative", "AgreementParty"])],
      ["src/test/java/Foo3Test.java", new Set(["AgreementParty"])],
    ]);
    const ranked = rankCandidateFiles(hits, TERMS);
    const testFiles = ranked.filter((f) => /(^|\/)tests?\//i.test(f) || /Test\.java$/.test(f));
    expect(testFiles).toHaveLength(1);
  });
});

describe("patchIncludesTests", () => {
  const body = "@@ -1,1 +1,1 @@\n-a\n+b";
  it("accepts a patch touching a Java test file", () => {
    const patch = `--- a/src/main/java/Foo.java\n+++ b/src/main/java/Foo.java\n${body}\n--- /dev/null\n+++ b/src/test/java/FooTest.java\n${body}`;
    expect(patchIncludesTests(patch)).toBe(true);
  });
  it("accepts *.test.* and *.spec.* files", () => {
    const patch = `--- /dev/null\n+++ b/src/lib/foo.test.ts\n${body}`;
    expect(patchIncludesTests(patch)).toBe(true);
  });
  it("rejects a patch with no test files", () => {
    const patch = `--- a/src/main/java/Foo.java\n+++ b/src/main/java/Foo.java\n${body}`;
    expect(patchIncludesTests(patch)).toBe(false);
  });
});

describe("capFileContext", () => {
  it("passes content under the cap through unchanged", () => {
    const content = "x".repeat(100);
    expect(capFileContext(content, 12_000)).toBe(content);
  });

  it("slices content over the cap to exactly maxChars plus the truncation marker", () => {
    const content = "y".repeat(20_000);
    const result = capFileContext(content, 12_000);
    expect(result).toBe("y".repeat(12_000) + "\n// ... (truncated)");
  });

  it("defaults the cap to 12,000 chars", () => {
    const content = "z".repeat(15_000);
    const result = capFileContext(content);
    expect(result).toBe("z".repeat(12_000) + "\n// ... (truncated)");
  });
});

describe("FunctionalPlanError", () => {
  it("carries a category", () => {
    const e = new FunctionalPlanError("needs-input", "what should the limit be?");
    expect(e.category).toBe("needs-input");
    expect(e).toBeInstanceOf(Error);
  });
});

const GOOD_UNDERSTANDING = JSON.stringify({
  searchTerms: [{ term: "Representative", kind: "label", weight: 3 }],
  buggyBehavior: "field truncates at 40 chars",
  expectedBehavior: "field allows 200 chars",
  confidence: "high",
  missingInfo: [],
});

describe("understandTicket", () => {
  it("parses a confident analysis into a TicketUnderstanding", async () => {
    const ai = vi.fn().mockResolvedValue(GOOD_UNDERSTANDING);
    const u = await understandTicket("ARTS-220 text", ai as never);
    expect(u.searchTerms[0]?.term).toBe("Representative");
    expect(u.confidence).toBe("high");
  });

  it("fails with needs-input when missingInfo is non-empty", async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({
      searchTerms: [], buggyBehavior: "", expectedBehavior: "",
      confidence: "high", missingInfo: ["what should the new limit be?"],
    }));
    await expect(understandTicket("t", ai as never)).rejects.toMatchObject({ category: "needs-input" });
  });

  it("fails with vague on low confidence", async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({
      searchTerms: [{ term: "x", kind: "label", weight: 1 }],
      buggyBehavior: "?", expectedBehavior: "?", confidence: "low", missingInfo: [],
    }));
    await expect(understandTicket("t", ai as never)).rejects.toMatchObject({ category: "vague" });
  });

  it("fails with vague when the response is not parseable JSON", async () => {
    const ai = vi.fn().mockResolvedValue("I think this ticket is about a field");
    await expect(understandTicket("t", ai as never)).rejects.toMatchObject({ category: "vague" });
  });

  it("fails with vague when no search terms are produced", async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({
      searchTerms: [], buggyBehavior: "b", expectedBehavior: "e", confidence: "high", missingInfo: [],
    }));
    await expect(understandTicket("t", ai as never)).rejects.toMatchObject({ category: "vague" });
  });
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "raven-fnrepo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "src/main/java"), { recursive: true });
  writeFileSync(join(dir, "src/main/java/AgreementPartyBean.java"),
    'public class AgreementPartyBean { String representative; /* max 40 */ }');
  writeFileSync(join(dir, "README.md"), "representative notes");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

describe("gitGrepFiles / locateSourceFiles", () => {
  it("finds files containing terms, case-insensitively", () => {
    const dir = makeRepo();
    try {
      const hits = gitGrepFiles(dir, [{ term: "Representative", kind: "label", weight: 3 }]);
      expect([...hits.keys()]).toContain("src/main/java/AgreementPartyBean.java");
      expect(hits.get("src/main/java/AgreementPartyBean.java")).toContain("Representative");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locateSourceFiles reads ranked source files and skips non-source hits", () => {
    const dir = makeRepo();
    try {
      const files = locateSourceFiles(dir, [{ term: "Representative", kind: "label", weight: 3 }]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe("src/main/java/AgreementPartyBean.java");
      expect(files[0]?.content).toContain("max 40");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws no-source when nothing matches", () => {
    const dir = makeRepo();
    try {
      expect(() => locateSourceFiles(dir, [{ term: "Zebra", kind: "entity", weight: 3 }]))
        .toThrowError(expect.objectContaining({ category: "no-source" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PLAN_JSON = '{"affectedFiles":["src/main/java/AgreementPartyBean.java"],"rootCause":"limit 40","proposedFix":"raise to 200 with test","patch":""}';
const GOOD_PATCH =
  "--- a/src/main/java/AgreementPartyBean.java\n+++ b/src/main/java/AgreementPartyBean.java\n@@ -1,1 +1,1 @@\n-a\n+b\n" +
  "--- /dev/null\n+++ b/src/test/java/AgreementPartyBeanTest.java\n@@ -0,0 +1,1 @@\n+t";

function makeCtx(): PipelineContext {
  return {
    server: "", app: "ARTS", component: "arts-arts-api", dryRun: true,
    jiraProject: "ARTS", errors: [], ticketKey: "ARTS-220",
    ticketText: "Expand character limit for Representative field",
    isDuplicate: false,
  } as unknown as PipelineContext;
}

function makeDeps(planResponse: string) {
  return {
    // First AI call = understand, second = plan.
    ai: vi.fn()
      .mockResolvedValueOnce(GOOD_UNDERSTANDING)
      .mockResolvedValueOnce(planResponse),
    ensureClone: vi.fn().mockReturnValue("/tmp/fake-repo"),
    locate: vi.fn().mockReturnValue([
      { path: "src/main/java/AgreementPartyBean.java", content: "class AgreementPartyBean { /* max 40 */ }" },
    ]),
  };
}

describe("planFunctional", () => {
  it("produces a fix plan with a tests-included patch", async () => {
    const ctx = makeCtx();
    await planFunctional(ctx, {} as never, makeDeps(`${PLAN_JSON}\n\n${GOOD_PATCH}`) as never);
    expect(ctx.fixPlan?.patch).toContain("AgreementPartyBeanTest.java");
    expect(ctx.fixPlan?.proposedFix).toContain("raise to 200");
  });

  it("fails as declined on NO_PATCH responses", async () => {
    const ctx = makeCtx();
    const deps = makeDeps("NO_PATCH: the limit is a business decision");
    await expect(planFunctional(ctx, {} as never, deps as never))
      .rejects.toMatchObject({ category: "declined" });
  });

  it("discards a patch that has no tests", async () => {
    const ctx = makeCtx();
    const noTests = "--- a/src/main/java/AgreementPartyBean.java\n+++ b/src/main/java/AgreementPartyBean.java\n@@ -1,1 +1,1 @@\n-a\n+b";
    await expect(planFunctional(ctx, {} as never, makeDeps(`${PLAN_JSON}\n\n${noTests}`) as never))
      .rejects.toMatchObject({ category: "no-tests" });
  });

  it("discards a patch touching files that were never read", async () => {
    const ctx = makeCtx();
    const fabricated = "--- a/src/main/java/Invented.java\n+++ b/src/main/java/Invented.java\n@@ -1,1 +1,1 @@\n-a\n+b\n--- /dev/null\n+++ b/src/test/java/InventedTest.java\n@@ -0,0 +1,1 @@\n+t";
    await expect(planFunctional(ctx, {} as never, makeDeps(`${PLAN_JSON}\n\n${fabricated}`) as never))
      .rejects.toMatchObject({ category: "declined" });
  });

  it("retries once on a Stage-3 AI timeout and succeeds if the retry works", async () => {
    const ctx = makeCtx();
    const ai = vi.fn()
      .mockResolvedValueOnce(GOOD_UNDERSTANDING) // Stage 1: understand
      .mockRejectedValueOnce(new Error("AI response timed out after 120s")) // Stage 3: first attempt
      .mockResolvedValueOnce(`${PLAN_JSON}\n\n${GOOD_PATCH}`); // Stage 3: retry
    const deps = {
      ai,
      ensureClone: vi.fn().mockReturnValue("/tmp/fake-repo"),
      locate: vi.fn().mockReturnValue([
        { path: "src/main/java/AgreementPartyBean.java", content: "class AgreementPartyBean { /* max 40 */ }" },
      ]),
    };
    await planFunctional(ctx, {} as never, deps as never);
    expect(ctx.fixPlan?.patch).toContain("AgreementPartyBeanTest.java");
    expect(ai).toHaveBeenCalledTimes(3);
  });

  it("propagates a non-timeout Stage-3 error without retrying", async () => {
    const ctx = makeCtx();
    const ai = vi.fn()
      .mockResolvedValueOnce(GOOD_UNDERSTANDING) // Stage 1: understand
      .mockRejectedValueOnce(new Error("500 Internal Server Error")); // Stage 3: fails, not a timeout
    const deps = {
      ai,
      ensureClone: vi.fn().mockReturnValue("/tmp/fake-repo"),
      locate: vi.fn().mockReturnValue([
        { path: "src/main/java/AgreementPartyBean.java", content: "class AgreementPartyBean { /* max 40 */ }" },
      ]),
    };
    await expect(planFunctional(ctx, {} as never, deps as never))
      .rejects.toThrow("500 Internal Server Error");
    expect(ai).toHaveBeenCalledTimes(2);
  });
});
