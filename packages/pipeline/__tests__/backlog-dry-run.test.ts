import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// runJiraBacklog dry-run gating (orchestrator.ts)
//
// The backlog loop must mirror runPipeline: in --dry-run, stop after PLAN
// unless --stop-after explicitly requests later steps. The per-step dryRun
// guards inside implement()/createPr() already make dry-run side-effect
// free; the orchestrator-level gate keeps the two entry points consistent.
// ---------------------------------------------------------------------------

vi.mock("@nrs/auth", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@nrs/auth")>();
  return {
    ...orig,
    loadEnv: vi.fn(),
    createBasicAuthFetch: vi.fn().mockReturnValue(() => Promise.reject(new Error("no network in tests"))),
  };
});

vi.mock("@nrs/jira-mcp/client", () => ({
  JiraClient: class {
    searchIssues = vi.fn().mockResolvedValue({
      issues: [{ key: "TEST-1", fields: { summary: "Report truncates results" } }],
      total: 1,
    });
  },
}));

vi.mock("@nrs/bitbucket-mcp/client", () => ({
  BitbucketClient: class {},
}));

vi.mock("../src/scrub-default.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/scrub-default.js")>();
  return { ...orig, applyPipelineScrubDefault: vi.fn() };
});

vi.mock("../src/ai-client.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/ai-client.js")>();
  return { ...orig, setModel: vi.fn(), stopAI: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/steps/extract-from-ticket.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/extract-from-ticket.js")>();
  return {
    ...orig,
    extractFromTicket: vi.fn().mockResolvedValue({
      errors: [{ message: "m", stackTrace: "s", dedupeKey: "k", occurrences: 1 }],
      triageResult: { summary: "s", rootCause: "r", severity: "low", suggestedTitle: "t" },
      ticketText: "Report truncates results",
    }),
  };
});

vi.mock("../src/steps/plan.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/plan.js")>();
  return {
    ...orig,
    plan: vi.fn().mockImplementation(async (ctx) => {
      ctx.fixPlan = { affectedFiles: [], rootCause: "r", proposedFix: "p", patch: "PATCH" };
    }),
  };
});

vi.mock("../src/steps/implement.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/implement.js")>();
  return { ...orig, implement: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/steps/create-pr.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/create-pr.js")>();
  return { ...orig, createPr: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/steps/validate.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/validate.js")>();
  return { ...orig, validate: vi.fn().mockReturnValue({ success: true, stoppedAt: "plan", context: {} }) };
});

import { runJiraBacklog } from "../src/orchestrator.js";
import { plan } from "../src/steps/plan.js";
import { implement } from "../src/steps/implement.js";
import { createPr } from "../src/steps/create-pr.js";
import type { CliArgs } from "../src/types.js";

const ENV_KEYS = ["ATLASSIAN_EMAIL", "ATLASSIAN_PASSWORD", "ATLASSIAN_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    process.env[key] = "test-value";
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function backlogArgs(overrides: Partial<CliArgs>): CliArgs {
  return {
    app: "TESTAPP",
    component: "testapp-api",
    dryRun: false,
    jiraQuery: "project = TEST",
    ...overrides,
  } as CliArgs;
}

describe("runJiraBacklog dry-run gating", () => {
  it("stops after PLAN in dry-run: implement and createPr are not invoked", async () => {
    await runJiraBacklog(backlogArgs({ dryRun: true }));

    expect(vi.mocked(plan)).toHaveBeenCalledOnce();
    expect(vi.mocked(implement)).not.toHaveBeenCalled();
    expect(vi.mocked(createPr)).not.toHaveBeenCalled();
  });

  it("continues past PLAN in dry-run when --stop-after explicitly requests it", async () => {
    await runJiraBacklog(backlogArgs({ dryRun: true, stopAfter: 6 }));

    expect(vi.mocked(plan)).toHaveBeenCalledOnce();
    expect(vi.mocked(implement)).toHaveBeenCalledOnce();
  });

  it("runs IMPLEMENT normally when not in dry-run", async () => {
    await runJiraBacklog(backlogArgs({ dryRun: false }));

    expect(vi.mocked(plan)).toHaveBeenCalledOnce();
    expect(vi.mocked(implement)).toHaveBeenCalledOnce();
  });
});
