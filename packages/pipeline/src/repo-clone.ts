import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { BitbucketClient } from "@nrs/bitbucket-mcp/client";

export const CLONE_BASE = join(homedir(), ".raven", "repos");

/**
 * Throw if `repoDir` is not inside CLONE_BASE. Defense-in-depth before any
 * destructive git command (`reset --hard`, `clean -fd`) — protects against
 * a future code path that ever feeds an absolute path computed elsewhere
 * (e.g., a relative ctx.repoPath leaking through) into a `cwd: repoDir`
 * call. Without this guard, a misconfigured run could `git reset --hard`
 * the operator's actual working tree.
 */
export function assertInsideCloneBase(repoDir: string): void {
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
export function assertHttpsUrl(url: string, label: string): void {
  if (!url.startsWith("https://")) {
    throw new Error(`Refusing git operation with non-https ${label} URL: ${url.slice(0, 60)}…`);
  }
}

/** Detect whether the repo's default branch is main or master. */
export function detectDefaultBranch(repoDir: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: check if main exists, otherwise master
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
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
 * Build an authenticated clone URL by embedding ATLASSIAN credentials.
 * The credentials are read from env vars set by loadEnv().
 */
export function buildAuthUrl(cloneUrl: string): string {
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

/**
 * Clone or update CLONE_BASE/<project>/<repo> and leave the requested
 * branch (or the repo's default branch) checked out and up to date.
 * Returns the repo directory. Credential handling: auth URL used only for
 * the network operation, then scrubbed from the remote; error messages
 * are scrubbed too.
 */
export function ensureRepoClone(
  client: BitbucketClient,
  project: string,
  repo: string,
  branch?: string,
): string {
  const repoDir = join(CLONE_BASE, project, repo);
  const cloneUrl = client.getCloneUrl(project, repo);
  if (!existsSync(join(repoDir, ".git"))) {
    const authUrl = buildAuthUrl(cloneUrl);
    assertHttpsUrl(cloneUrl, "clone");
    assertHttpsUrl(authUrl, "auth");
    mkdirSync(join(CLONE_BASE, project), { recursive: true });
    try {
      execFileSync("git", ["clone", "--", authUrl, repoDir], { stdio: "pipe", timeout: 120_000 });
    } catch (e) {
      const msg = (e as Error).message.replace(/\/\/[^@]+@/g, "//***@");
      throw new Error(`git clone failed for ${project}/${repo}: ${msg}`);
    }
    execFileSync("git", ["remote", "set-url", "origin", cloneUrl], { cwd: repoDir, stdio: "pipe" });
    if (branch) {
      execFileSync("git", ["checkout", branch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    }
  } else {
    const baseBranch = branch ?? detectDefaultBranch(repoDir);
    execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    execFileSync("git", ["checkout", baseBranch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
    execFileSync("git", ["pull", "origin", baseBranch], { cwd: repoDir, stdio: "pipe", timeout: 60_000 });
  }
  return repoDir;
}
