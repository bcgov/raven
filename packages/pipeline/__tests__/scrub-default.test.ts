import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// applyPipelineScrubDefault (scrub-default.ts)
// The pipeline must default PI scrubbing ON regardless of what ~/.raven/.env
// says (loadEnv uses override:false, so a value already in process.env wins),
// while an explicit shell override for a single invocation is still honored.
// ---------------------------------------------------------------------------

import { applyPipelineScrubDefault } from "../src/scrub-default.js";

describe("applyPipelineScrubDefault", () => {
  let original: string | undefined;
  let hadKey: boolean;

  beforeEach(() => {
    hadKey = "RAVEN_SCRUB_PI" in process.env;
    original = process.env["RAVEN_SCRUB_PI"];
    delete process.env["RAVEN_SCRUB_PI"];
  });

  afterEach(() => {
    if (hadKey) {
      process.env["RAVEN_SCRUB_PI"] = original;
    } else {
      delete process.env["RAVEN_SCRUB_PI"];
    }
  });

  it("sets RAVEN_SCRUB_PI=true when the variable is unset", () => {
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("true");
  });

  it("preserves an explicit shell opt-out of false", () => {
    process.env["RAVEN_SCRUB_PI"] = "false";
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("false");
  });

  it("preserves an explicit shell opt-out of 0", () => {
    process.env["RAVEN_SCRUB_PI"] = "0";
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("0");
  });

  it("leaves an explicit true untouched", () => {
    process.env["RAVEN_SCRUB_PI"] = "true";
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("true");
  });
});
