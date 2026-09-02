import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

/**
 * Injectable git runner for tests. Returns the command's stdout followed by
 * its stderr — `git push` reports its summary on stderr while the plumbing
 * commands answer on stdout, and callers get both. Throws on a non-zero
 * exit with git's stderr in the message. `env`, when given, is the COMPLETE
 * environment for that invocation (see gitCredentialEnv); otherwise the
 * process environment is used as is.
 */
export type GitExec = (
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
) => string;

const GIT_TIMEOUT_MS = 300_000; // 5 minutes for clone and push alike

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
 * Is `name` a plain short branch name — git-valid, not a full ref, and not
 * option- or refspec-shaped? Shared by push_repo, commit_file and
 * create_repo so a value like `refs/heads/main` is refused before anything
 * is written, rather than becoming `refs/heads/refs/heads/main` later.
 */
export function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) return false;
  if (name.startsWith("refs/") || name.endsWith("/") || name.includes("//")) return false;
  if (name.includes("..") || name.includes("@{") || name.endsWith(".")) return false;
  return !name.split("/").some((s) => s.startsWith(".") || s.endsWith(".lock"));
}

/**
 * Shape a credential-bearing URL must have BEFORE any parser sees it:
 * `https://`, a plain hostname, an optional port, then a path — no
 * userinfo, no backslash, no whitespace. WHATWG `new URL()` and git/curl
 * disagree on those characters: `https://good.host\@evil.host/x.git`
 * parses to host "good.host" in Node (the backslash becomes a path
 * separator) but curl reads "good.host\" as the username and connects to
 * evil.host. The host pin is therefore decided on the raw string; the
 * parsed URL is only a second opinion.
 */
const HTTPS_REMOTE_RE = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?\/[^\s\\]*$/i;

/**
 * Environment variables never inherited by a credential-bearing git
 * invocation: programs git would run on a credential prompt, a switch that
 * disables TLS verification, repository redirection, and git's own
 * inherited `-c` channel. Proxy variables are deliberately NOT removed:
 * they are the user's own environment, like global config, and the REST
 * client reaches the same host without them.
 */
const DROPPED_ENV = [
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_SSL_NO_VERIFY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG_PARAMETERS",
];

/**
 * Is an inherited variable one this module controls? Compared without
 * regard to case: Windows resolves environment names case-insensitively,
 * so an inherited `Git_AskPass` would reach git as GIT_ASKPASS even though
 * a plain-object copy keeps the original spelling. Inherited
 * GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n are dropped for
 * the same reason, so they cannot shadow or extend the injected set.
 */
function isControlledEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    DROPPED_ENV.includes(upper) ||
    upper === "GIT_TERMINAL_PROMPT" ||
    upper === "GIT_TRACE_REDACT" ||
    /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(upper)
  );
}

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
 * The COMPLETE environment for a git invocation that carries the Bitbucket
 * credential (push_repo, clone_repo) to `targetUrl`, built from `base`
 * (the process environment by default). The header travels via
 * GIT_CONFIG_* variables, never argv, so it is not visible in the process
 * list. The same variables reset credential.helper and core.askpass, and
 * the DROPPED_ENV variables are removed: the injected header is the only
 * credential the invocation may use, so a 401 fails outright instead of
 * consulting — and exposing this environment to — a credential program
 * from any config scope or environment. TLS verification is forced on
 * twice: the plain http.sslVerify, and http.<targetUrl>.sslVerify — git
 * lets a URL-scoped key beat a plain one whatever the scope, so a
 * `http.<host>.sslVerify=false` left in a global config (a TLS-inspecting
 * proxy workaround, say) would otherwise win; the exact target URL is the
 * most specific match possible, and command scope wins a tie. Git's trace
 * redaction is forced on so a debugging variable inherited from the server
 * cannot print the header.
 */
export function gitCredentialEnv(
  authHeader: string,
  targetUrl: string,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!isControlledEnvKey(name)) env[name] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_TRACE_REDACT: "1",
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: authHeader,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.askpass",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "http.sslVerify",
    GIT_CONFIG_VALUE_3: "true",
    GIT_CONFIG_KEY_4: `http.${targetUrl}.sslVerify`,
    GIT_CONFIG_VALUE_4: "true",
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
    env: opts.env ?? process.env,
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

/**
 * Validate a URL that git will be handed together with the credential:
 * https only, plain shape (see HTTPS_REMOTE_RE), and host pinned to
 * `expectedHost` on both the raw string and the parsed form. Returns the
 * parsed URL for reporting. `label` names the URL in error messages.
 */
function pinnedHttpsUrl(url: string, expectedHost: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a URL; only https://${expectedHost}/... can carry credentials.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `${label} uses ${parsed.protocol}//${parsed.host}, not https://${expectedHost}; refusing to send credentials there.`
    );
  }
  const shape = HTTPS_REMOTE_RE.exec(url);
  if (!shape) {
    throw new Error(
      `${label} is not a plain https://host/path URL; userinfo, backslashes and whitespace are refused because credentials are injected.`
    );
  }
  const rawHost = shape[2] && shape[2] !== "443" ? `${shape[1]}:${shape[2]}` : shape[1]!;
  const expected = expectedHost.toLowerCase();
  if (rawHost.toLowerCase() !== expected || parsed.host.toLowerCase() !== expected) {
    throw new Error(
      `${label} points at https://${rawHost}, not the configured Bitbucket host (${expectedHost}); refusing to send credentials there.`
    );
  }
  return parsed;
}

/** One `git config --list --show-scope` line, split. */
function parseScopedConfig(output: string): { scope: string; key: string; value: string }[] {
  const entries: { scope: string; key: string; value: string }[] = [];
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const scope = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    const eq = rest.indexOf("=");
    entries.push(
      eq < 0 ? { scope, key: rest, value: "" } : { scope, key: rest.slice(0, eq), value: rest.slice(eq + 1) }
    );
  }
  return entries;
}

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
 * "-", no "+", no ":", not a full ref, so no force-push refspec can be
 * smuggled in); the
 * remote must have exactly ONE push URL (git pushes to all of them, so a
 * second URL would receive the code and credentials too), and that URL must
 * be a plain `https://<expectedHost>/...` string — no userinfo, backslashes
 * or whitespace, which WHATWG and curl parse differently; the repository's
 * LOCAL git config must not carry proxy, TLS, or credential-program keys,
 * which would let the checkout redirect or intercept the credentialed
 * request (the hooks it could run are already skipped with --no-verify).
 * The refspec is always the explicit non-forcing `refs/heads/X:refs/heads/X`
 * — there is no force option at all. The push runs with gitCredentialEnv.
 */
export function pushRepo(opts: PushRepoOptions): PushRepoResult {
  const exec = opts.exec ?? defaultGitExec;
  const run = (args: string[], env?: NodeJS.ProcessEnv): string =>
    exec(args, { cwd: opts.dir, env, timeoutMs: GIT_TIMEOUT_MS });

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
  if (!isValidBranchName(branch)) {
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
  const parsed = pinnedHttpsUrl(remoteUrl, opts.expectedHost, `Remote "${remote}"`);

  // Repository-local config is arbitrary local state, exactly like the
  // hooks --no-verify skips. Refuse rather than override, so the user sees
  // which key is in the way; global/system scope is left alone.
  const forbidden = parseScopedConfig(run(["config", "--list", "--show-scope", "--name-only"]))
    .filter((e) => e.scope === "local" || e.scope === "worktree")
    .map((e) => e.key)
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
  // --no-follow-tags: push.followTags in any config scope would otherwise
  // add reachable annotated tags to what is meant to be a one-branch push.
  const args = ["push", "--no-verify", "--no-follow-tags"];
  if (setUpstream) args.push("--set-upstream");
  args.push(remote, `refs/heads/${branch}:refs/heads/${branch}`);
  const output = run(args, gitCredentialEnv(opts.authHeader, remoteUrl));

  return { branch, remote, remoteUrl: parsed.toString(), output, setUpstream };
}

export interface CloneRepoOptions {
  /** Clone URL, built by the caller from the configured Bitbucket base URL. */
  url: string;
  /** Absolute path the repository is cloned into (must not exist yet). */
  dest: string;
  shallow: boolean;
  /** Host (hostname[:port]) `url` must be on; see PushRepoOptions. */
  expectedHost: string;
  /** Value for git's http.extraHeader. */
  authHeader: string;
  /** Injectable git runner (tests). */
  exec?: GitExec;
}

/**
 * Clone a repository from the configured Bitbucket host with the credential.
 *
 * `git clone <url>` does not go where the argument says if a
 * `url.<base>.insteadOf` rule matches it — git rewrites the URL first, and
 * the credential would follow the rewrite. push_repo is protected by
 * re-reading the URL git will use; a clone has no remote to ask yet, so
 * this pre-checks the rules git will apply: it runs from a neutral
 * directory — the temp directory, verified to be outside any repository,
 * so no repository-local config applies (the server's own cwd is not
 * trusted) — and refuses if any insteadOf prefix in the remaining scopes
 * matches the URL, including the empty prefix, which git treats as
 * matching every URL. The URL itself is pinned like a push URL.
 *
 * The network clone runs with gitCredentialEnv and --no-checkout: git
 * clone's own checkout would run a post-checkout hook installed from
 * init.templateDir or GIT_TEMPLATE_DIR with the header in its environment,
 * the exposure --no-verify closes for pushes. The working tree is then
 * populated by a separate, credential-free `git checkout` (skipped for an
 * empty repository, whose HEAD is unborn). Returns git's output.
 */
export function cloneRepo(opts: CloneRepoOptions): string {
  const exec = opts.exec ?? defaultGitExec;
  const cwd = tmpdir();
  const run = (args: string[], env?: NodeJS.ProcessEnv): string =>
    exec(args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });

  if (!isAbsolute(opts.dest)) {
    throw new Error(`dest must be an absolute path (got "${opts.dest}").`);
  }
  pinnedHttpsUrl(opts.url, opts.expectedHost, "Clone URL");

  let enclosing: string | null = null;
  try {
    enclosing = run(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    // not inside a repository: the neutral directory is neutral
  }
  if (enclosing !== null) {
    throw new Error(
      `The temporary directory ${cwd} is inside the git repository ${enclosing}, whose local config would apply to the credentialed clone; point TMPDIR at a directory outside any repository.`
    );
  }

  const rewrites = parseScopedConfig(run(["config", "--list", "--show-scope"])).filter(
    (e) => e.key.toLowerCase().startsWith("url.") && e.key.toLowerCase().endsWith(".insteadof")
  );
  for (const rule of rewrites) {
    if (opts.url.startsWith(rule.value)) {
      const base = rule.key.slice("url.".length, -".insteadof".length);
      throw new Error(
        `${rule.scope} git config rewrites ${rule.value === "" ? "every URL" : rule.value} to ${base} (url.<base>.insteadOf); refusing to clone with credentials through a rewritten URL.`
      );
    }
  }

  const args = ["clone", "--no-checkout"];
  if (opts.shallow) args.push("--depth=1");
  args.push(opts.url, opts.dest);
  const output = run(args, gitCredentialEnv(opts.authHeader, opts.url));

  // Populate the working tree in a separate process that never sees the
  // credential. Any post-checkout hook the templates installed runs here,
  // with nothing to read.
  const inDest = (a: string[]): string => exec(a, { cwd: opts.dest, timeoutMs: GIT_TIMEOUT_MS });
  let hasHead = true;
  try {
    inDest(["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    hasHead = false; // empty repository: nothing to check out
  }
  return hasHead ? output + inDest(["checkout"]) : output;
}
