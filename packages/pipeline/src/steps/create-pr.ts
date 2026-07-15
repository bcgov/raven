import { execSync, execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { BitbucketClient } from "@nrs/bitbucket-mcp/client";
import type { JiraClient } from "@nrs/jira-mcp/client";
import { startSpinner, stopSpinner } from "../spinner.js";
import type { PipelineContext } from "../types.js";

const CLONE_BASE = join(homedir(), ".raven", "repos");

/**
 * Defense-in-depth check: refuse to run git operations against a path
 * that isn't inside the pipeline-managed clone directory. Mirrors the
 * guard in implement.ts. Catches scenarios where ctx.repoPath could
 * point somewhere unexpected (e.g., relative path from a future bug,
 * stale state from --resume, etc.).
 */
function assertInsideCloneBase(repoPath: string): void {
  const r = resolve(repoPath);
  const base = resolve(CLONE_BASE);
  if (r !== base && !r.startsWith(base + sep)) {
    throw new Error(
      `Refusing CREATE-PR git operation: repoPath "${repoPath}" is not under CLONE_BASE "${CLONE_BASE}"`,
    );
  }
}

/**
 * Force every URL passed to a git command to be `https://`-prefixed.
 * Defends against second-order command injection — git parses positional
 * args for `--`-prefixed flags (e.g., `--upload-pack=evil-cmd`), and
 * execFileSync's no-shell guarantee doesn't help once the string reaches
 * git's own argv parser. Same pattern used in implement.ts.
 */
function assertHttpsUrl(url: string, label: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing git operation with non-https ${label} URL: ${url.slice(0, 60)}…`);
  }
}

/**
 * Step 5: CREATE PR — Push branch to Bitbucket and create a pull request.
 */
export async function createPr(
  ctx: PipelineContext,
  bitbucketClient: BitbucketClient,
  jiraClient: JiraClient
): Promise<void> {
  if (!ctx.branchName || !ctx.repoPath || !ctx.ticketKey) {
    console.log("[CREATE-PR] No branch or repo — skipping");
    return;
  }

  // Anchor every git op below at the pipeline-managed clone path.
  assertInsideCloneBase(ctx.repoPath);

  if (ctx.testsPass === false) {
    console.log("[CREATE-PR] Tests failed — skipping PR creation. Fix tests and re-run.");
    return;
  }

  if (ctx.dryRun) {
    console.log("[CREATE-PR] DRY RUN — would push branch and create PR");
    return;
  }

  // Use the repo where the fix was applied
  const project = ctx.sourceProject ?? ctx.bitbucketProject ?? ctx.app;
  const repo = ctx.sourceRepo ?? ctx.bitbucketRepo ?? ctx.component;

  // Push branch — temporarily set auth URL for push, then restore. Use
  // execFileSync (argv form, no shell) — auth URL contains the password
  // and branch name comes from triage AI output.
  console.log(`[CREATE-PR] Pushing ${ctx.branchName}...`);
  const cloneUrl = bitbucketClient.getCloneUrl(project, repo);
  const authUrl = buildAuthUrl(cloneUrl);
  assertHttpsUrl(cloneUrl, "clone");
  assertHttpsUrl(authUrl, "auth");
  execFileSync("git", ["remote", "set-url", "--push", "origin", authUrl], {
    cwd: ctx.repoPath,
    stdio: "pipe",
  });
  try {
    startSpinner("Pushing branch to Bitbucket...");
    execFileSync("git", ["push", "-u", "origin", ctx.branchName], {
      cwd: ctx.repoPath,
      stdio: "pipe",
      timeout: 60_000,
    });
    stopSpinner();
  } finally {
    // Restore non-auth URL to avoid leaking credentials
    execFileSync("git", ["remote", "set-url", "--push", "origin", cloneUrl], {
      cwd: ctx.repoPath,
      stdio: "pipe",
    });
  }

  // Create PR
  const testStatus = ctx.skipTests
    ? "Tests skipped (--skip-tests) — requires CI/CD validation."
    : ctx.testsPass ? "All tests passing." : "**Tests failing** — manual review required.";
  const prDescription =
    `## ${ctx.ticketKey}\n\n` +
    `### Root Cause\n${ctx.triageResult?.rootCause ?? "See ticket for details."}\n\n` +
    `### Fix\n${ctx.fixPlan?.proposedFix ?? "See diff."}\n\n` +
    `### Test Status\n${testStatus}\n\n` +
    `---\n_Created by RAVEN Autonomous Pipeline_`;

  // Detect default branch from the local clone
  const defaultBranch = detectDefaultBranch(ctx.repoPath!);

  // Cap the PR title at 200 chars. AI-generated `suggestedTitle` can run
  // long; some Bitbucket installs reject very long titles outright, and
  // even when accepted they render badly in lists.
  const rawTitle = `${ctx.ticketKey} - ${ctx.triageResult?.suggestedTitle ?? "Fix production error"}`;
  const title = rawTitle.length > 200 ? rawTitle.slice(0, 197) + "..." : rawTitle;

  const pr = await bitbucketClient.createPullRequest(project, repo, {
    title,
    description: prDescription,
    fromBranch: ctx.branchName,
    toBranch: defaultBranch,
  });

  // Honest fallback when the API response doesn't include a self-link:
  // don't post `PR #N` as if it were a URL into Jira — make it explicit
  // that the link is unavailable so a reader doesn't try to click it.
  const prHref = pr.links?.self?.[0]?.href;
  const prLink = prHref ?? `PR #${pr.id} (link unavailable in API response)`;
  ctx.prUrl = prLink;
  console.log(`[CREATE-PR] Pull request created: ${prLink}`);

  // Add PR link as Jira comment
  await jiraClient.addComment(
    ctx.ticketKey,
    `[RAVEN Pipeline] Pull request created: ${prLink}\n\nBranch: ${ctx.branchName}\nTests: ${ctx.testsPass ? "passing" : "failing"}`
  );
  console.log(`[CREATE-PR] Added PR link to ${ctx.ticketKey}`);
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
 * Build an authenticated URL by embedding ATLASSIAN credentials.
 */
function buildAuthUrl(cloneUrl: string): string {
  const email = process.env["ATLASSIAN_EMAIL"];
  const password = process.env["ATLASSIAN_PASSWORD"];
  if (!email || !password) return cloneUrl;

  try {
    const url = new URL(cloneUrl);
    // URL.username / URL.password setters already percent-encode reserved
    // characters. Pre-encoding here would double-encode an email username
    // (e.g., user@example.com → user%2540example.com) and break git push.
    url.username = email;
    url.password = password;
    return url.toString();
  } catch {
    return cloneUrl;
  }
}

