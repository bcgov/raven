# Functional-Bug Planning Path — Design

**Date:** 2026-08-13
**Status:** Approved (design), pending implementation
**Owner:** James Gagan / RAVEN pipeline

## Problem

The autonomous pipeline's PLAN step locates source code exclusively from
error signals: stack-trace frames, logger `Class:line` tokens, and
`ca.bc.gov` class references. Jira backlog mode therefore fails on
*functional* bugs — wrong behavior with no exception — which dominate the
unfunded backlogs the pipeline is meant to help with. Measured on the ARTS
project: 0 of 6 open bugs were plannable (all functional-shaped: field
limits, filter behavior, code lists). CIRRAS holds 100+ similar tickets.

The fabrication guard (added earlier the same day) correctly refuses these
tickets today. This design gives PLAN a second, legitimate way to locate
code so those refusals become plans.

## Decisions (settled with owner)

1. **Automatic fallback.** When a ticket yields zero stack-trace signals
   (no target classes AND no file hints), PLAN switches to the functional
   path automatically, with a clear log line. No new CLI flag.
2. **Tests are mandatory in functional patches.** A functional fix has no
   runtime error to confirm it worked, so the generated patch must add or
   modify at least one test file. No test → patch discarded, ticket failed
   with a stated reason. The existing "tests must pass or no PR" rule then
   applies unchanged.

## Approach

Local clone + `git grep` keyword search (chosen over the Bitbucket
code-search API, which indexes only default branches and needs a plugin,
and over AI-over-file-listing, which cannot see file contents and misses
UI-label strings in `.xhtml`/properties files).

## Architecture

```
extract-from-ticket (existing; already passes summary/description through)
        │
        ▼
plan()  ── stack-trace signals found? ──yes──► existing error-shaped path (unchanged)
        │
        no
        ▼
plan-functional.ts  (new module)
  Stage 1  UNDERSTAND   AI call: ticket text → search terms + behavior + confidence
  Stage 2  LOCATE       clone/update repo at branch → git grep → rank → read top files
  Stage 3  PLAN         AI call: behavior + real source → JSON analysis + diff (with tests)
        │
        ▼
existing machinery, unchanged: fixPatchPaths → validatePatchTargets
(fabrication guard) → IMPLEMENT (apply, run tests) → CREATE-PR
```

## Components

### `steps/plan-functional.ts` (new)

Owns the three stages. Exported entry:
`planFunctional(ctx, bitbucketClient): Promise<void>` — same contract as
`plan()`: populates `ctx.fixPlan` or throws with an actionable reason.
Pure helpers exported for tests: term ranking, file ranking, and the
test-presence predicate.

### Stage 1 — UNDERSTAND (AI call)

Input: ticket summary, description, and comments (PI-scrubbed, as all AI
calls are). Output JSON:

```json
{
  "searchTerms": [{ "term": "Representative", "kind": "label|entity|identifier", "weight": 1-3 }],
  "buggyBehavior": "...",
  "expectedBehavior": "...",
  "confidence": "high|medium|low",
  "missingInfo": ["what should the new limit be?"]
}
```

The prompt instructs the model to list in `missingInfo` ONLY gaps that
block a safe fix (unknown business values, undecided requirements) — not
details it can infer from code.

**Gate (explicit rule):** fail the ticket when `confidence` is `low` OR
`missingInfo` is non-empty, with the reason (e.g. "needs business input:
what should the new limit be?"). This is the correct outcome for `BusinessInputRequired`-shaped
tickets; the backlog report states it honestly. No code is searched, no
patch is attempted.

### Stage 2 — LOCATE

- Reuse the clone: extract IMPLEMENT's clone/update logic (auth-URL
  injection + credential scrubbing, `CLONE_BASE` layout, branch checkout)
  into a shared `repo-clone.ts`; IMPLEMENT and plan-functional both call
  it. PLAN cloning benefits IMPLEMENT later (cache warm). Dry runs clone
  too — local-disk-only side effect, documented.
- Honors `--branch` via checkout, same app-repo-only scoping as the
  error path (no branch applied if a future extension searches other
  repos).
- Search: `git grep -i -l -e <term>` per term over the checkout
  (`git grep` is universally available and respects the checked-out
  revision). Collect per-file hit sets.
- Rank: sum of term weights per file; boosts for term-in-filename and
  `src/main` paths; source-ish files only (`.java`, `.xhtml`, `.jsp`,
  `.js`, `.ts`, `.properties`, `.xml`); take top 5.
- Read the top files and trim each with the existing relevant-code
  extractor, keyed on the search terms instead of an error message.
- Zero files located → fail with the same no-source refusal the error
  path uses (fabrication guard philosophy).

### Stage 3 — PLAN (AI call)

New `FUNCTIONAL_PLAN_SYSTEM_PROMPT`: given buggy behavior, expected
behavior, and the real source excerpts, respond in the existing
two-section format (single-line JSON analysis + unified diff). Explicit
instructions:

- The patch MUST include new or updated tests demonstrating the expected
  behavior.
- If the fix requires a business decision or the code cannot support the
  described behavior, respond `NO_PATCH: <reason>` instead of guessing.

Parsing, `fixPatchPaths`, and `validatePatchTargets` are reused untouched
(the guard already permits new-file additions — e.g. a new test class —
alongside modifications to files that were actually read).

### Test-presence enforcement

After parsing: the patch must add or modify at least one test file
(path contains `/test/` or basename matches `*Test.java` / `*.test.*` /
`*.spec.*`). Absent → discard patch, fail ticket with reason. Predicate
exported and unit-tested.

## Failure modes and reporting

Every functional-path failure is a one-line, human-actionable reason
attached to the ticket key in the backlog summary:

| Outcome | Report line |
|---|---|
| Needs business input | `ARTS-220: needs business input — what should the new limit be?` |
| Low confidence | `ARTS-212: ticket too vague to plan safely` |
| No code located | `ARTS-271: no matching source found for [terms]` |
| AI declined | `ARTS-478: NO_PATCH — <model's reason>` |
| Patch without tests | `<key>: plan discarded — no tests in patch` |

Backlog summary gains a per-outcome count (planned / needs-input / vague /
no-source / declined) so a survey run reads as a report.

## Unchanged behavior

- Error-shaped planning: byte-for-byte identical path.
- Log mode (DETECT) always has stack traces — functional path is
  effectively backlog-mode and `--ticket`-mode only.
- Cooldown, scrubbing, `--branch` semantics, IMPLEMENT, CREATE-PR: no
  changes beyond the shared clone extraction.

## Testing

- Unit: term ranking, file ranking (fixture file lists), test-presence
  predicate, Stage-1 gate behavior (mocked AI), no-source refusal,
  NO_PATCH handling, patch-without-tests discard (mocked AI + mocked
  clone/search seams).
- Integration seam: plan-functional takes an injectable searcher
  (`(terms) → file hits`) so unit tests avoid real clones.
- Acceptance: re-run the ARTS backlog dry-run survey. Success = every one
  of the 6 tickets ends in either a concrete plan (with tests in the
  patch) or an honest categorized bail; zero fabricated file paths; error
  path regression-free (full pipeline test suite green plus a DMS
  log-mode dry-run behaving as before).

## Out of scope (explicitly)

- Sibling/dependency-repo search for functional bugs (Bitbucket
  code-search API could serve this later).
- Multi-repo functional fixes.
- Auto-selecting which component repo a functional ticket belongs to —
  operator still supplies `--component`/`--bitbucket-repo` as today.
- CIRRAS rollout and PO outreach (separate efforts once this ships).
