import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// extractTargetClasses / validatePatchTargets / no-source refusal (plan.ts)
//
// Field finding from the first live run (test01/DMS, DMS-364): the TEST-server
// log format has no thread column ("ERROR  GlobalExceptionHandler:171 - ...")
// so no target classes were extracted, and PLAN then let the AI fabricate a
// patch for a file that was never read from Bitbucket.
// ---------------------------------------------------------------------------

vi.mock("../src/ai-client.js", () => ({
  askAI: vi.fn().mockResolvedValue(
    '{"affectedFiles":["src/main/java/com/invented/Foo.java"],"rootCause":"x","proposedFix":"y","patch":""}\n\n' +
    "--- a/src/main/java/com/invented/Foo.java\n+++ b/src/main/java/com/invented/Foo.java\n@@ -1,1 +1,1 @@\n-a\n+b",
  ),
}));

vi.mock("../src/steps/plan-functional.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/steps/plan-functional.js")>();
  return { ...orig, planFunctional: vi.fn().mockResolvedValue(undefined) };
});

// Import plan.js (the dynamic importer of plan-functional.js) BEFORE
// plan-functional.js itself. plan-functional.ts statically imports shared
// helpers from plan.ts, so plan.ts ↔ plan-functional.ts form a module
// cycle; loading plan-functional's mock factory first (via importOriginal)
// pulls in the real, unmocked plan.js ahead of time and the dynamic
// `import("./plan-functional.js")` inside plan() ends up resolving the
// real module instead of the mock. Importing plan.js first avoids that.
import { extractTargetClasses, validatePatchTargets, plan } from "../src/steps/plan.js";
import { planFunctional } from "../src/steps/plan-functional.js";
import { askAI } from "../src/ai-client.js";
import type { PipelineContext } from "../src/types.js";

// The real TEST-server log line that produced zero target classes (grep line-number
// prefix included, level directly followed by LoggerClass:line).
const TEST01_MESSAGE =
  "5581:2026-08-06 13:11:29 ERROR  GlobalExceptionHandler:171 - Unexpected error";
const TEST01_STACK =
  "5582-org.springframework.web.context.request.async.AsyncRequestNotUsableException: " +
  "ServletOutputStream failed to write: java.net.SocketTimeoutException";

describe("extractTargetClasses", () => {
  it("extracts the logger class from a level+class:line format with no thread column", () => {
    const classes = extractTargetClasses(TEST01_MESSAGE, TEST01_STACK);
    expect(classes.has("GlobalExceptionHandler.java")).toBe(true);
  });

  it("does not treat third-party exception names as target classes", () => {
    const classes = extractTargetClasses(TEST01_MESSAGE, TEST01_STACK);
    expect(classes.has("AsyncRequestNotUsableException.java")).toBe(false);
  });

  it("still extracts the class from the classic thread-column log4j format", () => {
    const classes = extractTargetClasses(
      "2026-03-04 14:13:50 ERROR jsse-nio-8029-exec-5 UUIDJAXBAdapter:33 - Failed to unmarshal uuid:",
      "",
    );
    expect(classes.has("UUIDJAXBAdapter.java")).toBe(true);
  });

  it("still extracts app classes from ca.bc.gov stack frames", () => {
    const classes = extractTargetClasses(
      "Error in processing",
      "at ca.bc.gov.nrs.dm.service.v1.impl.FolderServiceImpl.doWork(FolderServiceImpl.java:42)",
    );
    expect(classes.has("FolderServiceImpl.java")).toBe(true);
  });

  it("does not extract file-frame tokens like Foo.java:42 as logger classes", () => {
    const classes = extractTargetClasses(
      "at com.thirdparty.Handler.run(SomethingElseImpl.java:42)",
      "",
    );
    expect(classes.has("SomethingElseImpl.java")).toBe(false);
  });
});

describe("validatePatchTargets", () => {
  const sourceFiles = [
    { path: "nrs-dm-api/src/main/java/ca/bc/gov/nrs/dms/GlobalExceptionHandler.java", content: "", repo: "dms-document-api", project: "DMS" },
  ];

  it("keeps a patch whose files were all read from Bitbucket", () => {
    const patch =
      "--- a/nrs-dm-api/src/main/java/ca/bc/gov/nrs/dms/GlobalExceptionHandler.java\n" +
      "+++ b/nrs-dm-api/src/main/java/ca/bc/gov/nrs/dms/GlobalExceptionHandler.java\n" +
      "@@ -1,1 +1,1 @@\n-a\n+b";
    expect(validatePatchTargets(patch, sourceFiles)).toBe(true);
  });

  it("rejects a patch that touches a file never read from Bitbucket", () => {
    const patch =
      "--- a/src/main/java/com/dms/document/api/exception/GlobalExceptionHandler.java\n" +
      "+++ b/src/main/java/com/dms/document/api/exception/GlobalExceptionHandler.java\n" +
      "@@ -1,1 +1,1 @@\n-a\n+b";
    expect(validatePatchTargets(patch, sourceFiles)).toBe(false);
  });

  it("rejects any patch when no source files were read", () => {
    const patch = "--- a/Anything.java\n+++ b/Anything.java\n@@ -1,1 +1,1 @@\n-a\n+b";
    expect(validatePatchTargets(patch, [])).toBe(false);
  });
});

describe("plan() with --branch", () => {
  it("reads app-repo files at the requested branch and keeps the resulting patch", async () => {
    const HANDLER_PATH =
      "src/main/java/ca/bc/gov/nrs/dm/controller/GlobalExceptionHandler.java";
    const BRANCH = "feature/DMS-310";
    const client = {
      readFile: vi
        .fn()
        .mockImplementation((_p: string, _r: string, path: string, at?: string) =>
          at === BRANCH && path === HANDLER_PATH
            ? Promise.resolve("public class GlobalExceptionHandler { /* Unexpected error */ }")
            : Promise.reject(new Error("404")),
        ),
      listFiles: vi
        .fn()
        .mockImplementation((_p: string, _r: string, _l?: number, _m?: number, at?: string) =>
          Promise.resolve(at === BRANCH ? [HANDLER_PATH] : []),
        ),
      listRepos: vi.fn().mockRejectedValue(new Error("404")),
    };
    vi.mocked(askAI).mockResolvedValueOnce(
      `{"affectedFiles":["${HANDLER_PATH}"],"rootCause":"rc","proposedFix":"pf","patch":""}\n\n` +
        `--- a/${HANDLER_PATH}\n+++ b/${HANDLER_PATH}\n@@ -1,1 +1,1 @@\n-a\n+b`,
    );
    const ctx = {
      app: "NOSUCHAPP2",
      component: "nosuchapp2-fake-api",
      branch: BRANCH,
      errors: [
        {
          message: TEST01_MESSAGE,
          stackTrace: TEST01_STACK,
          occurrences: 3,
          dedupeKey: "k",
        },
      ],
      ticketKey: "TEST-2",
      dryRun: false,
      isDuplicate: false,
    } as unknown as PipelineContext;

    await plan(ctx, client as never);

    expect(ctx.fixPlan?.patch).toContain(HANDLER_PATH);
    expect(ctx.fixPlan?.rootCause).toBe("rc");
    const listFilesAts = client.listFiles.mock.calls.map((c) => c[4]);
    expect(listFilesAts).toContain(BRANCH);
  });
});

describe("plan() dependency discovery with --branch", () => {
  it("reads the app repo's pom.xml at the requested branch", async () => {
    const BRANCH = "feature/DMS-310";
    const pomReads: Array<{ path: string; at?: string }> = [];
    const client = {
      readFile: vi
        .fn()
        .mockImplementation((_p: string, _r: string, path: string, at?: string) => {
          if (path.endsWith("pom.xml")) pomReads.push({ path, at });
          return Promise.reject(new Error("404"));
        }),
      listFiles: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockRejectedValue(new Error("404")),
    };
    const ctx = {
      app: "NOSUCHAPP3",
      component: "nosuchapp3-fake-api",
      branch: BRANCH,
      errors: [
        { message: TEST01_MESSAGE, stackTrace: TEST01_STACK, occurrences: 1, dedupeKey: "k" },
      ],
      ticketKey: "TEST-3",
      dryRun: false,
      isDuplicate: false,
    } as unknown as PipelineContext;

    await expect(plan(ctx, client as never)).rejects.toThrow(/no source files/i);
    expect(pomReads.length).toBeGreaterThan(0);
    expect(pomReads.every((r) => r.at === BRANCH)).toBe(true);
  });
});

describe("plan() with no locatable source", () => {
  it("fails instead of asking the AI to fabricate a patch", async () => {
    const failingClient = {
      readFile: vi.fn().mockRejectedValue(new Error("404")),
      listFiles: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockRejectedValue(new Error("404")),
    };
    const ctx = {
      app: "NOSUCHAPP",
      component: "nosuchapp-fake-api",
      errors: [
        {
          message: TEST01_MESSAGE,
          stackTrace: TEST01_STACK,
          occurrences: 3,
          dedupeKey: "k",
        },
      ],
      ticketKey: "TEST-1",
      dryRun: false,
      isDuplicate: false,
    } as unknown as PipelineContext;

    await expect(
      plan(ctx, failingClient as never),
    ).rejects.toThrow(/no source files/i);
    expect(vi.mocked(askAI)).not.toHaveBeenCalled();
  });
});

describe("plan() functional delegation", () => {
  it("delegates to planFunctional when there are no stack-trace signals and ticketText exists", async () => {
    const ctx = {
      app: "NOSUCHAPP4", component: "nosuchapp4-fake-api",
      errors: [{ message: "Field truncates", stackTrace: "no trace here", occurrences: 1, dedupeKey: "k" }],
      ticketKey: "TEST-9", ticketText: "Field truncates at 40 chars", dryRun: false, isDuplicate: false,
    } as unknown as PipelineContext;
    await plan(ctx, { readFile: vi.fn(), listFiles: vi.fn(), listRepos: vi.fn() } as never);
    expect(vi.mocked(planFunctional)).toHaveBeenCalledOnce();
  });
});
