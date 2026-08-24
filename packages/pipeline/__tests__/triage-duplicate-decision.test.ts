import { describe, it, expect } from "vitest";
import { decideDuplicate } from "../src/steps/triage.js";

// ---------------------------------------------------------------------------
// decideDuplicate (triage.ts)
// A live PROD verification exposed the failure mode this encodes: a keyword
// search for SQLConflictFinderTaskQuerySubtaskImpl matched CWM-692, an open
// *feature* ticket whose description discusses that class. Treating that as a
// duplicate would have commented on unrelated work AND left a real PROD error
// with no ticket. Only an exact fingerprint match may suppress; a keyword hit
// is recorded as "possibly related" and the ticket is still filed.
// ---------------------------------------------------------------------------

describe("decideDuplicate", () => {
  it("suppresses on an exact fingerprint match", () => {
    const d = decideDuplicate("fingerprint", "CWM-775");
    expect(d.isDuplicate).toBe(true);
    expect(d.relatedKey).toBeUndefined();
  });

  it("does not suppress on a keyword-only match, but records it as related", () => {
    const d = decideDuplicate("keyword", "CWM-692");
    expect(d.isDuplicate).toBe(false);
    expect(d.relatedKey).toBe("CWM-692");
  });

  it("is not a duplicate when nothing matched", () => {
    const d = decideDuplicate(null, undefined);
    expect(d.isDuplicate).toBe(false);
    expect(d.relatedKey).toBeUndefined();
  });
});
