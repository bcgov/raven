# Functional-Bug Planning Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the pipeline plan and fix Jira bugs that have no error stack traces, by locating code with AI-extracted domain keywords over a local clone.

**Architecture:** `plan()` keeps its error-shaped path byte-for-byte; when a ticket yields zero stack-trace signals it delegates to a new `plan-functional.ts` module (understand ticket → git-grep a local clone → plan with mandatory tests). Clone infrastructure is extracted from `implement.ts` into a shared `repo-clone.ts` so PLAN and IMPLEMENT use one implementation.

**Tech Stack:** TypeScript (ESM, strict, `.js` import suffixes), vitest, `execFileSync` git (argv form, never shell), Copilot SDK via existing `askAI` (PI-scrubbed).

**Spec:** `docs/superpowers/specs/2026-08-13-functional-bug-planning-design.md`

## Global Constraints

- Public repo: no internal hostnames anywhere (use `test01`/`prod01` aliases in tests/docs); Jira keys like `ARTS-220` are fine.
- All AI calls go through `askAI(prompt, systemPrompt)` from `../ai-client.js` — never a raw fetch (PI scrubbing lives there).
- All git invocations: `execFileSync("git", [args...], { stdio: "pipe" })` — argv form, no shell.
- Build: `npm run build` (tsc --build, from repo root). Tests: `npx vitest run packages/pipeline/__tests__/` (targeted) and `npm test` (full suite) — full suite must stay green after every task.
- Existing error-shaped PLAN behavior must not change (regression gate: existing `plan.test.ts` tests untouched and passing).
- Commit style: imperative, ≤50-char subject, body explains what/why. Work on branch `feature/pipeline-hardening`.

---

### Task 1: Extract shared clone infra into `repo-clone.ts`

Pure refactor — behavior preserving. `implement.ts` currently owns clone/update logic that `plan-functional` also needs.

**Files:**
- Create: `packages/pipeline/src/repo-clone.ts`
- Create: `packages/pipeline/__tests__/repo-clone.test.ts`
- Modify: `packages/pipeline/src/steps/implement.ts` (delete moved code, import instead)
- Modify: `packages/pipeline/src/steps/create-pr.ts` (delete its private `detectDefaultBranch` copy at ~line 143, import instead)

**Interfaces:**
- Consumes: `BitbucketClient.getCloneUrl(project, repo)` (existing).
- Produces (later tasks rely on these exact exports from `../repo-clone.js` / `../../repo-clone.js`):
  - `CLONE_BASE: string` — `~/.raven/repos`
  - `ensureRepoClone(client: BitbucketClient, project: string, repo: string, branch?: string): string` — clones or updates `CLONE_BASE/<project>/<repo>`, checks out `branch` (or the default branch) and pulls it; returns the repo dir. Throws with credential-scrubbed messages.
  - `detectDefaultBranch(repoDir: string): string`
  - `buildAuthUrl(cloneUrl: string): string`
  - `assertHttpsUrl(url: string, label: string): void`
  - `assertInsideCloneBase(repoDir: string): void`

- [ ] **Step 1: Write failing tests for the pure helpers**

`packages/pipeline/__tests__/repo-clone.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildAuthUrl, assertHttpsUrl } from "../src/repo-clone.js";

describe("buildAuthUrl", () => {
  let savedEmail: string | undefined;
  let savedPassword: string | undefined;
  beforeEach(() => {
    savedEmail = process.env["ATLASSIAN_EMAIL"];
    savedPassword = process.env["ATLASSIAN_PASSWORD"];
    process.env["ATLASSIAN_EMAIL"] = "svc@example.test";
    process.env["ATLASSIAN_PASSWORD"] = "s3cret";
  });
  afterEach(() => {
    if (savedEmail === undefined) delete process.env["ATLASSIAN_EMAIL"];
    else process.env["ATLASSIAN_EMAIL"] = savedEmail;
    if (savedPassword === undefined) delete process.env["ATLASSIAN_PASSWORD"];
    else process.env["ATLASSIAN_PASSWORD"] = savedPassword;
  });

  it("injects credentials into an https clone URL", () => {
    const url = buildAuthUrl("https://scm.example.test/scm/ARTS/arts-arts-api.git");
    expect(url).toContain("@scm.example.test");
    expect(url.startsWith("https://")).toBe(true);
  });
});

describe("assertHttpsUrl", () => {
  it("accepts https and rejects http", () => {
    expect(() => assertHttpsUrl("https://scm.example.test/x.git", "clone")).not.toThrow();
    expect(() => assertHttpsUrl("http://scm.example.test/x.git", "clone")).toThrow();
  });
});
```

Note: copy assertions to match the ACTUAL current behavior of the functions being moved (read them in `implement.ts` first — `buildAuthUrl` at ~line 633, `assertHttpsUrl` at ~line 43). If `buildAuthUrl` URL-encodes the email, assert on the encoded form. The test pins behavior through the move; it must not change behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/pipeline/__tests__/repo-clone.test.ts`
Expected: FAIL — module `../src/repo-clone.js` does not exist.

- [ ] **Step 3: Create `repo-clone.ts` by moving code from `implement.ts`**

Move these VERBATIM from `implement.ts` (delete there): `CLONE_BASE` (line ~9), `assertInsideCloneBase` (~19), `assertHttpsUrl` (~43), `detectDefaultBranch` (~371), `buildAuthUrl` (~633). Export all of them. Then add `ensureRepoClone`, lifted from `implement.ts`'s clone-or-update block (the `if (!existsSync(join(repoDir, ".git")))` block through the base-branch pull — see implement.ts ~lines 78–120):

```ts
/**
 * Clone or update CLONE_BASE/<project>/<repo> and leave the requested
 * branch (or the repo's default branch) checked out and up to date.
 * Returns the repo directory. Credential handling: auth URL used only for
 * the network operation, then scrubbed from the remote; error messages
 * are scrubbed too.
 */
export function ensureRepoClone(
  client: BitbucketClient,
  project: string,
  repo: string,
  branch?: string,
): string {
  const repoDir = join(CLONE_BASE, project, repo);
  const cloneUrl = client.getCloneUrl(project, repo);
  if (!existsSync(join(repoDir, ".git"))) {
    const authUrl = buildAuthUrl(cloneUrl);
    assertHttpsUrl(cloneUrl, "clone");
    assertHttpsUrl(authUrl, "auth");
    mkdirSync(join(CLONE_BASE, project), { recursive: true });
    try {
      execFileSync("git", ["clone", "--", authUrl, repoDir], { stdio: "pipe", timeout: 120_000 });
    } catch (e) {
      const msg = (e as Error).message.replace(/\/\/[^@]+@/g, "//***@");
      throw new Error(`git clone failed for ${project}/${repo}: ${msg}`);
    }
    execFileSync("git", ["remote", "set-url", "origin", cloneUrl], { cwd: repoDir, stdio: "pipe" });
    if (branch) {
      execFileSync("git", ["checkout", branch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    }
  } else {
    const baseBranch = branch ?? detectDefaultBranch(repoDir);
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    execFileSync("git", ["checkout", baseBranch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    execFileSync("git", ["pull", "origin", baseBranch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
  }
  return repoDir;
}
```

Imports needed in `repo-clone.ts`: `execFileSync` from `node:child_process`; `existsSync, mkdirSync` from `node:fs`; `join, resolve` from `node:path`; `homedir` from `node:os`; `type { BitbucketClient }` from `@nrs/bitbucket-mcp/client`. Keep the spinner calls OUT of `ensureRepoClone` (implement.ts wraps its call with its own spinner; plan-functional adds its own).

- [ ] **Step 4: Rewire `implement.ts` and `create-pr.ts`**

In `implement.ts`: import `{ CLONE_BASE, ensureRepoClone, detectDefaultBranch, buildAuthUrl, assertHttpsUrl, assertInsideCloneBase }` from `"../repo-clone.js"`. Replace the clone-or-update block with:

```ts
  console.log(`[IMPLEMENT] Target repo: ${project}/${repo}`);
  startSpinner(`Preparing clone of ${project}/${repo}...`);
  let repoDir: string;
  try {
    repoDir = ensureRepoClone(bitbucketClient, project, repo, sourceBranch);
  } finally {
    stopSpinner();
  }
  if (sourceBranch) console.log(`[IMPLEMENT] Base branch: ${sourceBranch}`);
```

Everything after (bugfix-branch reuse, reset, patch, tests) stays in `implement.ts` unchanged. `create-pr.ts`: delete its private `detectDefaultBranch` and import from `"../repo-clone.js"`. Note `buildAuthUrl`/`assertHttpsUrl` are still used directly by `create-pr.ts` for the push — import those too.

- [ ] **Step 5: Build and run the full suite (behavior-preservation gate)**

Run: `npm run build && npm test`
Expected: build clean; every existing test passes; new repo-clone tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/src/repo-clone.ts packages/pipeline/__tests__/repo-clone.test.ts packages/pipeline/src/steps/implement.ts packages/pipeline/src/steps/create-pr.ts
git commit -m "Extract shared repo clone infra

Move CLONE_BASE, auth URL handling, default-branch detection and the
clone-or-update sequence from implement.ts into repo-clone.ts so the
upcoming functional-bug planning path can reuse one implementation.
Behavior preserving; create-pr.ts drops its duplicate
detectDefaultBranch."
```

---

### Task 2: Thread full ticket text into the pipeline context

Stage 1 needs the whole ticket (summary + description + comments); today `extractFromTicket` condenses it into an `ErrorInfo`.

**Files:**
- Modify: `packages/pipeline/src/steps/extract-from-ticket.ts`
- Modify: `packages/pipeline/src/types.ts`
- Modify: `packages/pipeline/src/orchestrator.ts` (`runJiraBacklog` ctx construction, ~line 405)
- Test: `packages/pipeline/__tests__/extract-from-ticket.test.ts` (create)

**Interfaces:**
- Produces: `extractFromTicket(ticketKey, jiraClient)` now returns `{ errors, triageResult, ticketText }` where `ticketText` is `` `${summary}\n\n${description}\n\n${commentBodies}` ``.
- Produces: `PipelineContext.ticketText?: string` — set only in backlog mode; its presence is the functional-path trigger condition in Task 6.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { extractFromTicket } from "../src/steps/extract-from-ticket.js";

vi.mock("../src/ai-client.js", () => ({
  askAI: vi.fn().mockResolvedValue('{"summary":"s","rootCause":"r","severity":"medium","suggestedTitle":"t"}'),
}));

function mockJira(description: string, comments: string[]) {
  return {
    getIssue: vi.fn().mockResolvedValue({
      key: "ARTS-220",
      fields: { summary: "Expand character limit for Representative field", description, labels: [] },
    }),
    getComments: vi.fn().mockResolvedValue({ comments: comments.map((body) => ({ body })) }),
  };
}

describe("extractFromTicket ticketText", () => {
  it("returns the full summary + description + comments text", async () => {
    const jira = mockJira("The Representative field truncates at 40 chars.", ["Seen again in TEST on the Agreement Parties screen."]);
    const { ticketText } = await extractFromTicket("ARTS-220", jira as never);
    expect(ticketText).toContain("Expand character limit");
    expect(ticketText).toContain("truncates at 40 chars");
    expect(ticketText).toContain("Agreement Parties screen");
  });
});
```

Note: check `buildTriageResult` in `extract-from-ticket.ts` before finalizing the mock — it may read additional issue fields (e.g. `priority`); extend the mock's `fields` object to satisfy it rather than changing production code.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/pipeline/__tests__/extract-from-ticket.test.ts`
Expected: FAIL — `ticketText` undefined.

- [ ] **Step 3: Implement**

In `extract-from-ticket.ts`, the function already builds `fullText` from description + comments. Change the return type and value:

```ts
): Promise<{ errors: ErrorInfo[]; triageResult: TriageResult; ticketText: string }> {
  // ... existing body ...
  const ticketText = `${issue.fields.summary}\n\n${fullText}`;
  return { errors, triageResult, ticketText };
}
```

In `types.ts`, add to `PipelineContext` next to `existingTicket`:

```ts
  /** Full ticket text (summary + description + comments) — set in Jira
   *  backlog mode; its presence enables the functional-bug planning path. */
  ticketText?: string;
```

In `orchestrator.ts` `runJiraBacklog`, destructure and set:

```ts
      const { errors, triageResult, ticketText } = await extractFromTicket(ticket.key, jiraClient);
```

and add `ticketText,` to the `const ctx: PipelineContext = { ... }` literal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/pipeline/__tests__/`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src/steps/extract-from-ticket.ts packages/pipeline/src/types.ts packages/pipeline/src/orchestrator.ts packages/pipeline/__tests__/extract-from-ticket.test.ts
git commit -m "Carry full ticket text into backlog context

The functional-bug planning path needs the whole ticket (summary,
description, comments) to extract domain search terms; the condensed
ErrorInfo loses the comments. ticketText presence also serves as the
functional-path trigger signal."
```

---

### Task 3: Pure helpers — file ranking, test predicate, error class

**Files:**
- Create: `packages/pipeline/src/steps/plan-functional.ts` (helpers + error class only in this task)
- Create: `packages/pipeline/__tests__/plan-functional.test.ts`

**Interfaces (produced, used by Tasks 4–7):**

```ts
export type FunctionalFailureCategory = "needs-input" | "vague" | "no-source" | "declined" | "no-tests";

export class FunctionalPlanError extends Error {
  constructor(public category: FunctionalFailureCategory, message: string);
}

export interface SearchTerm { term: string; kind: "label" | "entity" | "identifier"; weight: number; }

/** files: repo-relative path → set of matched terms. Returns top-5 source paths, best first. */
export function rankCandidateFiles(
  fileHits: Map<string, Set<string>>,
  terms: SearchTerm[],
): string[];

export function patchIncludesTests(patch: string): boolean;
```

- [ ] **Step 1: Write failing tests**

Append to the new `plan-functional.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement in `plan-functional.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src/steps/plan-functional.ts packages/pipeline/__tests__/plan-functional.test.ts
git commit -m "Add functional-plan helpers and error class

File ranking (weighted term hits, filename and src/main boosts, top 5
source files), the mandatory-tests patch predicate, and the categorized
FunctionalPlanError used for honest per-ticket backlog reporting."
```

---

### Task 4: Stage 1 — UNDERSTAND with confidence gate

**Files:**
- Modify: `packages/pipeline/src/steps/plan-functional.ts`
- Modify: `packages/pipeline/__tests__/plan-functional.test.ts`

**Interfaces:**
- Consumes: `askAI(prompt, systemPrompt): Promise<string>` from `../ai-client.js`; `SearchTerm`, `FunctionalPlanError` (Task 3).
- Produces:

```ts
export interface TicketUnderstanding {
  searchTerms: SearchTerm[];
  buggyBehavior: string;
  expectedBehavior: string;
  confidence: "high" | "medium" | "low";
  missingInfo: string[];
}
/** Throws FunctionalPlanError("vague"|"needs-input") per the spec gate. */
export async function understandTicket(
  ticketText: string,
  ai?: typeof askAI,
): Promise<TicketUnderstanding>;
```

- [ ] **Step 1: Write failing tests** (append to `plan-functional.test.ts`; add `vi` to the vitest import)

```ts
import { understandTicket } from "../src/steps/plan-functional.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts`
Expected: new tests FAIL — `understandTicket` not exported.

- [ ] **Step 3: Implement**

```ts
import { askAI } from "../ai-client.js";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src/steps/plan-functional.ts packages/pipeline/__tests__/plan-functional.test.ts
git commit -m "Add ticket understanding stage with gate

Stage 1 of the functional-bug path: one AI call extracts weighted code
search terms plus buggy/expected behavior. Explicit gate: non-empty
missingInfo fails as needs-input, low confidence or unparseable output
fails as vague — no speculative planning for tickets that need business
decisions."
```

---

### Task 5: Stage 2 — LOCATE via git grep over a local clone

**Files:**
- Modify: `packages/pipeline/src/steps/plan-functional.ts`
- Modify: `packages/pipeline/__tests__/plan-functional.test.ts`

**Interfaces:**
- Consumes: `rankCandidateFiles`, `SearchTerm` (Task 3).
- Produces:

```ts
/** git grep -i -l per term; returns path → matched terms. Missing/binary-only matches are fine (empty map). */
export function gitGrepFiles(repoDir: string, terms: SearchTerm[]): Map<string, Set<string>>;

export interface LocatedFile { path: string; content: string; }
/** Rank hits, read top files from disk. Throws FunctionalPlanError("no-source") when nothing matches. */
export function locateSourceFiles(
  repoDir: string,
  terms: SearchTerm[],
  search?: typeof gitGrepFiles,
): LocatedFile[];
```

- [ ] **Step 1: Write failing tests** (real temp git repo — `git` is a hard dependency of the pipeline already)

```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gitGrepFiles, locateSourceFiles } from "../src/steps/plan-functional.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts`
Expected: new tests FAIL — functions not exported.

- [ ] **Step 3: Implement**

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src/steps/plan-functional.ts packages/pipeline/__tests__/plan-functional.test.ts
git commit -m "Add keyword code location over local clone

Stage 2 of the functional-bug path: git grep per weighted term over the
checked-out working tree (honors --branch via the clone), rank, read
the top files. Zero matches is a categorized no-source failure, never a
guess."
```

---

### Task 6: Stage 3 + assembly + `plan()` delegation

**Files:**
- Modify: `packages/pipeline/src/steps/plan-functional.ts` (add `planFunctional`)
- Modify: `packages/pipeline/src/steps/plan.ts` (export shared fns; add delegation hook)
- Modify: `packages/pipeline/__tests__/plan-functional.test.ts`

**Interfaces:**
- Consumes: `understandTicket` (Task 4), `locateSourceFiles` (Task 5), `ensureRepoClone` (Task 1), `patchIncludesTests` (Task 3), and from `plan.ts`: `parseAiPlanResponse`, `fixPatchPaths`, `validatePatchTargets`, `extractRelevantCode` — change these four from private to `export` in `plan.ts` (no body changes).
- Produces:

```ts
export interface FunctionalPlanDeps {
  ai?: typeof askAI;
  ensureClone?: typeof ensureRepoClone;
  locate?: typeof locateSourceFiles;
}
/** Populates ctx.fixPlan or throws FunctionalPlanError. */
export async function planFunctional(
  ctx: PipelineContext,
  bitbucketClient: BitbucketClient,
  deps?: FunctionalPlanDeps,
): Promise<void>;
```

- [ ] **Step 1: Write failing tests**

```ts
import { planFunctional } from "../src/steps/plan-functional.js";
import type { PipelineContext } from "../src/types.js";

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
});
```

Also add a delegation test in `plan.test.ts` — a ctx with `ticketText`, no stack-trace signals, and a mocked module: add at the top of `plan.test.ts`

```ts
vi.mock("../src/steps/plan-functional.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/plan-functional.js")>();
  return { ...orig, planFunctional: vi.fn().mockResolvedValue(undefined) };
});
import { planFunctional } from "../src/steps/plan-functional.js";
```

and the test:

```ts
describe("plan() functional delegation", () => {
  it("delegates to planFunctional when there are no stack-trace signals and ticketText exists", async () => {
    const ctx = {
      app: "NOSUCHAPP4", component: "nosuchapp4-fake-api",
      errors: [{ message: "Field truncates", stackTrace: "no trace here", occurrences: 1, dedupeKey: "k" }],
      ticketKey: "TEST-9", ticketText: "Field truncates at 40 chars", dryRun: false, isDuplicate: false,
    } as unknown as PipelineContext;
    await plan(ctx, { readFile: vi.fn(), listFiles: vi.fn(), listRepos: vi.fn() } as never);
    expect(vi.mocked(planFunctional)).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/pipeline/__tests__/plan-functional.test.ts packages/pipeline/__tests__/plan.test.ts`
Expected: new tests FAIL (`planFunctional` not exported; delegation absent).

- [ ] **Step 3: Implement**

In `plan.ts`: change `function parseAiPlanResponse` → `export function parseAiPlanResponse`, `function fixPatchPaths` → `export function fixPatchPaths`, `function extractRelevantCode` → `export function extractRelevantCode` (`validatePatchTargets` is already exported). Add the delegation right after the `console.log("[PLAN] Stack trace file hints: ...")` line:

```ts
  if (targetClasses.size === 0 && fileHints.length === 0 && ctx.ticketText) {
    console.log("[PLAN] No stack-trace signals — using functional-bug path (keyword code search)");
    const { planFunctional } = await import("./plan-functional.js");
    return planFunctional(ctx, bitbucketClient);
  }
```

(Dynamic import avoids a static plan.ts ↔ plan-functional.ts cycle: plan-functional statically imports the shared helpers from plan.ts.)

In `plan-functional.ts`, add:

```ts
import type { BitbucketClient } from "@nrs/bitbucket-mcp/client";
import type { PipelineContext } from "../types.js";
import { ensureRepoClone } from "../repo-clone.js";
import { parseAiPlanResponse, fixPatchPaths, validatePatchTargets, extractRelevantCode } from "./plan.js";
import { startSpinner, stopSpinner } from "../spinner.js";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/pipeline/__tests__/`
Expected: PASS (all files, including untouched error-path tests).

- [ ] **Step 5: Commit**

```bash
git add packages/pipeline/src/steps/plan-functional.ts packages/pipeline/src/steps/plan.ts packages/pipeline/__tests__/plan-functional.test.ts packages/pipeline/__tests__/plan.test.ts
git commit -m "Wire functional-bug planning into PLAN

plan() delegates to the functional path when a ticket yields zero
stack-trace signals. Stage 3 reuses the existing parse/path-fix/
fabrication-guard machinery and enforces mandatory tests in every
functional patch; NO_PATCH responses fail as categorized declines."
```

---

### Task 7: Per-outcome backlog reporting + docs

**Files:**
- Modify: `packages/pipeline/src/orchestrator.ts` (`runJiraBacklog` catch + summary)
- Modify: `packages/pipeline/AUTONOMOUS_DEVOPS_PIPELINE.md`
- Modify: `packages/pipeline/DEVOPS_PIPELINE_USAGE.md`

**Interfaces:**
- Consumes: `FunctionalPlanError` (Task 3).

- [ ] **Step 1: Implement reporting**

In `runJiraBacklog`, replace the plain `failed++` catch with categorized tallies (find the existing per-ticket `try/catch` around the pipeline steps):

```ts
  const outcomes = new Map<string, string[]>(); // category → ["ARTS-220: reason", ...]
  const note = (category: string, line: string) => {
    if (!outcomes.has(category)) outcomes.set(category, []);
    outcomes.get(category)!.push(line);
  };
```

In the catch block:

```ts
    } catch (e) {
      failed++;
      const category = e instanceof FunctionalPlanError ? e.category : "error";
      note(category, `${ticket.key}: ${(e as Error).message}`);
      console.log(`[RAVEN] ${category === "error" ? "Failed on" : "Skipped"} ${ticket.key}: ${(e as Error).message}`);
    }
```

(and `note("planned", ticket.key)` on success). After the loop, replace the single summary line with:

```ts
  console.log(`\n[RAVEN] Jira backlog complete: ${processed} planned, ${failed} not planned, of ${tickets.length} ticket(s).`);
  for (const [category, lines] of outcomes) {
    if (category === "planned") continue;
    console.log(`[RAVEN]   ${category} (${lines.length}):`);
    for (const line of lines) console.log(`[RAVEN]     ${line}`);
  }
```

Import `FunctionalPlanError` from `"./steps/plan-functional.js"`.

- [ ] **Step 2: Update docs**

`AUTONOMOUS_DEVOPS_PIPELINE.md` — in the PLAN step section, after the source-finding strategy list, add:

```markdown
**Functional-bug path** (automatic): when a ticket yields zero stack-trace
signals, PLAN switches to keyword-based location — an AI call extracts
weighted domain terms (UI labels, entity nouns) from the full ticket text,
the app repo is cloned/updated locally (honoring `--branch`) and searched
with `git grep`, and the top-ranked source files feed a functional planning
prompt. Guardrails: tickets needing business input or too vague to plan
fail with a categorized reason; the patch may only touch files actually
read; every functional patch must include tests or it is discarded.
```

`DEVOPS_PIPELINE_USAGE.md` — in the Jira Backlog Mode section, add:

```markdown
Tickets without stack traces are planned via the functional-bug path
(keyword code search). The end-of-run summary categorizes every ticket:
`planned`, `needs-input` (blocked on a business decision), `vague`,
`no-source`, `declined`, or `no-tests`. Functional fixes always include
tests in the patch — a plan without tests is discarded.
```

- [ ] **Step 3: Build, run the full suite**

Run: `npm run build && npm test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/pipeline/src/orchestrator.ts packages/pipeline/AUTONOMOUS_DEVOPS_PIPELINE.md packages/pipeline/DEVOPS_PIPELINE_USAGE.md
git commit -m "Categorize backlog outcomes and document

Backlog summary now reports per-ticket outcomes (planned, needs-input,
vague, no-source, declined, no-tests) so a survey run reads as a
report. Docs cover the functional-bug path and its guardrails."
```

---

### Task 8: Acceptance — ARTS survey re-run + regression checks

No new code. Verifies the spec's acceptance criteria.

- [ ] **Step 1: Full suite** — `npm test` → green.
- [ ] **Step 2: ARTS backlog survey (dry run, live Jira/Bitbucket reads, no writes)**

```bash
node packages/pipeline/dist/index.js --app ARTS --component arts-arts-api \
  --jira-query "project = ARTS AND issuetype = Bug AND statusCategory != Done ORDER BY updated DESC" \
  --bitbucket-project ARTS --dry-run --verbose
```

Expected: all 6 tickets end as `planned` (patch includes tests) or a categorized bail (`needs-input` expected for the BusinessInputRequired-labeled tickets); zero fabricated file paths; summary shows per-category counts.

- [ ] **Step 3: Error-path regression (DMS log mode, dry run)**

```bash
node packages/pipeline/dist/index.js --server test01 --app DMS --component dms-document-api \
  --jira-project DMS --bitbucket-project DMS --branch feature/DMS-310 --dry-run --fresh --stop-after 3 --verbose
```

(Use the real TEST server name in the actual invocation.) Expected: identical behavior to the pre-change baseline — stack-trace path, no functional-path log line.

- [ ] **Step 4: Report results** — per-ticket table for ARTS (category + one-line reason), confirmation of the DMS baseline, suite count.

---

## Self-Review

- **Spec coverage:** auto-fallback trigger (Task 6 hook), Stage 1 + explicit gate (Task 4), Stage 2 clone+grep+rank (Tasks 1, 3, 5), Stage 3 prompt + NO_PATCH + mandatory tests (Tasks 3, 6), fabrication guard reuse (Task 6), per-outcome reporting (Task 7), docs (Task 7), acceptance survey (Task 8), unchanged error path (Task 6 delegation condition + regression tests). Covered.
- **Placeholder scan:** none — all steps carry code or exact commands.
- **Type consistency:** `SearchTerm`, `TicketUnderstanding`, `LocatedFile`, `FunctionalPlanDeps`, `FunctionalPlanError.category` names checked across Tasks 3–7; `ensureRepoClone(client, project, repo, branch?)` matches Tasks 1, 5 (via deps), and 6.
