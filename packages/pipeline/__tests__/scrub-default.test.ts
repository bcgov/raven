import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// applyPipelineScrubDefault (scrub-default.ts)
// Pipeline prompts always go to an external LLM, so PI scrubbing is forced
// unconditionally — there is no opt-out, not even an explicit shell
// RAVEN_SCRUB_PI=false (FOIPPA). Other RAVEN tools still honor the global
// variable; only this process pins it.
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

  it("overrides an explicit false — there is no scrub opt-out", () => {
    process.env["RAVEN_SCRUB_PI"] = "false";
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("true");
  });

  it("overrides an explicit 0", () => {
    process.env["RAVEN_SCRUB_PI"] = "0";
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("true");
  });

  it("leaves an explicit true untouched", () => {
    process.env["RAVEN_SCRUB_PI"] = "true";
    applyPipelineScrubDefault();
    expect(process.env["RAVEN_SCRUB_PI"]).toBe("true");
  });
});
