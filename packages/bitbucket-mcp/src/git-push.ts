import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Injectable git runner for tests. Throws on a non-zero exit; the thrown
 * error's message should carry git's stderr. `env` entries are ADDED to the
 * process environment for that invocation only.
 */
export type GitExec = (
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs: number }
) => string;

const PUSH_TIMEOUT_MS = 300_000; // 5 minutes, same ceiling as clone_repo

/** Branch names we accept: git-valid, and never option- or refspec-shaped. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const defaultExec: GitExec = (args, opts) =>
  execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });

export interface PushRepoOptions {
  /** Absolute path to the local repository's top-level directory. */
  dir: string;
  /** Branch to push; defaults to the currently checked-out branch. */
  branch?: string;
  /** Remote name; default "origin". */
  remote?: string;
  /**
   * Host (hostname[:port]) the remote URL must resolve to. The push injects
   * credentials, so a remote on any other host is refused — both to keep
   * the credentials from leaking to a foreign server and to keep a poisoned
   * remote from receiving ministry code.
   */
  expectedHost: string;
  /** Value for git's http.extraHeader (e.g. "Authorization: Basic ..."). */
  authHeader: string;
  /** Injectable git runner (tests). */
  exec?: GitExec;
}

export interface PushRepoResult {
  branch: string;
  remote: string;
  /** Remote URL with any embedded userinfo removed. */
  remoteUrl: string;
  /** git's own push summary (stderr text). */
  output: string;
  setUpstream: boolean;
}

/**
 * Push one local branch to the configured Bitbucket host.
 *
 * Guards, in order: `dir` must be an absolute path to the top level of a
 * git worktree (not a subdirectory — pushing a parent repo by surprise is
 * an easy mistake); the branch and remote names must be plain (no leading
 * "-", no "+", no ":", so no force-push refspec can be smuggled in); the
 * remote's push URL must be HTTPS on `expectedHost`. The refspec is always
 * the explicit non-forcing `refs/heads/X:refs/heads/X` — there is no force
 * option at all. Credentials travel via GIT_CONFIG_* environment variables,
 * never on the command line, so they are not visible in the process list.
 */
export function pushRepo(opts: PushRepoOptions): PushRepoResult {
  const exec = opts.exec ?? defaultExec;
  const run = (args: string[], env?: Record<string, string>): string =>
    exec(args, { cwd: opts.dir, env, timeoutMs: PUSH_TIMEOUT_MS });

  if (!isAbsolute(opts.dir)) {
    throw new Error(`dir must be an absolute path (got "${opts.dir}").`);
  }
  let toplevel: string;
  try {
    toplevel = run(["rev-parse", "--show-toplevel"]).trim();
  } catch (err) {
    throw new Error(`${opts.dir} is not a git repository: ${(err as Error).message}`);
  }
  let realDir: string;
  try {
    realDir = realpathSync(opts.dir);
  } catch {
    throw new Error(`${opts.dir} does not exist.`);
  }
  if (realpathSync(toplevel) !== realDir) {
    throw new Error(
      `${opts.dir} is not the top level of a repository (top level is ${toplevel}); pass the repository root.`
    );
  }

  const branch = (opts.branch ?? run(["symbolic-ref", "--short", "HEAD"]).trim()).trim();
  if (!BRANCH_RE.test(branch)) {
    throw new Error(`Refusing branch name "${branch}".`);
  }
  const remote = opts.remote ?? "origin";
  if (!REMOTE_RE.test(remote)) {
    throw new Error(`Refusing remote name "${remote}".`);
  }

  const remoteUrl = run(["remote", "get-url", "--push", remote]).trim();
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error(
      `Remote "${remote}" has a non-URL push target; only HTTPS remotes on ${opts.expectedHost} can be pushed.`
    );
  }
  if (parsed.protocol !== "https:" || parsed.host !== opts.expectedHost) {
    throw new Error(
      `Remote "${remote}" points at ${parsed.protocol}//${parsed.host}, not the configured Bitbucket host (${opts.expectedHost}); refusing to push credentials there.`
    );
  }

  let setUpstream = false;
  try {
    run(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  } catch {
    setUpstream = true;
  }

  const args = ["push"];
  if (setUpstream) args.push("--set-upstream");
  args.push(remote, `refs/heads/${branch}:refs/heads/${branch}`);
  const output = run(args, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: opts.authHeader,
  });

  parsed.username = "";
  parsed.password = "";
  return { branch, remote, remoteUrl: parsed.toString(), output, setUpstream };
}
