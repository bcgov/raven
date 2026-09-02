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

/**
 * Output ceiling for one git invocation. Node's default (1 MiB) would kill
 * git mid-push and surface a bare ENOBUFS — possibly after the remote has
 * already applied the update — if server-side hooks are chatty.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Branch names we accept: git-valid, and never option- or refspec-shaped. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Shape a push URL must have BEFORE any parser sees it: `https://`, a plain
 * hostname, an optional port, then a path — no userinfo, no backslash, no
 * whitespace. WHATWG `new URL()` and git/curl disagree on those characters:
 * `https://good.host\@evil.host/x.git` parses to host "good.host" in Node
 * (the backslash becomes a path separator) but curl reads "good.host\" as
 * the username and connects to evil.host. The host pin is therefore decided
 * on the raw string; the parsed URL is only a second opinion.
 */
const HTTPS_REMOTE_RE = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?\/[^\s\\]*$/i;

/**
 * Repository-LOCAL config keys that must not be present when git runs with
 * the credential. Credential helpers and askpass are programs git executes
 * on a 401 (an expired session is an everyday 401) with the credential in
 * their environment; http.* and per-remote proxy keys can route the request
 * through a proxy, disable TLS verification, or override name resolution.
 * Global and system config — the user's own corporate proxy, say — is not
 * inspected.
 */
function isForbiddenLocalKey(key: string, remote: string): boolean {
  const k = key.toLowerCase();
  const r = remote.toLowerCase();
  return (
    k.startsWith("http.") ||
    k.startsWith("credential.") ||
    k === "core.askpass" ||
    k === "core.gitproxy" ||
    k === `remote.${r}.proxy` ||
    k === `remote.${r}.proxyauthmethod`
  );
}

/**
 * Environment for any git invocation that carries the Bitbucket credential
 * (push_repo, clone_repo). The header travels via GIT_CONFIG_* variables,
 * never argv, so it is not visible in the process list. The same variables
 * reset credential.helper and core.askpass with empty values, and the
 * GIT_ASKPASS / SSH_ASKPASS variables an inherited environment may carry
 * are blanked too (git consults those before core.askpass): the injected
 * header is the only credential the invocation may use, so a 401 fails
 * outright instead of consulting — and exposing this environment to — a
 * credential program from any config scope or environment.
 */
export function gitCredentialEnv(authHeader: string): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: authHeader,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.askpass",
    GIT_CONFIG_VALUE_2: "",
  };
}

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
    maxBuffer: MAX_OUTPUT_BYTES,
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
  /** Normalized push URL. Userinfo is refused, so none is ever reported. */
  remoteUrl: string;
  /** git's own output: stdout followed by stderr (a push summary is stderr). */
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
 * second URL would receive the code and credentials too), and that URL must
 * be a plain `https://<expectedHost>/...` string — no userinfo, backslashes
 * or whitespace, which WHATWG and curl parse differently; the repository's
 * LOCAL git config must not carry proxy, TLS, or credential-program keys,
 * which would let the checkout redirect or intercept the credentialed
 * request (the hooks it could run are already skipped with --no-verify).
 * The refspec is always the explicit non-forcing `refs/heads/X:refs/heads/X`
 * — there is no force option at all. Credentials travel via GIT_CONFIG_*
 * environment variables, never on the command line, so they are not
 * visible in the process list; the same variables reset credential.helper
 * and core.askpass so a 401 fails instead of handing the credential to a
 * helper program.
 */
export function pushRepo(opts: PushRepoOptions): PushRepoResult {
  const exec = opts.exec ?? defaultGitExec;
  const run = (args: string[], env?: Record<string, string>): string =>
    exec(args, { cwd: opts.dir, env, timeoutMs: PUSH_TIMEOUT_MS });

  if (!isAbsolute(opts.dir)) {
    throw new Error(`dir must be an absolute path (got "${opts.dir}").`);
  }
  // realpathSync.native canonicalizes character case as well as symlinks,
  // so `~/projects/x` for an on-disk `~/Projects/x` is not refused on the
  // case-insensitive filesystems macOS and Windows default to.
  let realDir: string;
  try {
    realDir = realpathSync.native(opts.dir);
  } catch {
    throw new Error(`${opts.dir} does not exist.`);
  }
  let toplevel: string;
  try {
    toplevel = run(["rev-parse", "--show-toplevel"]).trim();
  } catch (err) {
    throw new Error(`${opts.dir} is not a git repository: ${(err as Error).message}`);
  }
  if (realpathSync.native(toplevel) !== realDir) {
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
  // So: enumerate all push URLs, allow exactly one, validate it. get-url
  // expands url.*.pushInsteadOf, so the URL checked is the one git will use.
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
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Remote "${remote}" points at ${parsed.protocol}//${parsed.host}, not the configured Bitbucket host (${opts.expectedHost}); refusing to push credentials there.`
    );
  }
  const shape = HTTPS_REMOTE_RE.exec(remoteUrl);
  if (!shape) {
    throw new Error(
      `Remote "${remote}" push URL is not a plain https://host/path URL; userinfo, backslashes and whitespace are refused because the push injects credentials.`
    );
  }
  const rawHost = shape[2] && shape[2] !== "443" ? `${shape[1]}:${shape[2]}` : shape[1]!;
  const expected = opts.expectedHost.toLowerCase();
  if (rawHost.toLowerCase() !== expected || parsed.host.toLowerCase() !== expected) {
    throw new Error(
      `Remote "${remote}" points at https://${rawHost}, not the configured Bitbucket host (${opts.expectedHost}); refusing to push credentials there.`
    );
  }

  // Repository-local config is arbitrary local state, exactly like the
  // hooks --no-verify skips. Refuse rather than override, so the user sees
  // which key is in the way; global/system scope is left alone.
  const forbidden = run(["config", "--list", "--show-scope", "--name-only"])
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([scope]) => scope === "local" || scope === "worktree")
    .map(([, key]) => key ?? "")
    .filter((key) => isForbiddenLocalKey(key, remote));
  if (forbidden.length > 0) {
    throw new Error(
      `${opts.dir} has repository-local git config that could redirect or intercept the credentialed push (${[...new Set(forbidden)].join(", ")}); remove it with \`git config --local --unset <key>\`, or set it with --global if you rely on it.`
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
  const output = run(args, gitCredentialEnv(opts.authHeader));

  return { branch, remote, remoteUrl: parsed.toString(), output, setUpstream };
}
