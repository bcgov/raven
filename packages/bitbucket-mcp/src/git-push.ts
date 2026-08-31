import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Injectable git runner for tests. Returns the command's stdout followed by
 * its stderr — `git push` reports its summary on stderr while the plumbing
 * commands answer on stdout, and callers get both. Throws on a non-zero
 * exit with git's stderr in the message. `env` entries are ADDED to the
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

/**
 * Real git runner. spawnSync rather than execFileSync: execFileSync returns
 * only stdout, and `git push` writes its status summary to stderr, so the
 * push result would always look empty.
 *
 * @internal — exported for tests only.
 */
export const defaultGitExec: GitExec = (args, opts) => {
  const result = spawnSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `git ${args[0]} exited with ${result.status ?? `signal ${result.signal}`}${detail ? `: ${detail}` : ""}`
    );
  }
  return (result.stdout ?? "") + (result.stderr ?? "");
};

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
 * remote must have exactly ONE push URL (git pushes to all of them, so a
 * second URL would receive the code and credentials too), and it must be
 * HTTPS on `expectedHost`. The refspec is always the explicit non-forcing
 * `refs/heads/X:refs/heads/X` — there is no force option at all. The push
 * runs --no-verify so the repository's local pre-push hook (arbitrary
 * local code) never executes with the credential in its environment.
 * Credentials travel via GIT_CONFIG_* environment variables, never on the
 * command line, so they are not visible in the process list.
 */
export function pushRepo(opts: PushRepoOptions): PushRepoResult {
  const exec = opts.exec ?? defaultGitExec;
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

  // `git push <remote>` sends to EVERY configured push URL, and the injected
  // http.extraHeader applies to every HTTPS request of the invocation — a
  // hidden second pushurl would receive both the code and the credentials.
  // So: enumerate all push URLs, allow exactly one, validate it.
  const pushUrls = run(["remote", "get-url", "--push", "--all", remote])
    .split("\n")
    .map((u) => u.trim())
    .filter((u) => u !== "");
  if (pushUrls.length !== 1) {
    throw new Error(
      `Remote "${remote}" has ${pushUrls.length} push URLs; refusing to push credentials to a multi-URL remote.`
    );
  }
  const remoteUrl = pushUrls[0]!;
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

  // --no-verify: the repository's local pre-push hook is arbitrary local
  // code and would inherit the GIT_CONFIG_* environment carrying the
  // credential header; this controlled push never runs it.
  const args = ["push", "--no-verify"];
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
