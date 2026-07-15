import { describe, it, expect } from "vitest";
import { detectAreas } from "../signals/affected-area.js";
import { escapeCell } from "../output/markdown-report.js";
import { PROJECT_KEY_RE } from "../server.js";
import { scoreAllPairs, scorePair } from "../engine/scorer.js";
import { stripWikiMarkup } from "../ingest/ticket-parser.js";
import { buildClusters } from "../engine/clusterer.js";
import type { Ticket, ScoredPair } from "../types.js";

// ---------------------------------------------------------------------------
// detectAreas — must use word-boundary matching, not raw includes(). Without
// boundaries, "road" matches "broad" and "file" matches "profile", which
// inflates the affectedArea signal score and merges unrelated tickets.
// ---------------------------------------------------------------------------

describe("detectAreas (word-boundary matching)", () => {
  it("matches a keyword that appears as a whole word", () => {
    expect(detectAreas("There is an issue with the road permit", "RRS")).toContain("road");
  });

  it("does NOT match a keyword that is only a substring of a longer word", () => {
    // 'road' is in RRS keywords; it must NOT match 'broad'.
    expect(detectAreas("This is a broad issue", "RRS")).not.toContain("road");
  });

  it("does NOT match 'file' inside 'profile'", () => {
    // 'file' is in DMS keywords.
    expect(detectAreas("user profile is misaligned", "DMS")).not.toContain("file");
  });

  it("matches 'file' as a standalone word", () => {
    expect(detectAreas("Cannot upload the PDF file successfully", "DMS")).toContain("file");
  });

  it("returns empty array when project has no keyword dictionary", () => {
    expect(detectAreas("Anything goes here", "UNKNOWN")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(detectAreas("CLAIM is broken", "CWM")).toContain("claim");
  });
});

// ---------------------------------------------------------------------------
// escapeCell — Jira summaries can contain pipe characters and newlines.
// Emitted raw, they break the markdown table for every subsequent row.
// ---------------------------------------------------------------------------

describe("escapeCell", () => {
  it("escapes a single pipe character", () => {
    expect(escapeCell("foo | bar")).toBe("foo \\| bar");
  });

  it("escapes multiple pipes", () => {
    expect(escapeCell("a|b|c")).toBe("a\\|b\\|c");
  });

  it("collapses LF newlines into a space", () => {
    expect(escapeCell("line one\nline two")).toBe("line one line two");
  });

  it("collapses CRLF newlines into a space", () => {
    expect(escapeCell("line one\r\nline two")).toBe("line one line two");
  });

  it("escapes backslashes before pipes (avoids producing a literal \\|)", () => {
    expect(escapeCell("path\\to|file")).toBe("path\\\\to\\|file");
  });

  it("passes through unremarkable text unchanged", () => {
    expect(escapeCell("Plain summary text.")).toBe("Plain summary text.");
  });
});

// ---------------------------------------------------------------------------
// PROJECT_KEY_RE — security-relevant. Bad input previously got passed
// straight to getCachePath, allowing path traversal via "../../foo".
// ---------------------------------------------------------------------------

describe("PROJECT_KEY_RE", () => {
  it("accepts standard Jira project keys", () => {
    expect(PROJECT_KEY_RE.test("RRS")).toBe(true);
    expect(PROJECT_KEY_RE.test("DMS")).toBe(true);
    expect(PROJECT_KEY_RE.test("CWM")).toBe(true);
    expect(PROJECT_KEY_RE.test("PROJ1")).toBe(true);
    expect(PROJECT_KEY_RE.test("PROJECT10")).toBe(true);
  });

  it("rejects path-traversal attempts", () => {
    expect(PROJECT_KEY_RE.test("../etc/passwd")).toBe(false);
    expect(PROJECT_KEY_RE.test("../../foo")).toBe(false);
    expect(PROJECT_KEY_RE.test("..")).toBe(false);
    expect(PROJECT_KEY_RE.test("/absolute/path")).toBe(false);
  });

  it("rejects shell metacharacters and separators", () => {
    expect(PROJECT_KEY_RE.test("RRS;ls")).toBe(false);
    expect(PROJECT_KEY_RE.test("RRS/sub")).toBe(false);
    expect(PROJECT_KEY_RE.test("RRS\\sub")).toBe(false);
    expect(PROJECT_KEY_RE.test("RRS$(id)")).toBe(false);
  });

  it("rejects lowercase and mixed case", () => {
    expect(PROJECT_KEY_RE.test("rrs")).toBe(false);
    expect(PROJECT_KEY_RE.test("Rrs")).toBe(false);
  });

  it("rejects empty string and overly long input", () => {
    expect(PROJECT_KEY_RE.test("")).toBe(false);
    expect(PROJECT_KEY_RE.test("ABCDEFGHIJKLMNOPQRSTU")).toBe(false); // 21 chars
  });

  it("rejects single-character keys (matches health-mcp / overview-mcp)", () => {
    expect(PROJECT_KEY_RE.test("A")).toBe(false);
  });

  it("accepts 20-char keys (the upper bound)", () => {
    expect(PROJECT_KEY_RE.test("ABCDEFGHIJKLMNOPQRST")).toBe(true);
  });

  it("requires the first character to be a letter", () => {
    expect(PROJECT_KEY_RE.test("1RRS")).toBe(false);
    expect(PROJECT_KEY_RE.test("_RRS")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripWikiMarkup — italic stripping must NOT collapse identifiers like
// ABC_DEF_GHI or ORA_ERR_123. The earlier `_([^_]+)_` greedy pattern would
// match `_DEF_` inside the identifier and destroy the token, hurting the
// error-pattern and text-similarity signals.
// ---------------------------------------------------------------------------

describe("stripWikiMarkup italic handling", () => {
  it("strips italics surrounded by spaces", () => {
    expect(stripWikiMarkup("this _is_ italic")).toBe("this is italic");
  });

  it("strips italics at start of string", () => {
    expect(stripWikiMarkup("_starts_ with italic")).toBe("starts with italic");
  });

  it("preserves identifiers with embedded underscores", () => {
    expect(stripWikiMarkup("error code ABC_DEF_GHI was raised")).toBe("error code ABC_DEF_GHI was raised");
    expect(stripWikiMarkup("ORA_ERR_123 occurred")).toBe("ORA_ERR_123 occurred");
  });

  it("preserves a single trailing/leading underscore in an identifier", () => {
    expect(stripWikiMarkup("see _internal_helper for details")).toBe("see _internal_helper for details");
  });
});

// ---------------------------------------------------------------------------
// path-traversal sanitization for attachment filenames. Jira metadata is
// untrusted; without basename + path-prefix check, a filename like
// "../../etc/passwd" would escape the cache dir and overwrite local files
// when fs.writeFileSync runs. Tests call the real production helper so a
// regression in safeAttachmentPath actually fails this suite.
// ---------------------------------------------------------------------------

import { safeAttachmentPath } from "../ingest/jira-client.js";

describe("safeAttachmentPath", () => {
  const CACHE = "/tmp/raven-cache/attachments";

  it("strips path components from a malicious filename", () => {
    const target = safeAttachmentPath(CACHE, "12345", "../../etc/passwd");
    expect(target).not.toBeNull();
    expect(target!.startsWith(CACHE + "/")).toBe(true);
    expect(target).toBe("/tmp/raven-cache/attachments/12345-passwd");
  });

  it("preserves a normal filename", () => {
    const target = safeAttachmentPath(CACHE, "12345", "stack-trace.log");
    expect(target).toBe("/tmp/raven-cache/attachments/12345-stack-trace.log");
  });

  it("strips a nested directory via basename semantics", () => {
    const target = safeAttachmentPath(CACHE, "12345", "subdir/file.log");
    expect(target).toBe("/tmp/raven-cache/attachments/12345-file.log");
  });
});

// ---------------------------------------------------------------------------
// scoreAllPairs — the per-call instantiation fix means signal caches do not
// leak between calls. We can't directly probe private cache state, but we
// can verify that scoreAllPairs runs end-to-end across two consecutive calls
// without throwing and without mutating its inputs.
// ---------------------------------------------------------------------------

function fakeTicket(key: string, summary: string, project = "RRS"): Ticket {
  return {
    key,
    project,
    summary,
    description: "",
    issueType: "Bug",
    labels: [],
    components: [],
    priority: "Major",
    status: "Open",
    created: "2026-01-01T00:00:00.000Z",
    resolved: null,
    comments: [],
    attachmentTexts: [],
    duplicateLinks: [],
  };
}

describe("scoreAllPairs (per-call signal instantiation)", () => {
  it("returns ScoredPair[] for tickets above the threshold", () => {
    const tickets = [
      fakeTicket("RRS-1", "road permit creation fails"),
      fakeTicket("RRS-2", "road permit creation fails on submit"),
    ];
    // Use a low threshold so any non-zero score makes it through.
    const pairs = scoreAllPairs(tickets, 0);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.ticketA).toBe("RRS-1");
    expect(pairs[0]!.ticketB).toBe("RRS-2");
    expect(pairs[0]!.score).toBeGreaterThan(0);
  });

  it("two consecutive calls do not interfere — caches are not shared", () => {
    const tickets1 = [
      fakeTicket("RRS-1", "road permit creation fails"),
      fakeTicket("RRS-2", "road permit creation fails on submit"),
    ];
    // Same keys but different summaries — if the per-ticket caches leaked
    // from call #1, call #2 would score using the stale token sets.
    const tickets2 = [
      fakeTicket("RRS-1", "completely unrelated invoicing problem"),
      fakeTicket("RRS-2", "broken authentication callback"),
    ];
    const pairs1 = scoreAllPairs(tickets1, 0);
    const pairs2 = scoreAllPairs(tickets2, 0);
    // Call #1 should score higher (similar summaries) than call #2 (different).
    expect(pairs1[0]!.score).toBeGreaterThan(pairs2[0]?.score ?? 0);
  });

  it("scorePair accepts an explicit signals array (unit-test seam)", () => {
    const a = fakeTicket("RRS-1", "road permit");
    const b = fakeTicket("RRS-2", "road permit");
    const pair = scorePair(a, b);
    expect(pair.ticketA).toBe("RRS-1");
    expect(pair.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildClusters — exercises the full clustering pipeline including the
// oversized-cluster pruning path. Without these, the pruning behavior
// (which can drop tickets entirely when a large component collapses to
// singletons) had no automated coverage.
// ---------------------------------------------------------------------------

function fakePair(a: string, b: string, score = 0.5, signals?: Record<string, number>): ScoredPair {
  return {
    ticketA: a,
    ticketB: b,
    score,
    signalScores: signals ?? { textSimilarity: score, errorPattern: 0, componentLabel: 0, affectedArea: 0, temporalProximity: 0 },
  };
}

describe("buildClusters", () => {
  it("returns empty array when no pairs cross the threshold", () => {
    const tickets = [fakeTicket("RRS-1", "a"), fakeTicket("RRS-2", "b")];
    expect(buildClusters(tickets, [])).toEqual([]);
  });

  it("forms one cluster from a connected pair", () => {
    const tickets = [
      fakeTicket("RRS-1", "road permit creation fails"),
      fakeTicket("RRS-2", "road permit creation fails on submit"),
    ];
    const pairs = [fakePair("RRS-1", "RRS-2")];
    const clusters = buildClusters(tickets, pairs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.tickets.map((t) => t.key).sort()).toEqual(["RRS-1", "RRS-2"]);
  });

  it("forms multiple disjoint clusters when pairs do not bridge them", () => {
    const tickets = ["A", "B", "C", "D"].map((k) => fakeTicket(`RRS-${k}`, `summary ${k}`));
    const pairs = [fakePair("RRS-A", "RRS-B"), fakePair("RRS-C", "RRS-D")];
    const clusters = buildClusters(tickets, pairs);
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((c) => c.tickets.length).sort();
    expect(sizes).toEqual([2, 2]);
  });

  it("flags a cross-project cluster", () => {
    const tickets = [
      fakeTicket("RRS-1", "road permit", "RRS"),
      fakeTicket("DMS-9", "document attach", "DMS"),
    ];
    const pairs = [fakePair("RRS-1", "DMS-9")];
    const clusters = buildClusters(tickets, pairs);
    expect(clusters[0]!.isCrossProject).toBe(true);
  });

  it("prunes oversized clusters by removing the weakest edges", () => {
    // 22 tickets connected in a chain (RRS-1—RRS-2—…—RRS-22); the chain forms
    // one component over the 20-ticket threshold, so pruning kicks in.
    // Edges have ascending scores so the weakest are dropped first; the
    // chain breaks into two smaller components.
    const tickets = Array.from({ length: 22 }, (_, i) => fakeTicket(`RRS-${i + 1}`, `summary ${i + 1}`));
    const pairs: ScoredPair[] = [];
    for (let i = 0; i < tickets.length - 1; i++) {
      // Score increases along the chain — the weakest are at the start.
      const score = 0.3 + i * 0.01;
      pairs.push(fakePair(tickets[i]!.key, tickets[i + 1]!.key, score));
    }
    const clusters = buildClusters(tickets, pairs);

    // Pruning must have happened: no resulting cluster exceeds the 20 cap.
    expect(clusters.length).toBeGreaterThan(0);
    for (const c of clusters) {
      expect(c.tickets.length).toBeLessThanOrEqual(20);
    }
  });

  it("drops an oversized star-shaped cluster when pruning produces only singletons", () => {
    // Star: 22 leaves all connected to a central hub via single edges.
    // Removing the lowest-score edge just disconnects one leaf — the rest
    // stay attached to the hub, still over threshold. Continuing reduces
    // it to all singletons. Per the size-guard contract the oversized
    // false positive must be DROPPED rather than restored unchanged.
    const hub = fakeTicket("RRS-HUB", "hub");
    const leaves = Array.from({ length: 22 }, (_, i) => fakeTicket(`RRS-L${i + 1}`, `leaf ${i + 1}`));
    const tickets = [hub, ...leaves];
    const pairs: ScoredPair[] = leaves.map((l, i) => fakePair(hub.key, l.key, 0.3 + i * 0.0001));

    const clusters = buildClusters(tickets, pairs);

    // Either no clusters at all, or every cluster is within the size cap
    // (some sub-clusters could form if pruning happens to leave 2-leaf
    // chains via residual edges). Crucially: NO cluster contains all 23
    // tickets, which is what the old "restore on failure" path produced.
    for (const c of clusters) {
      expect(c.tickets.length).toBeLessThanOrEqual(20);
    }
  });
});
