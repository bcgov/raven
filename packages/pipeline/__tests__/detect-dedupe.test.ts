import { describe, it, expect } from "vitest";
import { normalizeForDedupe } from "../src/steps/detect.js";

// ---------------------------------------------------------------------------
// normalizeForDedupe (detect.ts)
// A PROD scan of cwm-sos-api reported 12 "unique" errors, 8 of which were one
// bug logged from different Tomcat worker threads — the thread column varies
// per request, so it must not enter the dedupe key. Inflated counts mean
// per-thread cooldown entries and repeated tickets for a single defect.
// ---------------------------------------------------------------------------

const uuidErr = (thread: string) =>
  `3635:2026-08-14 08:29:32 ERROR ${thread} UUIDJAXBAdapter:33 - Failed to unmarshal uuid:`;

describe("normalizeForDedupe", () => {
  it("collapses the same error logged from different worker threads", () => {
    const a = normalizeForDedupe(uuidErr("jsse-nio-8029-exec-1"));
    const b = normalizeForDedupe(uuidErr("jsse-nio-8029-exec-8"));
    const c = normalizeForDedupe(uuidErr("sse-nio-8029-exec-10"));
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it("collapses task-executor thread names too", () => {
    const a = normalizeForDedupe(
      "4134:2026-08-14 08:32:35 ERROR taskExecutor-9       AbstractTask:117 - Request failed",
    );
    const b = normalizeForDedupe(
      "9021:2026-08-14 10:02:11 ERROR taskExecutor-3       AbstractTask:117 - Request failed",
    );
    expect(a).toBe(b);
  });

  it("keeps genuinely different logger classes and lines apart", () => {
    const a = normalizeForDedupe(uuidErr("jsse-nio-8029-exec-1"));
    const b = normalizeForDedupe(
      "4135:2026-08-14 08:32:35 ERROR taskExecutor-9       AbstractTask:98 - Attempt to set status",
    );
    expect(a).not.toBe(b);
  });

  it("leaves a log line with no thread column unchanged in meaning", () => {
    // TEST-server format (no thread column) must keep its class token.
    const out = normalizeForDedupe(
      "5581:2026-08-06 13:11:29 ERROR  GlobalExceptionHandler:171 - Unexpected error",
    );
    expect(out).toContain("GlobalExceptionHandler:171");
    expect(out).not.toContain("<THREAD>");
  });

  it("still normalizes request ids and UUIDs", () => {
    const a = normalizeForDedupe("ERROR: DMSAPI9518D29FB863 Could not get folder");
    const b = normalizeForDedupe("ERROR: DMSAPI28BC6060D772 Could not get folder");
    expect(a).toBe(b);
  });
});
