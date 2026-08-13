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
