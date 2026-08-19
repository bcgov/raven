import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// askAI session cleanup (ai-client.ts)
// copilot-sdk 1.x replaced session.destroy() with disconnect() (keeps
// on-disk session state for resume) and client.deleteSession() (full
// removal — the old destroy semantics). The pipeline creates short-lived
// sessions per AI call, so cleanup must permanently delete them or watch /
// backlog runs accumulate session state on disk.
// ---------------------------------------------------------------------------

const sdkState = vi.hoisted(() => ({
  deleteSessionCalls: [] as string[],
  sendShouldThrow: false,
}));

vi.mock("@github/copilot-sdk", () => {
  class FakeSession {
    sessionId = "sess-1";
    private handlers = new Map<string, (e: unknown) => void>();
    on(event: string, handler: (e: unknown) => void): () => void {
      this.handlers.set(event, handler);
      return () => {};
    }
    async send(_opts: unknown): Promise<void> {
      if (sdkState.sendShouldThrow) throw new Error("send failed");
      queueMicrotask(() => {
        this.handlers.get("assistant.message")?.({ data: { content: "hello from ai" } });
        this.handlers.get("session.idle")?.({});
      });
    }
  }
  class CopilotClient {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async createSession(_opts: unknown): Promise<FakeSession> {
      return new FakeSession();
    }
    async deleteSession(id: string): Promise<void> {
      sdkState.deleteSessionCalls.push(id);
    }
  }
  return { CopilotClient, approveAll: () => "approve" };
});

import { aiTimeoutMs, DEFAULT_AI_TIMEOUT_MS, askAI, stopAI } from "../src/ai-client.js";

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

describe("askAI session cleanup", () => {
  beforeEach(() => {
    sdkState.deleteSessionCalls.length = 0;
    sdkState.sendShouldThrow = false;
  });

  afterEach(async () => {
    await stopAI();
  });

  it("permanently deletes the session after a successful call", async () => {
    const response = await askAI("what is up");
    expect(response).toBe("hello from ai");
    expect(sdkState.deleteSessionCalls).toEqual(["sess-1"]);
  });

  it("permanently deletes the session even when the send fails", async () => {
    sdkState.sendShouldThrow = true;
    await expect(askAI("boom")).rejects.toThrow("send failed");
    expect(sdkState.deleteSessionCalls).toEqual(["sess-1"]);
  });
});
