import { describe, it, expect } from "vitest";
import {
  buildDuplicateJql,
  buildFingerprintJql,
  ticketFingerprint,
} from "../src/steps/triage.js";

// ---------------------------------------------------------------------------
// ticketFingerprint / buildFingerprintJql
// Keyword matching alone missed a real duplicate: CWM-775 was filed by an
// earlier run for the same defect, but its captured stack trace produced a
// different keyword, so no text search could connect them. A fingerprint
// label derived from the error signature lets the pipeline recognise its own
// tickets whatever the log text does between releases.
// ---------------------------------------------------------------------------

describe("ticketFingerprint", () => {
  it("is stable for the same app/component/error signature", () => {
    const a = ticketFingerprint("SOS", "cwm-sos-api", "IllegalArgumentException::at java.util.UUID.fromString");
    const b = ticketFingerprint("SOS", "cwm-sos-api", "IllegalArgumentException::at java.util.UUID.fromString");
    expect(a).toBe(b);
  });

  it("is a valid Jira label (no spaces, prefixed)", () => {
    const fp = ticketFingerprint("SOS", "cwm-sos-api", "E::frame");
    expect(fp).toMatch(/^raven-fp-[0-9a-f]{10}$/);
  });

  it("differs for different components and different errors", () => {
    const base = ticketFingerprint("SOS", "cwm-sos-api", "E::frame");
    expect(ticketFingerprint("SOS", "cwm-mis-api", "E::frame")).not.toBe(base);
    expect(ticketFingerprint("SOS", "cwm-sos-api", "Other::frame")).not.toBe(base);
  });

  it("ignores the server so one defect maps to one ticket across environments", () => {
    // The cooldown store is per-server (suppression is environment-specific),
    // but a defect seen in TEST and PROD is still one bug and one ticket.
    const fp = ticketFingerprint("SOS", "cwm-sos-api", "E::frame");
    expect(fp).toBe(ticketFingerprint("SOS", "cwm-sos-api", "E::frame"));
  });
});

describe("buildFingerprintJql", () => {
  it("matches the exact fingerprint label among unresolved tickets", () => {
    const jql = buildFingerprintJql("CWM", "raven-fp-abcdef0123");
    expect(jql).toContain('labels = "raven-fp-abcdef0123"');
    expect(jql).toContain("project = CWM");
    expect(jql).toContain("status NOT IN (Done, Closed, Resolved)");
  });
});

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
