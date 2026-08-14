import { describe, it, expect } from "vitest";
import { buildDuplicateJql } from "../src/steps/triage.js";

// ---------------------------------------------------------------------------
// buildDuplicateJql (triage.ts)
// The duplicate search previously carried `created >= -90d`. A PROD dry-run
// against cwm-sos-api surfaced the consequence: CWM-775 (open since March,
// 163 days) covers the exact error still occurring, but fell outside the
// window — a live run would have filed a duplicate of an open ticket.
// The status filter already excludes resolved work, so age is irrelevant:
// an open ticket for the same error is a duplicate however old it is.
// ---------------------------------------------------------------------------

describe("buildDuplicateJql", () => {
  it("does not restrict duplicates by ticket age", () => {
    expect(buildDuplicateJql("CWM", "UUIDJAXBAdapter")).not.toMatch(/created\s*>=/);
  });

  it("still scopes to the project, keyword, and unresolved status", () => {
    const jql = buildDuplicateJql("CWM", "UUIDJAXBAdapter");
    expect(jql).toContain('project = CWM');
    expect(jql).toContain('text ~ "UUIDJAXBAdapter"');
    expect(jql).toContain("status NOT IN (Done, Closed, Resolved)");
  });
});
