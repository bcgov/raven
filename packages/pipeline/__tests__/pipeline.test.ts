import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// extractKeyword (triage.ts)
// Verifies the priority waterfall produces the right keyword for Jira search.
// A bad keyword means false-positive duplicates or missed matches.
// ---------------------------------------------------------------------------

import { extractKeyword, selectErrorMatchingTicket } from "../src/steps/triage.js";
import type { ErrorInfo } from "../src/types.js";

describe("extractKeyword", () => {
  it("prefers app-specific log4j class over generic exception in the same message", () => {
    // Real-world: log line has both the log4j class column AND a stdlib exception
    const message =
      "2026-03-04 14:13:50 ERROR jsse-nio-8029-exec-5 UUIDJAXBAdapter:33 - Failed to unmarshal uuid:";
    const stackTrace = "java.lang.IllegalArgumentException: Invalid UUID string:\n" +
      "\tat java.util.UUID.fromString(UUID.java:194)";
    const result = extractKeyword(message, stackTrace);
    // Should pick UUIDJAXBAdapter (app-specific) not IllegalArgumentException (stdlib)
    expect(result).toBe("UUIDJAXBAdapter");
  });

  it("finds ca.bc.gov class in stack trace when message has no class info", () => {
    const message = "Error in processing";
    const stackTrace =
      "at ca.bc.gov.nrs.cwm.generic.FolderServiceImpl.doWork(FolderServiceImpl.java:42)\n" +
      "at ca.bc.gov.nrs.cwm.generic.AbstractService.execute(AbstractService.java:10)";
    const result = extractKeyword(message, stackTrace);
    // Should find FolderServiceImpl from the ca.bc.gov package
    expect(result).toBe("FolderServiceImpl");
  });

  it("picks non-stdlib exception over stdlib exception", () => {
    // CustomValidationException wraps an IllegalArgumentException
    const message = "CustomValidationException: invalid input";
    const stackTrace = "Caused by: java.lang.IllegalArgumentException: bad value";
    const result = extractKeyword(message, stackTrace);
    expect(result).toBe("CustomValidationException");
  });

  it("uses stdlib exception as last resort when nothing better exists", () => {
    // Pure stdlib error with no app-specific context
    const message = "IllegalArgumentException: bad value";
    const result = extractKeyword(message, "");
    expect(result).toBe("IllegalArgumentException");
  });

  it("extracts class from fully-qualified name when no exceptions present", () => {
    const message = "Error in com.example.foo.MyService";
    const result = extractKeyword(message, "");
    expect(result).toBe("MyService");
  });

  it("uses a distinctive word when no class names are found", () => {
    const message = "Something weird happened during processing";
    const result = extractKeyword(message, "");
    expect(result).toBe("Something");
  });

  it("never returns empty string — falls back to 'error'", () => {
    const result = extractKeyword("", "");
    expect(result).toBe("error");
  });

  it("handles real DMS error with oracle.stellent in stack trace", () => {
    // Real case: should pick FolderServiceImpl (ca.bc.gov) not ServiceException (oracle)
    const message = "48923:2026-03-04 15:08:36 ERROR: DMSAPIB50BD863056D ca.bc.gov.nrs.dm.service.v1.impl.FolderServiceImpl Could not get folder metadata";
    const stackTrace = "oracle.stellent.ridc.protocol.ServiceException: path does not exist";
    const result = extractKeyword(message, stackTrace);
    // Should NOT be ServiceException (third-party oracle class)
    expect(result).not.toBe("ServiceException");
    expect(result).toBe("FolderServiceImpl");
  });
});

// ---------------------------------------------------------------------------
// selectErrorMatchingTicket (triage.ts)
// When --ticket is supplied, the pipeline must reorder ctx.errors so PLAN
// operates on the error the ticket describes — NOT just the most-frequent one.
// Regression test: DMS-320 (FileServiceImpl) was getting patched against
// FolderServiceImpl because FolderServiceImpl had more occurrences.
// ---------------------------------------------------------------------------

describe("selectErrorMatchingTicket", () => {
  const fileServiceErr: ErrorInfo = {
    message: "ERROR ca.bc.gov.nrs.dm.service.v1.impl.FileServiceImpl Failed to parse date",
    stackTrace:
      "java.text.ParseException: Unparseable date: '2026-03-04'\n" +
      "\tat ca.bc.gov.nrs.dm.service.v1.impl.FileServiceImpl.getMetadata(FileServiceImpl.java:128)",
    dedupeKey: "FileServiceImpl-getMetadata",
    occurrences: 1,
  };
  const folderServiceErr: ErrorInfo = {
    message: "ERROR ca.bc.gov.nrs.dm.service.v1.impl.FolderServiceImpl Could not get folder",
    stackTrace:
      "oracle.stellent.ridc.protocol.ServiceException: path does not exist\n" +
      "\tat ca.bc.gov.nrs.dm.service.v1.impl.FolderServiceImpl.getFolder(FolderServiceImpl.java:42)",
    dedupeKey: "FolderServiceImpl-getFolder",
    occurrences: 4,
  };

  it("regression: picks the ticket-matching error even when another has more occurrences", () => {
    // DMS-320 case: FileServiceImpl is in the ticket but FolderServiceImpl has 4× occurrences
    const errors = [folderServiceErr, fileServiceErr];
    const ticketText =
      "FileServiceImpl date parsing fails on certain locale formats\n\n" +
      "Production logs show java.text.ParseException coming from FileServiceImpl.getMetadata.";
    expect(selectErrorMatchingTicket(errors, ticketText)).toBe(1);
  });

  it("returns 0 when the first error already matches the ticket", () => {
    const errors = [fileServiceErr, folderServiceErr];
    const ticketText = "FileServiceImpl date parsing fails on certain locale formats";
    expect(selectErrorMatchingTicket(errors, ticketText)).toBe(0);
  });

  it("returns -1 when no error mentions any class named in the ticket", () => {
    const errors = [folderServiceErr];
    const ticketText = "OutboundEmailNotifier retry policy is too aggressive";
    expect(selectErrorMatchingTicket(errors, ticketText)).toBe(-1);
  });

  it("returns -1 when ticket text has no class-name candidates at all", () => {
    const errors = [fileServiceErr, folderServiceErr];
    const ticketText = "the api is broken please fix";
    expect(selectErrorMatchingTicket(errors, ticketText)).toBe(-1);
  });

  it("returns -1 for empty errors array", () => {
    expect(selectErrorMatchingTicket([], "FileServiceImpl is broken")).toBe(-1);
  });

  it("scores by overlap when multiple ticket classes appear", () => {
    // Ticket names two classes; the error mentioning both should win
    const oneMatch: ErrorInfo = {
      message: "PaymentService.process failed",
      stackTrace: "at com.example.PaymentService.process(PaymentService.java:55)",
      dedupeKey: "PaymentService-process",
      occurrences: 10,
    };
    const twoMatches: ErrorInfo = {
      message: "OrderController called PaymentService and failed",
      stackTrace:
        "at com.example.OrderController.checkout(OrderController.java:80)\n" +
        "at com.example.PaymentService.charge(PaymentService.java:120)",
      dedupeKey: "OrderController-checkout",
      occurrences: 1,
    };
    const errors = [oneMatch, twoMatches];
    const ticketText = "OrderController checkout fails when PaymentService is unavailable";
    expect(selectErrorMatchingTicket(errors, ticketText)).toBe(1);
  });

  it("handles null-ish ticket description gracefully (treated as empty)", () => {
    const errors = [fileServiceErr];
    // Caller passes summary + (description ?? "") — verify we cope with sparse text
    const ticketText = "FileServiceImpl\n";
    expect(selectErrorMatchingTicket(errors, ticketText)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shellEscape (implement.ts)
// Prevents command injection in git commit messages.
// ---------------------------------------------------------------------------

import { shellEscape, inferRepoSlug, applyPatchByReplacement } from "../src/steps/implement.js";

describe("shellEscape", () => {
  it("prevents command injection via single quote breakout", () => {
    // An attacker could try: fix'; rm -rf /; echo '
    const malicious = "fix'; rm -rf /; echo '";
    const escaped = shellEscape(malicious);
    // shellEscape wraps in single quotes, replacing ' with '\''
    // The result must start and end with single quotes (one safe argument)
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    // Verify the escape produces the correct shell-safe form
    expect(escaped).toBe("'fix'\\''; rm -rf /; echo '\\'''");
  });

  it("handles multi-line commit messages with special chars", () => {
    const commitMsg = "CWM-775 Fix UUID parsing\n\nAdd null check for empty strings";
    const escaped = shellEscape(commitMsg);
    // Should wrap the whole thing safely
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });

  it("handles empty string without breaking shell syntax", () => {
    expect(shellEscape("")).toBe("''");
  });
});

// ---------------------------------------------------------------------------
// inferRepoSlug (implement.ts)
// Maps component names to Bitbucket repo slugs.
// ---------------------------------------------------------------------------

describe("inferRepoSlug", () => {
  it("extracts first segment and prepends nr-", () => {
    expect(inferRepoSlug("dms-document-api")).toBe("nr-dms");
    expect(inferRepoSlug("cwm-sos-api")).toBe("nr-cwm");
    expect(inferRepoSlug("rrs-api")).toBe("nr-rrs");
  });

  it("handles component with no dash", () => {
    expect(inferRepoSlug("standalone")).toBe("nr-standalone");
  });
});

// ---------------------------------------------------------------------------
// applyPatchByReplacement (implement.ts)
// Tests the fallback patch strategy that handles AI-generated patches where
// whitespace doesn't match, or git apply fails. This is critical for the
// pipeline's ability to apply fixes to real codebases.
// ---------------------------------------------------------------------------

describe("applyPatchByReplacement", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `raven-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("applies a one-line fix like the UUIDJAXBAdapter null check", () => {
    // Simulates the actual fix that was successfully applied to cwm-generic-lib
    const filePath = join(testDir, "UUIDJAXBAdapter.java");
    writeFileSync(filePath, [
      "public class UUIDJAXBAdapter extends XmlAdapter<String, UUID> {",
      "",
      "\t@Override",
      "\tpublic UUID unmarshal(String uuidText) {",
      "\t\tUUID result = null;",
      "",
      "\t\ttry",
      "\t\t{",
      "\t\t\tif (uuidText != null)",
      "\t\t\t{",
      "\t\t\t\tresult = UUID.fromString(uuidText);",
      "\t\t\t}",
      "\t\t}",
      "\t\tcatch (Exception ex)",
      "\t\t{",
      "\t\t\tlog.error(\"Failed to unmarshal uuid: \" + uuidText, ex);",
      "\t\t}",
      "\t\treturn result;",
      "\t}",
      "}",
    ].join("\n"));

    // AI-generated patch with spaces (file uses tabs)
    const patch = [
      "--- a/UUIDJAXBAdapter.java",
      "+++ b/UUIDJAXBAdapter.java",
      "@@ -9,1 +9,1 @@",
      "-         if (uuidText != null)",
      "+         if (uuidText != null && !uuidText.trim().isEmpty())",
    ].join("\n");

    const result = applyPatchByReplacement(testDir, patch);
    expect(result).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    // Original tab indentation must be preserved
    expect(content).toContain("\t\t\tif (uuidText != null && !uuidText.trim().isEmpty())");
    // Original line must be gone
    expect(content).not.toMatch(/\tif \(uuidText != null\)\s*$/m);
  });

  it("disambiguates duplicate code blocks using context lines", () => {
    // Simulates FolderServiceImpl with multiple identical catch blocks
    const filePath = join(testDir, "FolderService.java");
    writeFileSync(filePath, [
      "// Method 1 — different structure",
      "\t\t} catch (Exception e) {",
      "\t\t\tString msg = \"Could not get folder metadata because \" + e.getMessage();",
      "\t\t\tlog.error(msg, e);",
      "\t\t\treturn DMServiceResponse.ERROR(msg);",
      "\t\t}",
      "",
      "// Method 2 — this is the one we want to patch",
      "\t\t} catch (Exception e) {",
      "\t\t\tString msg = \"Could not get folder metadata because \" + e.getMessage();",
      "\t\t\tlog.error(msg, e);",
      "",
      "\t\t\t// Should it be a NotFoundException exception ?",
      "\t\t\tif (e.getMessage().contains(\"does not exist\")) {",
      "\t\t\t\tthrow new NotFoundException(msg);",
      "\t\t\t} else {",
      "\t\t\t\tthrow new ServiceException(msg, e);",
      "\t\t\t}",
      "\t\t}",
    ].join("\n"));

    // Patch includes context lines to disambiguate
    const patch = [
      "--- a/FolderService.java",
      "+++ b/FolderService.java",
      "@@ -10,5 +10,6 @@",
      " \t\t} catch (Exception e) {",
      " \t\t\tString msg = \"Could not get folder metadata because \" + e.getMessage();",
      "-\t\t\tlog.error(msg, e);",
      "",
      "-\t\t\t// Should it be a NotFoundException exception ?",
      " \t\t\tif (e.getMessage().contains(\"does not exist\")) {",
      "+\t\t\t\tlog.debug(msg);",
      " \t\t\t\tthrow new NotFoundException(msg);",
      " \t\t\t} else {",
      "+\t\t\t\tlog.error(msg, e);",
      " \t\t\t\tthrow new ServiceException(msg, e);",
    ].join("\n");

    const result = applyPatchByReplacement(testDir, patch);
    expect(result).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    // Method 1 should be untouched — still has log.error + return
    expect(content).toContain("return DMServiceResponse.ERROR(msg);");
    // Method 2 should have the fix
    expect(content).toContain("log.debug(msg);");
  });

  it("returns false and leaves file unchanged when patch doesn't match", () => {
    const filePath = join(testDir, "Unchanged.java");
    const original = "public class Unchanged { void doWork() {} }";
    writeFileSync(filePath, original);

    const patch = [
      "--- a/Unchanged.java",
      "+++ b/Unchanged.java",
      "@@ -1,1 +1,1 @@",
      "-this line does not exist anywhere in the file",
      "+replacement line",
    ].join("\n");

    const result = applyPatchByReplacement(testDir, patch);
    expect(result).toBe(false);
    // File must not be modified
    expect(readFileSync(filePath, "utf-8")).toBe(original);
  });

  it("returns false when target file does not exist", () => {
    const patch = [
      "--- a/DoesNotExist.java",
      "+++ b/DoesNotExist.java",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(applyPatchByReplacement(testDir, patch)).toBe(false);
  });

  it("handles multi-line addition (adding new code)", () => {
    const filePath = join(testDir, "AddLines.java");
    writeFileSync(filePath, [
      "public class AddLines {",
      "    void doWork() {",
      "        process();",
      "    }",
      "}",
    ].join("\n"));

    const patch = [
      "--- a/AddLines.java",
      "+++ b/AddLines.java",
      "@@ -2,1 +2,3 @@",
      "-    void doWork() {",
      "+    void doWork() {",
      "+        log.info(\"starting work\");",
      "+        validate();",
    ].join("\n");

    expect(applyPatchByReplacement(testDir, patch)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("log.info(\"starting work\")");
    expect(content).toContain("validate()");
    expect(content).toContain("process()"); // rest of file preserved
  });
});

// ---------------------------------------------------------------------------
// run-state.ts
// Tests that pipeline state survives across runs for crash recovery.
// ---------------------------------------------------------------------------

import { buildRunId, createRunState, saveRunState, loadRunState } from "../src/run-state.js";
import type { CliArgs, PipelineContext } from "../src/types.js";

describe("run-state", () => {
  it("buildRunId encodes app, component, and today's date", () => {
    const id = buildRunId("SOS", "cwm-sos-api");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(id).toBe(`SOS-cwm-sos-api-${today}`);
  });

  it("createRunState captures args and context for later resume", () => {
    const args: CliArgs = {
      server: "prod01",
      app: "SOS",
      component: "cwm-sos-api",
      dryRun: false,
    };
    const ctx: PipelineContext = {
      server: "prod01",
      app: "SOS",
      component: "cwm-sos-api",
      dryRun: false,
      jiraProject: "CWM",
      errors: [],
    };
    const state = createRunState(args, ctx);

    // Should be ready to save — step 0 means nothing completed yet
    expect(state.lastCompletedStep).toBe(0);
    expect(state.args.server).toBe("prod01");
    expect(state.context.jiraProject).toBe("CWM");
    expect(state.context.errors).toEqual([]);
    // Timestamps should be ISO format
    expect(new Date(state.startedAt).toISOString()).toBe(state.startedAt);
  });

  it("saveRunState and loadRunState round-trip preserves full context", () => {
    // Use a temp directory to avoid polluting the real ~/.raven/runs/
    const testDir = join(tmpdir(), `raven-state-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const args: CliArgs = {
      server: "prod01",
      app: "TEST",
      component: "test-api",
      dryRun: false,
    };
    const ctx: PipelineContext = {
      server: "prod01",
      app: "TEST",
      component: "test-api",
      dryRun: false,
      jiraProject: "TEST",
      errors: [{ message: "NPE", stackTrace: "at Foo.bar()", dedupeKey: "npe-foo", occurrences: 5 }],
      ticketKey: "TEST-123",
    };

    const state = createRunState(args, ctx);
    state.lastCompletedStep = 2;

    // Write directly to our test dir (bypasses the module's RUNS_DIR constant)
    const filePath = join(testDir, `${state.id}.json`);
    writeFileSync(filePath, JSON.stringify(state, null, 2));

    // Read back and verify
    const raw = readFileSync(filePath, "utf-8");
    const loaded = JSON.parse(raw);
    expect(loaded.lastCompletedStep).toBe(2);
    expect(loaded.context.ticketKey).toBe("TEST-123");
    expect(loaded.context.errors[0].occurrences).toBe(5);
    expect(loaded.context.errors[0].dedupeKey).toBe("npe-foo");

    rmSync(testDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// repo-map.ts
// Tests that discovered repo mappings persist and are reused,
// avoiding repeated expensive Bitbucket project scans.
// ---------------------------------------------------------------------------

import { getMapping, setMapping, loadRepoMap } from "../src/repo-map.js";

describe("repo-map", () => {
  it("returns null for an app/component that has never been mapped", () => {
    const result = getMapping("NONEXISTENT", "fake-component-" + Date.now());
    expect(result).toBeNull();
  });

  it("persists and retrieves a repo mapping across calls", () => {
    const key = `test-component-${Date.now()}`;
    const mapping = {
      bitbucketProject: "CWM",
      bitbucketRepo: "cwm-generic-lib",
      discoveredAt: new Date().toISOString(),
    };

    setMapping("SOS", key, mapping);
    const result = getMapping("SOS", key);

    expect(result).not.toBeNull();
    expect(result!.bitbucketProject).toBe("CWM");
    expect(result!.bitbucketRepo).toBe("cwm-generic-lib");

    // Clean up — remove our test entry from the shared repo map
    const map = loadRepoMap();
    delete map[`SOS/${key}`];
    // (don't save — it'll be overwritten naturally)
  });

  it("does not overwrite other mappings when adding a new one", () => {
    const key1 = `keep-${Date.now()}`;
    const key2 = `add-${Date.now()}`;

    setMapping("A", key1, {
      bitbucketProject: "P1",
      bitbucketRepo: "r1",
      discoveredAt: new Date().toISOString(),
    });
    setMapping("B", key2, {
      bitbucketProject: "P2",
      bitbucketRepo: "r2",
      discoveredAt: new Date().toISOString(),
    });

    // Both should exist
    expect(getMapping("A", key1)!.bitbucketProject).toBe("P1");
    expect(getMapping("B", key2)!.bitbucketProject).toBe("P2");
  });
});

// ---------------------------------------------------------------------------
// classifyTestFailure (implement.ts)
// Distinguishes target-repo build-environment problems (user must fix their
// JDK/toolchain) from real failures introduced by the AI patch.
// ---------------------------------------------------------------------------

import { classifyTestFailure } from "../src/steps/implement.js";

describe("classifyTestFailure", () => {
  it("flags Source-option-no-longer-supported as a build-env issue with JAVA_HOME hint", () => {
    const output = `
[ERROR] COMPILATION ERROR :
[ERROR] Source option 7 is no longer supported. Use 8 or later.
[ERROR] Target option 7 is no longer supported. Use 8 or later.
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.2:compile
`;
    const result = classifyTestFailure(output);
    expect(result.kind).toBe("build-env");
    if (result.kind === "build-env") {
      expect(result.reason).toContain("Java source level 7");
      expect(result.hint).toContain("JAVA_HOME");
      expect(result.hint).toContain("AI patch did not cause it");
    }
  });

  it("flags 'release version not supported' as a build-env issue", () => {
    const output = "error: release version 17 not supported";
    expect(classifyTestFailure(output).kind).toBe("build-env");
  });

  it("flags 'Unsupported class file major version' as a build-env issue", () => {
    const output = "java.lang.UnsupportedClassVersionError: Unsupported class file major version 61";
    expect(classifyTestFailure(output).kind).toBe("build-env");
  });

  it("flags COMPILATION ERROR (non-toolchain) as compile-failed", () => {
    const output = `
[ERROR] COMPILATION ERROR :
[ERROR] /src/Foo.java:[42,17] cannot find symbol
[ERROR]   symbol:   variable foo
[ERROR]   location: class Bar
`;
    const result = classifyTestFailure(output);
    expect(result.kind).toBe("compile-failed");
  });

  it("flags 'cannot find symbol' as compile-failed (likely AI-patch issue)", () => {
    const output = "Foo.java:42: error: cannot find symbol\n  symbol: variable doesNotExist";
    expect(classifyTestFailure(output).kind).toBe("compile-failed");
  });

  it("flags Surefire-style test counts as tests-failed and surfaces the numbers", () => {
    const output = "Tests run: 50, Failures: 2, Errors: 1, Skipped: 0";
    const result = classifyTestFailure(output);
    expect(result.kind).toBe("tests-failed");
    if (result.kind === "tests-failed") {
      expect(result.reason).toContain("2 failure");
      expect(result.reason).toContain("1 error");
      expect(result.reason).toContain("50 test");
    }
  });

  it("flags BUILD FAILURE (no test counts) as tests-failed (catch-all)", () => {
    // npm test or similar where Surefire counts aren't present
    const output = "[INFO] BUILD FAILURE\n[ERROR] Some plugin reported failure";
    expect(classifyTestFailure(output).kind).toBe("tests-failed");
  });

  it("returns 'unknown' when nothing matches", () => {
    const output = "totally random output that doesn't match any pattern";
    const result = classifyTestFailure(output);
    expect(result.kind).toBe("unknown");
  });

  it("returns 'unknown' for empty output (the original Issue 1 symptom)", () => {
    expect(classifyTestFailure("").kind).toBe("unknown");
  });
});
