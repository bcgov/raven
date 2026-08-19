import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { aiTimeoutMs, DEFAULT_AI_TIMEOUT_MS } from "../src/ai-client.js";

// ---------------------------------------------------------------------------
// aiTimeoutMs (ai-client.ts)
// The 120s AI-call ceiling was hard-coded; live ARTS runs showed legitimate
// planning calls exceeding it regardless of model. RAVEN_AI_TIMEOUT_MS makes
// it operator-tunable within sane bounds.
// ---------------------------------------------------------------------------

describe("aiTimeoutMs", () => {
  let saved: string | undefined;
  let hadKey: boolean;

  beforeEach(() => {
    hadKey = "RAVEN_AI_TIMEOUT_MS" in process.env;
    saved = process.env["RAVEN_AI_TIMEOUT_MS"];
    delete process.env["RAVEN_AI_TIMEOUT_MS"];
  });

  afterEach(() => {
    if (hadKey) process.env["RAVEN_AI_TIMEOUT_MS"] = saved;
    else delete process.env["RAVEN_AI_TIMEOUT_MS"];
  });

  it("defaults to 120s when unset", () => {
    expect(aiTimeoutMs()).toBe(DEFAULT_AI_TIMEOUT_MS);
    expect(DEFAULT_AI_TIMEOUT_MS).toBe(120_000);
  });

  it("honors a valid override", () => {
    process.env["RAVEN_AI_TIMEOUT_MS"] = "300000";
    expect(aiTimeoutMs()).toBe(300_000);
  });

  it("clamps to the 60s floor and 600s ceiling", () => {
    process.env["RAVEN_AI_TIMEOUT_MS"] = "1000";
    expect(aiTimeoutMs()).toBe(60_000);
    process.env["RAVEN_AI_TIMEOUT_MS"] = "9999999";
    expect(aiTimeoutMs()).toBe(600_000);
  });

  it("ignores garbage values", () => {
    process.env["RAVEN_AI_TIMEOUT_MS"] = "not-a-number";
    expect(aiTimeoutMs()).toBe(DEFAULT_AI_TIMEOUT_MS);
  });
});
