import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { BitbucketClient } from "@nrs/bitbucket-mcp/client";
import { startSpinner, stopSpinner } from "../spinner.js";
import type { PipelineContext } from "../types.js";

const CLONE_BASE = join(homedir(), ".raven", "repos");

/**
 * Throw if `repoDir` is not inside CLONE_BASE. Defense-in-depth before any
 * destructive git command (`reset --hard`, `clean -fd`) — protects against
 * a future code path that ever feeds an absolute path computed elsewhere
 * (e.g., a relative ctx.repoPath leaking through) into a `cwd: repoDir`
 * call. Without this guard, a misconfigured run could `git reset --hard`
 * the operator's actual working tree.
 */
function assertInsideCloneBase(repoDir: string): void {
  const r = resolve(repoDir);
  const base = resolve(CLONE_BASE);
  if (r !== base && !r.startsWith(base + sep)) {
    throw new Error(
      `Refusing destructive git operation: repoDir "${repoDir}" is not under CLONE_BASE "${CLONE_BASE}"`,
    );
  }
}

/**
 * Assert a URL is an `https://` URL before passing it as a git argument.
 * Defends against second-order command injection through git's flag
 * parsing — even with execFileSync (no shell), git itself parses argv
 * and would interpret a positional arg starting with `--` as a flag.
 * The exploit is `git clone --upload-pack=evil-cmd`, which makes git
 * run `evil-cmd` on the remote side. Forcing `https://` rules out any
 * `--`-prefixed positional and any non-https scheme.
 *
 * Bitbucket clone URLs from `bitbucketClient.getCloneUrl()` are always
 * `https://...` in this codebase, so the assertion is a no-op in
 * normal use; it's here for static-analysis (CodeQL) data-flow proof
 * and defense-in-depth.
 */
function assertHttpsUrl(url: string, label: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing git operation with non-https ${label} URL: ${url.slice(0, 60)}…`);
  }
}

/**
 * Step 4: IMPLEMENT — Clone repo, create branch, apply fix, run tests, commit.
 */
export async function implement(
  ctx: PipelineContext,
  bitbucketClient: BitbucketClient
): Promise<void> {
  if (!ctx.fixPlan?.patch || !ctx.ticketKey) {
    console.log("[IMPLEMENT] No fix plan or ticket — skipping");
    return;
  }

  if (ctx.dryRun) {
    console.log("[IMPLEMENT] DRY RUN — would apply patch and run tests");
    return;
  }

  // Use the repo where the fix was found (may differ from the app repo)
  const project = ctx.sourceProject ?? ctx.bitbucketProject ?? ctx.app;
  const repo = ctx.sourceRepo ?? ctx.bitbucketRepo ?? ctx.component;
  const repoDir = join(CLONE_BASE, project, repo);
  console.log(`[IMPLEMENT] Target repo: ${project}/${repo}`);

  // Clone or update repo. Use execFileSync (argv form, no shell) for any
  // call that includes user-derived strings: the auth URL contains the
  // ATLASSIAN_PASSWORD, branch names come from triage AI output (sanitized
  // but defense in depth), default branch comes from `git symbolic-ref`
  // output. No shell metacharacters can affect interpretation when the
  // arguments are passed as an array.
  if (!existsSync(join(repoDir, ".git"))) {
    console.log(`[IMPLEMENT] Cloning ${project}/${repo}...`);
    const cloneUrl = bitbucketClient.getCloneUrl(project, repo);
    const authUrl = buildAuthUrl(cloneUrl);
    assertHttpsUrl(cloneUrl, "clone");
    assertHttpsUrl(authUrl, "auth");
    mkdirSync(join(CLONE_BASE, project), { recursive: true });
    try {
      startSpinner(`Cloning ${project}/${repo}...`);
      // `--` terminates option parsing — defense-in-depth even though
      // assertHttpsUrl already guarantees authUrl can't be parsed as a flag.
      execFileSync("git", ["clone", "--", authUrl, repoDir], {
        stdio: "pipe",
        timeout: 120_000,
      });
      stopSpinner();
    } catch (e) {
      stopSpinner();
      // Scrub credentials from error message before re-throwing
      const msg = (e as Error).message.replace(/\/\/[^@]+@/g, "//***@");
      throw new Error(`git clone failed for ${project}/${repo}: ${msg}`);
    }
    // Replace the stored origin URL with the non-auth version to avoid leaking credentials
    execFileSync("git", ["remote", "set-url", "origin", cloneUrl], {
      cwd: repoDir,
      stdio: "pipe",
    });
  } else {
    console.log(`[IMPLEMENT] Updating existing clone at ${repoDir}`);
    // Detect default branch (main or master) and update it.
    const defaultBranch = detectDefaultBranch(repoDir);
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    execFileSync("git", ["checkout", defaultBranch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    execFileSync("git", ["pull", "origin", defaultBranch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
  }

  // Create branch
  const ticketLower = ctx.ticketKey.toLowerCase();
  const description = (ctx.triageResult?.suggestedTitle ?? "fix")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");
  ctx.branchName = `bugfix/${ticketLower}-${description}`;

  // Check if branch already exists (from a previous run)
  try {
    execFileSync("git", ["rev-parse", "--verify", ctx.branchName], { cwd: repoDir, stdio: "pipe" });
    console.log(`[IMPLEMENT] Branch ${ctx.branchName} already exists — reusing`);
    execFileSync("git", ["checkout", ctx.branchName], { cwd: repoDir, stdio: "pipe" });
    // Check if the fix is already applied
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" }).trim();
    if (status === "") {
      const lastMsg = execFileSync("git", ["log", "--oneline", "-1"], { cwd: repoDir, encoding: "utf-8" }).trim();
      console.log(`[IMPLEMENT] Branch already has commit: ${lastMsg}`);
      ctx.commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();
      ctx.repoPath = repoDir;
      if (ctx.skipTests) {
        console.log("[IMPLEMENT] Skipping tests (--skip-tests)");
        ctx.testsPass = true;
      } else {
        console.log("[IMPLEMENT] Running tests on existing branch...");
        ctx.testsPass = runTests(repoDir);
      }
      return;
    }
    // Branch exists but is dirty — likely a previous run was interrupted
    // between patch application and commit. Reset working tree (and any
    // staged changes) before applying the new patch, otherwise the new
    // diff would land on top of leftover edits and produce a corrupt or
    // duplicated fix. The CLONE_BASE guard above is the safety net that
    // ensures this destructive operation can never run outside the
    // pipeline-managed clone directory.
    console.log(`[IMPLEMENT] Branch has uncommitted changes from a prior run — resetting to clean state`);
    assertInsideCloneBase(repoDir);
    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["clean", "-fd"], { cwd: repoDir, stdio: "pipe" });
  } catch {
    console.log(`[IMPLEMENT] Creating branch: ${ctx.branchName}`);
    execFileSync("git", ["checkout", "-b", ctx.branchName], { cwd: repoDir, stdio: "pipe" });
  }

  // Apply patch — try git apply first, fall back to line-level replacement
  const patchPath = join(repoDir, ".raven-patch.diff");
  writeFileSync(patchPath, ctx.fixPlan.patch);

  let patchApplied = false;
  try {
    // Strategy 1: git apply (strict, then fuzzy). Pass extra args as
    // separate array elements (no shell). The literal flag strings are
    // hard-coded so they wouldn't be exploitable, but consistency >
    // exception-cases.
    for (const extraArgs of [[], ["--ignore-whitespace"], ["--ignore-whitespace", "-C1"]]) {
      try {
        execFileSync("git", ["apply", "--check", ...extraArgs, patchPath], { cwd: repoDir, stdio: "pipe" });
        execFileSync("git", ["apply", ...extraArgs, patchPath], { cwd: repoDir, stdio: "pipe" });
        console.log(`[IMPLEMENT] Patch applied via git apply`);
        patchApplied = true;
        break;
      } catch { /* try next */ }
    }

    // Strategy 2: Parse the diff and apply changes as text replacements
    if (!patchApplied) {
      console.log(`[IMPLEMENT] git apply failed — trying line-level replacement`);
      patchApplied = applyPatchByReplacement(repoDir, ctx.fixPlan.patch);
    }

    if (!patchApplied) throw new Error("Could not apply patch");
  } catch (error) {
    console.log(`[IMPLEMENT] Patch failed to apply: ${(error as Error).message}`);
    const defBranch = detectDefaultBranch(repoDir);
    execFileSync("git", ["checkout", defBranch], { cwd: repoDir, stdio: "pipe" });
    if (ctx.branchName) {
      execFileSync("git", ["branch", "-D", ctx.branchName], { cwd: repoDir, stdio: "pipe" });
    }
    ctx.branchName = undefined;
    return;
  } finally {
    try { unlinkSync(patchPath); } catch { /* ignore */ }
  }

  // Run tests
  if (ctx.skipTests) {
    console.log("[IMPLEMENT] Skipping tests (--skip-tests)");
    ctx.testsPass = true;
  } else {
    console.log("[IMPLEMENT] Running tests...");
    ctx.testsPass = runTests(repoDir);
  }

  if (!ctx.testsPass) {
    console.log("[IMPLEMENT] Tests failed — branch preserved for manual review");
  }

  // Commit. execFileSync's argv form accepts the commit message verbatim —
  // no shell, no shellEscape needed, no risk of metacharacter injection
  // even when the AI-derived `summary` or `proposedFix` contains quotes,
  // backticks, or newlines.
  const testNote = ctx.skipTests ? "\n\nNote: Tests skipped (--skip-tests) — requires CI/CD validation." : "";
  const commitMessage = `${ctx.ticketKey} Fix ${ctx.triageResult?.summary ?? "production error"}\n\n${ctx.fixPlan.proposedFix}${testNote}`;
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", commitMessage], { cwd: repoDir, stdio: "pipe" });

  ctx.commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf-8",
  }).trim();

  ctx.repoPath = repoDir;
  console.log(`[IMPLEMENT] Committed: ${ctx.commitHash.slice(0, 8)}`);
}

/**
 * Classify a failed `mvn` / `npm test` run by inspecting its captured output.
 * Lets the IMPLEMENT step distinguish a target-repo build environment problem
 * from an actual test regression caused by the AI's patch.
 *
 * Exported for unit testing.
 */
export type TestRunFailure =
  | { kind: "build-env"; reason: string; hint: string }
  | { kind: "compile-failed"; reason: string }
  | { kind: "tests-failed"; reason: string }
  | { kind: "unknown"; reason: string };

export function classifyTestFailure(output: string): TestRunFailure {
  // Java source-level mismatch — local JDK doesn't support the project's
  // declared <source>/<target>. NOT an AI-patch issue; user needs to point
  // JAVA_HOME (or a Maven toolchain) at a JDK that supports the level.
  const sourceLevelMatch = output.match(/Source option (\d+(?:\.\d+)?) is no longer supported/);
  if (sourceLevelMatch) {
    return {
      kind: "build-env",
      reason: `Project requires Java source level ${sourceLevelMatch[1]}, but the local JDK no longer supports it.`,
      hint: `Set JAVA_HOME to a JDK that supports source ${sourceLevelMatch[1]} (e.g., JDK 8 for source 1.7), or configure a Maven toolchain in ~/.m2/toolchains.xml. This is a build-environment issue, not a code issue — the AI patch did not cause it.`,
    };
  }
  // Other Java-version mismatches (e.g., target option, release, --release)
  if (/release version \d+ not supported|Target option \d+(?:\.\d+)? is no longer supported|Unsupported class file major version/i.test(output)) {
    return {
      kind: "build-env",
      reason: "Java toolchain mismatch between project and local JDK.",
      hint: "Check the project's pom.xml <source>/<target> against your JAVA_HOME. The AI patch did not cause this.",
    };
  }
  // Compile failure (most likely the AI patch broke the build syntactically)
  if (/COMPILATION ERROR|cannot find symbol|cannot resolve symbol|package .* does not exist/i.test(output)) {
    return {
      kind: "compile-failed",
      reason: "Project failed to compile after the patch was applied. The AI-generated diff may be syntactically invalid or reference symbols that don't exist.",
    };
  }
  // Test failure (build succeeded, tests ran, some failed)
  const testCountsMatch = output.match(/Tests run:\s*(\d+),?\s*Failures:\s*(\d+),?\s*Errors:\s*(\d+)/i);
  if (testCountsMatch) {
    const [, run, fail, err] = testCountsMatch;
    return {
      kind: "tests-failed",
      reason: `${fail} failure(s), ${err} error(s) out of ${run} test(s) run.`,
    };
  }
  if (/BUILD FAILURE/i.test(output)) {
    return {
      kind: "tests-failed",
      reason: "Build failed after compile — likely a test failure or Surefire/Failsafe error.",
    };
  }
  return { kind: "unknown", reason: "Could not classify failure from captured output." };
}

/** Detect project type and run tests. Returns true if tests pass. */
function runTests(repoDir: string): boolean {
  startSpinner("Running tests...");
  try {
    if (existsSync(join(repoDir, "pom.xml"))) {
      // Skip integration tests — they typically need live infrastructure (WCC, DB, etc.)
      // Unit tests only; integration tests belong in the CI/CD pipeline
      execSync("mvn test -q -DskipITs -Dmaven.test.failure.ignore=false", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 300_000,
      });
    } else if (existsSync(join(repoDir, "package.json"))) {
      execSync("npm test", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 120_000,
      });
    } else {
      stopSpinner();
      console.log("[IMPLEMENT] No recognized build system — skipping tests");
    }
    stopSpinner();
    return true;
  } catch (e) {
    stopSpinner();
    // `Buffer.toString()` on an empty buffer returns "" — which is NOT
    // nullish, so `??` would stop the chain there. Use `||` so empty
    // strings fall through to the next source.
    const stderr = (e as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString() || "";
    const stdout = (e as { stderr?: Buffer; stdout?: Buffer }).stdout?.toString() || "";
    const output = stderr || stdout || (e as Error).message || "(no output captured)";

    const failure = classifyTestFailure(output);
    switch (failure.kind) {
      case "build-env":
        console.log(`[IMPLEMENT] Build environment problem: ${failure.reason}`);
        console.log(`[IMPLEMENT] Hint: ${failure.hint}`);
        break;
      case "compile-failed":
        console.log(`[IMPLEMENT] Compile failed: ${failure.reason}`);
        break;
      case "tests-failed":
        console.log(`[IMPLEMENT] Tests failed: ${failure.reason}`);
        break;
      case "unknown":
        console.log(`[IMPLEMENT] Test run failed (could not classify):`);
        break;
    }
    // Always show the last 15 non-blank lines of output for diagnostics —
    // helps a reviewer see what actually went wrong without re-running.
    const tail = output.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n");
    if (tail) console.log(`[IMPLEMENT] Output tail:\n${tail}`);
    return false;
  }
}

/**
 * Wrap a string for safe shell injection. NOT used by IMPLEMENT itself
 * any more — every git invocation uses execFileSync's argv form, which
 * doesn't go through a shell. Kept exported because the test suite
 * locks in its behavior as a security-relevant utility, and the
 * function is still useful if a future caller needs a single-shell-arg
 * helper.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Detect whether the repo's default branch is main or master. */
function detectDefaultBranch(repoDir: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: check if main exists, otherwise master
    try {
      execSync("git rev-parse --verify origin/main", {
        cwd: repoDir,
        stdio: "pipe",
      });
      return "main";
    } catch {
      return "master";
    }
  }
}

/**
 * Apply a unified diff by parsing -/+ lines and doing text replacement on files.
 * More robust than git apply for AI-generated patches with whitespace issues.
 */
export function applyPatchByReplacement(repoDir: string, patch: string): boolean {
  const lines = patch.split("\n");
  let currentFile: string | null = null;
  // Each hunk line: type ('-', '+', or ' ' for context) and text
  let hunkLines: Array<{ type: string; text: string }> = [];
  let anyApplied = false;

  const flushChanges = () => {
    if (!currentFile || hunkLines.length === 0) return;
    // Path traversal prevention: reject paths that escape the repo directory
    const filePath = resolve(repoDir, currentFile);
    if (!filePath.startsWith(resolve(repoDir) + "/")) {
      console.log(`[IMPLEMENT] Path traversal blocked: ${currentFile}`);
      return;
    }
    if (!existsSync(filePath)) {
      console.log(`[IMPLEMENT] File not found: ${filePath}`);
      return;
    }

    // Build the "old" lines (context + removals) and "new" lines (context + additions)
    const oldLines = hunkLines.filter(l => l.type === "-" || l.type === " ").map(l => l.text.trim());
    const newLineEntries = hunkLines.filter(l => l.type === "+" || l.type === " ");

    if (oldLines.length === 0) return;

    const content = readFileSync(filePath, "utf-8");
    const fileLines = content.split("\n");

    // Find ALL candidate positions where the old lines match
    const candidates: number[] = [];
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      let matches = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (fileLines[i + j]!.trim() !== oldLines[j]) {
          matches = false;
          break;
        }
      }
      if (matches) candidates.push(i);
    }

    if (candidates.length === 0) {
      // Fall back: try matching only the removal lines (no context)
      const removalOnly = hunkLines.filter(l => l.type === "-").map(l => l.text.trim());
      if (removalOnly.length > 0 && removalOnly.length < oldLines.length) {
        for (let i = 0; i <= fileLines.length - removalOnly.length; i++) {
          let matches = true;
          for (let j = 0; j < removalOnly.length; j++) {
            if (fileLines[i + j]!.trim() !== removalOnly[j]) {
              matches = false;
              break;
            }
          }
          if (matches) candidates.push(i);
        }
        if (candidates.length > 0) {
          // Use removal-only match — splice only those lines
          const matchStart = candidates[0]!;
          const indent = fileLines[matchStart]!.match(/^(\s*)/)?.[1] ?? "";
          const additionLines = hunkLines.filter(l => l.type === "+").map(l => indent + l.text.trim());
          fileLines.splice(matchStart, removalOnly.length, ...additionLines);
          writeFileSync(filePath, fileLines.join("\n"));
          console.log(`[IMPLEMENT] Applied replacement in ${currentFile} at line ${matchStart + 1} (removal-only match)`);
          anyApplied = true;
          return;
        }
      }
      console.log(`[IMPLEMENT] Could not find matching lines in ${currentFile}`);
      return;
    }

    // Pick the best candidate — if only one, use it; if multiple, use the one
    // closest to the line number hint from the @@ header (if available)
    const matchStart = candidates.length === 1 ? candidates[0]! : pickBestCandidate(candidates, lastHunkLineNum);
    console.log(`[IMPLEMENT] Matched at line ${matchStart + 1}${candidates.length > 1 ? ` (${candidates.length} candidates)` : ""}`);

    // Build the replacement lines, preserving indentation from the original file.
    // Walk through the hunk lines in order, tracking which original file line
    // each context/removal line corresponds to.
    const newLines: string[] = [];
    let origIdx = matchStart; // tracks position in original file
    // Track the last context/removal line's patch indent vs file indent for reference
    let lastRefPatchIndent = 0;
    let lastRefFileIndent = 0;
    for (const hl of hunkLines) {
      if (hl.type === " ") {
        // Context line — keep the original file line exactly as-is
        newLines.push(fileLines[origIdx]!);
        // Update indent reference
        const patchTrimmed = hl.text.trimStart();
        lastRefPatchIndent = hl.text.length - patchTrimmed.length;
        const fileIndentMatch = fileLines[origIdx]!.match(/^(\s*)/);
        lastRefFileIndent = fileIndentMatch ? fileIndentMatch[1]!.length : 0;
        origIdx++;
      } else if (hl.type === "-") {
        // Removal — update indent reference but don't add to output
        const patchTrimmed = hl.text.trimStart();
        lastRefPatchIndent = hl.text.length - patchTrimmed.length;
        const fileIndentMatch = fileLines[origIdx]!.match(/^(\s*)/);
        lastRefFileIndent = fileIndentMatch ? fileIndentMatch[1]!.length : 0;
        origIdx++;
      } else if (hl.type === "+") {
        // Addition — compute indent relative to the nearest context/removal line
        const patchTrimmed = hl.text.trimStart();
        if (patchTrimmed.length === 0) {
          newLines.push("");
        } else {
          const patchIndent = hl.text.length - patchTrimmed.length;
          const relativeIndent = patchIndent - lastRefPatchIndent;
          // Detect file's indent character (tab vs space) from the reference line
          const refFileLine = fileLines[Math.min(origIdx, matchStart + oldLines.length - 1, fileLines.length - 1)]!;
          const fileIndentStr = refFileLine.match(/^(\s*)/)?.[1] ?? "";
          const useTabs = fileIndentStr.includes("\t");
          if (relativeIndent === 0) {
            // Same indent level as reference — use the file's indent exactly
            newLines.push(fileIndentStr + patchTrimmed);
          } else if (useTabs) {
            // Tab-indented file: convert relative indent to tab units
            // Estimate spaces-per-tab from the patch (common: 4 or 2)
            const tabWidth = estimateTabWidth(hunkLines);
            const tabDelta = Math.round(relativeIndent / tabWidth);
            if (tabDelta >= 0) {
              newLines.push(fileIndentStr + "\t".repeat(tabDelta) + patchTrimmed);
            } else {
              // Dedent: remove tabs from the end of the indent
              const trimTabs = Math.min(Math.abs(tabDelta), fileIndentStr.length);
              newLines.push(fileIndentStr.slice(0, -trimTabs) + patchTrimmed);
            }
          } else {
            // Space-indented file
            const fileIndent = Math.max(0, lastRefFileIndent + relativeIndent);
            newLines.push(" ".repeat(fileIndent) + patchTrimmed);
          }
        }
      }
    }
    fileLines.splice(matchStart, oldLines.length, ...newLines);
    writeFileSync(filePath, fileLines.join("\n"));
    console.log(`[IMPLEMENT] Applied replacement in ${currentFile} at line ${matchStart + 1}`);
    anyApplied = true;
  };

  let lastHunkLineNum = 0;
  for (const line of lines) {
    // Parse file path from --- a/path or +++ b/path
    const fileMatch = line.match(/^---\s+a\/(.+)/);
    if (fileMatch) {
      flushChanges();
      currentFile = fileMatch[1]!;
      hunkLines = [];
      lastHunkLineNum = 0;
      continue;
    }
    if (line.startsWith("+++ b/")) continue;
    if (line.startsWith("diff --git")) continue;

    // Parse @@ line for line number hint
    const hhMatch = line.match(/^@@\s+-(\d+)/);
    if (hhMatch) {
      // Flush previous hunk if any, start new one
      flushChanges();
      hunkLines = [];
      lastHunkLineNum = parseInt(hhMatch[1]!, 10);
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      hunkLines.push({ type: "-", text: line.slice(1) });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      hunkLines.push({ type: "+", text: line.slice(1) });
    } else if (!line.startsWith("\\")) {
      // Context line (starts with space or is plain text)
      hunkLines.push({ type: " ", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  flushChanges();
  return anyApplied;
}

/** Estimate tab width from patch lines by looking at indentation increments. */
function estimateTabWidth(hunkLines: Array<{ type: string; text: string }>): number {
  const indents: number[] = [];
  for (const hl of hunkLines) {
    if (hl.type === " " || hl.type === "-") {
      const trimmed = hl.text.trimStart();
      if (trimmed.length > 0) {
        indents.push(hl.text.length - trimmed.length);
      }
    }
  }
  if (indents.length < 2) return 4; // default
  // Find the most common non-zero difference between consecutive indents
  const diffs: number[] = [];
  for (let i = 1; i < indents.length; i++) {
    const d = Math.abs(indents[i]! - indents[i - 1]!);
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 4;
  // Return the smallest common diff (likely the tab width)
  diffs.sort((a, b) => a - b);
  return diffs[0]!;
}

/**
 * Pick the best match position when multiple candidates exist.
 *
 * Uses the `@@ -N` line-number hint from the diff hunk header to pick the
 * candidate closest to where the AI said the change should land. Files
 * with repeated identical hunks (e.g., the same null-check across
 * multiple methods) previously always patched the first match, sometimes
 * modifying the wrong method.
 *
 * `hunkLineHint` is 1-based (as printed by `@@`); `candidates` are
 * 0-based indices into the file's line array.
 */
function pickBestCandidate(candidates: number[], hunkLineHint: number): number {
  if (hunkLineHint <= 0) return candidates[0]!;
  // Find the candidate whose 0-based index is closest to (hint - 1).
  const targetIdx = hunkLineHint - 1;
  let best = candidates[0]!;
  let bestDist = Math.abs(best - targetIdx);
  for (const c of candidates.slice(1)) {
    const d = Math.abs(c - targetIdx);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Build an authenticated clone URL by embedding ATLASSIAN credentials.
 * The credentials are read from env vars set by loadEnv().
 */
function buildAuthUrl(cloneUrl: string): string {
  const email = process.env["ATLASSIAN_EMAIL"];
  const password = process.env["ATLASSIAN_PASSWORD"];
  if (!email || !password) return cloneUrl;

  try {
    const url = new URL(cloneUrl);
    // URL.username / URL.password setters already percent-encode reserved
    // characters. Pre-encoding here would double-encode an email username
    // (e.g., user@example.com → user%2540example.com) and break git clone.
    url.username = email;
    url.password = password;
    return url.toString();
  } catch {
    return cloneUrl;
  }
}

export function inferRepoSlug(component: string): string {
  const prefix = component.split("-")[0];
  return prefix ? `nr-${prefix}` : component;
}
