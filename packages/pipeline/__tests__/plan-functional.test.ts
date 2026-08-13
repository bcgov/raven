import { describe, it, expect } from "vitest";
import {
  rankCandidateFiles,
  patchIncludesTests,
  FunctionalPlanError,
} from "../src/steps/plan-functional.js";

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

describe("FunctionalPlanError", () => {
  it("carries a category", () => {
    const e = new FunctionalPlanError("needs-input", "what should the limit be?");
    expect(e.category).toBe("needs-input");
    expect(e).toBeInstanceOf(Error);
  });
});
