import { Client, type ConnectConfig, type ServerHostKeyAlgorithm } from "ssh2";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import { isIP } from "node:net";
import type { SshResult } from "./types.js";
import { wrapSshExecWithLimits, sshLimiterOpts, loadEnvVar, shellEscape, assertNoShellControlChars, hasShellControlChars, createHostVerifier, preferKnownHostKeyAlgorithms } from "@nrs/auth";

/** Read-only command allowlist — matches server-common.sh plus rpm and mount. */
const ALLOWED_COMMANDS = new Set([
  "grep", "zgrep", "zcat", "cat", "head", "tail", "readlink", "basename",
  "ls", "df", "du", "wc", "find", "ps", "stat", "file", "echo", "date",
  "hostname", "uptime", "free", "vmstat", "prtconf", "rpm", "mount",
  // Added for parity with server-mcp + general read-only utility:
  "jstat", "sort", "uniq", "tr", "cut", "diff", "which", "strings", "lsof",
]);

/** Allowed sudo_user values — common service accounts on BC Gov servers. */
const ALLOWED_SUDO_USERS = new Set([
  "wwwsvr", "oracle", "tomcat", "weblogic", "jboss", "nginx", "httpd", "wildfly",
  "midtadm",
]);

/** Human-readable list for rejection messages (keeps server.ts in sync automatically). */
export const ALLOWED_SUDO_USER_LIST = [...ALLOWED_SUDO_USERS].join(", ");

/** Valid Unix username pattern: lowercase alphanumeric + underscore, 1-32 chars. */
const USERNAME_RE = /^[a-z_][a-z0-9_]{0,31}$/;

/**
 * Shell metacharacters that indicate injection attempts.
 *
 * Control characters are NOT listed here — they are checked separately by
 * assertNoShellControlChars. That separation matters: a newline is matched by
 * `\s`, so `command.trim().split(/\s+/)[0]` below treats it as ordinary
 * whitespace and validates only the text before it, while the receiving shell
 * treats it as a statement separator. That combination was RSEC-002.
 */
const SHELL_META = /[;&|`$(){}\\<>]/;

/** Quote characters, rejected in paths. See sanitizePath. */
const QUOTE_CHARS = /['"]/;

/**
 * Per-command argument policy.
 *
 * Allowlisting the binary is not sufficient to make this tool read-only:
 * several allowlisted utilities execute other programs or mutate the
 * filesystem through their own options, with no shell metacharacter and no
 * control character involved. Each policy below exists because a concrete
 * bypass was demonstrated:
 *
 * - `find … -exec rm -rf … +` runs a program; `-delete` removes; `-fprintf` writes
 * - `sort -o FILE` overwrites; `sort --compress-program=PROG` runs PROG
 * - `rpm --pipe CMD` is a popen() and composes with `-q`; `--eval`/`--define`
 *   evaluate macros
 * - `uniq INPUT OUTPUT` writes OUTPUT (POSIX positional form, any user)
 * - `date -s` or a numeric operand sets the clock; `hostname NAME` / `-F FILE`
 *   sets the hostname
 * - `mount …` with any argument changes mount state
 * - `file -C` / `--compile` writes a compiled magic database
 * - `jstat -J...` forwards JVM options that can write files or load agents
 *
 * Long options are rejected outright on `sort`, `date`, `uniq` and `file` rather than
 * named individually. GNU accepts any unambiguous abbreviation — `date --s`
 * reaches the clock-setting syscall and `sort --compress-prog=CMD` runs CMD —
 * so a denylist would have to enumerate every prefix of every dangerous
 * option. Use their short display/filter options instead. Commands with no
 * argument policy keep their long options.
 *
 * The first version of this policy was a denylist plus a "some `-q` flag is
 * present" check for rpm. Both were the wrong shape: a denylist has to
 * enumerate every dangerous option, and a presence check restricts nothing
 * else on the line. Where a binary has any executing or writing option, the
 * policy is now an ALLOWLIST — every argument must match a known-safe form.
 *
 * Platform assumption: these policies describe the GNU/RHEL userland the IMIS
 * inventory runs. They are option-level rules, so a host that shadows a name
 * with a different implementation can widen what that name accepts — `ugrep`
 * installed as `grep`, for instance, adds --filter/--pager/--view, all of
 * which run a program. The binary allowlist, not this table, is what bounds
 * that case.
 *
 * `allow`:            every argument must match at least one pattern
 * `forbid`:           any argument matching a pattern rejects the command
 * `validateArgs`:     command-specific option arity and operand grammar
 * `shortValueFlags`:  short options that take an attached value; declaring
 *                     them turns on cluster expansion for `forbid`
 *
 * Every policy rejects unquoted globs: expansion can change both operands and
 * options after validation. Quoted patterns remain literal shell arguments.
 */
interface ArgPolicy {
  allow?: RegExp[];
  forbid?: RegExp[];
  validateArgs?: (args: string[]) => boolean;
  shortValueFlags?: string;
}

/**
 * Expand a single-dash short-option cluster into its individual flags.
 *
 * Every `forbid` pattern is anchored at the start of the argument, so it sees
 * only the first option in a token. getopt lets the dangerous flag hide at the
 * end of a cluster, where it still consumes the next word as its value:
 * `sort -uo FILE` is `sort -u -o FILE` and overwrites FILE, and `date -us STR`
 * is `date -u -s STR` and sets the clock.
 *
 * Expansion stops at the first flag in `valueFlags`, because that flag takes
 * the rest of the token as its value rather than as more flags. Without that
 * stop, `sort -to` (field separator `o`) would read as an `-o`.
 *
 * Only `forbid` policies expand. An `allow` policy already rejects anything it
 * does not recognise, and splitting rpm's `-qi` into `-q -i` would misread a
 * query modifier as the standalone install flag.
 *
 * @param arg - A single command argument.
 * @param valueFlags - Short flag letters that take an attached value.
 * @returns The individual short flags, or [] when arg is not a short cluster.
 */
function expandShortCluster(arg: string, valueFlags: string): string[] {
  // Long options (`--output`) and positionals are not clusters.
  if (!/^-[a-zA-Z]/.test(arg)) return [];
  const flags: string[] = [];
  for (const ch of arg.slice(1)) {
    if (!/[a-zA-Z]/.test(ch)) break;
    flags.push(`-${ch}`);
    if (valueFlags.includes(ch)) break;
  }
  return flags;
}

/**
 * Characters that make an argument expandable by the shell.
 *
 * Expansion depends on the remote filesystem. In addition to producing extra
 * operands, `-[o]` can become a forbidden option such as sort's `-o`.
 */
const GLOB_META = /[*?[]/;

/** Positional that names a package, a file path, or a plain identifier. */
const NAME_OR_PATH = /^[A-Za-z0-9/][A-Za-z0-9._+/-]*$/;

/** GNU uniq: short options followed by at most one input, including stdin `-`. */
function validateUniqArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return args.length - i - 1 <= 1;
    if (arg === "-" || !arg.startsWith("-")) {
      // Requiring the input last also remains safe with POSIXLY_CORRECT,
      // where a subsequent -c would be interpreted as an output filename.
      return i === args.length - 1;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ("cdiDuz".includes(flag)) continue;
      if (!"fsw".includes(flag)) return false;
      const count = arg.slice(j + 1) || args[++i];
      if (count === undefined || !/^\d+$/.test(count)) return false;
      break;
    }
  }
  return true;
}

/** GNU date display grammar; a numeric positional would set the clock. */
function validateDateArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      return i === args.length - 1 ||
        (i === args.length - 2 && args[i + 1].startsWith("+"));
    }
    if (arg.startsWith("+")) return i === args.length - 1;
    if (!arg.startsWith("-") || arg === "-") return false;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ("uR".includes(flag)) continue;
      if (flag === "I") {
        // -I has an optional attached value; it never consumes the next word.
        if (!/^(date|hours|minutes|seconds|ns)?$/.test(arg.slice(j + 1))) return false;
        break;
      }
      if (!"dfr".includes(flag)) return false;
      // These mandatory values are display inputs, even when they start with
      // a dash or look like the numeric clock-setting operand.
      if (j === arg.length - 1 && ++i === args.length) return false;
      break;
    }
  }
  return true;
}

const ARG_POLICY: Record<string, ArgPolicy> = {
  // The Java launcher handles -J before jstat parses its statistics options.
  // For example, -J-Xlog:gc:file=PATH writes a log even with -help, and
  // -J-javaagent:PATH loads executable agent code. Quoting cannot make these
  // safe; reject every forwarding option after shell quote removal.
  jstat: { forbid: [/^-J/] },
  // GNU find actions that execute or write. Every other action prints.
  find: { forbid: [/^-(exec|execdir|ok|okdir|delete|fprintf?|fprint0|fls)$/] },
  // -o/-oFILE write; --output and --compress-program are covered by the
  // blanket long-option rule below. -k/-o/-S/-T/-t take an attached value,
  // which bounds cluster expansion.
  sort: { forbid: [/^-o/, /^--/], shortValueFlags: "koSTt" },
  // Query mode only, expressed as an allowlist so --pipe, --eval, --define,
  // --macros, --rcfile and every other long option are excluded by shape.
  // `-i` is "info" under -q but "install" alone, which is why a denylist
  // could never be right here.
  rpm: { allow: [/^-q[a-zA-Z]*$/, NAME_OR_PATH] },
  uniq: { validateArgs: validateUniqArgs },
  date: { validateArgs: validateDateArgs },
  // Only the short display flags. Any positional sets the name; -F reads it
  // from a file.
  hostname: { allow: [/^-[fiIsdaAy]$/] },
  // Bare `mount` lists; anything else changes mount state.
  mount: { allow: [] },
  // `file -C` writes a compiled magic database (.mgc). The short flag can be
  // bundled (`-Cm FILE`), so match any cluster containing uppercase C;
  // lowercase `-c` is a harmless checking printout. `--compile` and its
  // abbreviations fall under the blanket long-option rule.
  file: { forbid: [/^-[a-zA-Z0-9]*C/, /^--/] },
};

/**
 * Split a command the way the remote shell will.
 *
 * The policy used to run on `command.split(/\s+/)`, but this string is handed
 * to a shell, which removes the quotes and joins the fragments: `-'o'` arrives
 * at sort as `-o`, and `sort -'o' /tmp/out /tmp/in` was confirmed to write
 * /tmp/out while passing validation. Every check therefore has to run on the
 * argv the shell produces, not on the source text.
 *
 * The grammar is small because hasShellControlChars and SHELL_META have
 * already rejected backslash, `$`, backtick and every metacharacter, so the
 * single and double quotes join literal fragments. Track unquoted globs
 * separately so argument policies can reject filesystem-dependent expansion.
 *
 * @param command - Raw command string, already screened for metacharacters.
 * @returns Literal tokens and whether the shell can glob, or null for an open quote.
 */
function tokenizeCommand(command: string): { tokens: string[]; hasGlob: boolean } | null {
  const tokens: string[] = [];
  let hasGlob = false;
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // An empty pair still produces an argument, exactly as the shell does.
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    if (GLOB_META.test(ch)) hasGlob = true;
    started = true;
  }
  if (quote !== null) return null;
  if (started) tokens.push(current);
  return { tokens, hasGlob };
}

/** Validate sudo_user against allowlist and format. */
export function validateSudoUser(user: string): boolean {
  return USERNAME_RE.test(user) && ALLOWED_SUDO_USERS.has(user);
}

/** Validate that a command starts with an allowed binary and has no shell injection. */
export function validateCommand(command: string): boolean {
  if (hasShellControlChars(command)) return false;
  if (SHELL_META.test(command)) return false;

  const parsed = tokenizeCommand(command);
  if (parsed === null) return false;
  const { tokens, hasGlob } = parsed;
  const binary = tokens[0];
  if (!binary || !ALLOWED_COMMANDS.has(binary)) return false;

  const args = tokens.slice(1);
  const policy = ARG_POLICY[binary];
  if (!policy) return true;
  if (hasGlob) return false;

  // Bound to consts so the narrowing survives into the arrow callbacks.
  const { forbid, allow, validateArgs, shortValueFlags } = policy;
  if (forbid) {
    const expanded = shortValueFlags
      ? args.flatMap((a) => expandShortCluster(a, shortValueFlags))
      : [];
    const candidates = [...args, ...expanded];
    if (candidates.some((a) => forbid.some((rx) => rx.test(a)))) return false;
  }
  if (allow && !args.every((a) => allow.some((rx) => rx.test(a)))) return false;
  if (validateArgs && !validateArgs(args)) return false;
  return true;
}

/** Validate and return an absolute path, rejecting traversal and injection. */
export function sanitizePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Path must be absolute (start with /)");
  }
  if (path.includes("..")) {
    throw new Error("Path traversal (..) is not allowed");
  }
  assertNoShellControlChars(path, "Path");
  if (QUOTE_CHARS.test(path)) {
    // Quotes are rejected rather than escaped so the value stays a single
    // shell word after shellEscape without introducing a backslash, which
    // SHELL_META would then reject downstream in validateCommand.
    throw new Error("Path contains quote characters");
  }
  if (SHELL_META.test(path)) {
    throw new Error("Path contains invalid characters");
  }
  return path;
}

/** Derive an SSH username from an explicit override or an OS username. */
export function deriveSshUser(
  osUsername: string,
  configuredUsername: string | undefined,
): string {
  return configuredUsername ?? `${osUsername.toLowerCase()}_a`;
}

/** Get the configured SSH username, or derive a lowercase `_a` account name. */
function getSshUser(): string {
  return deriveSshUser(userInfo().username, loadEnvVar("IMIS_SSH_USER"));
}

/**
 * SSH authentication mode.
 *
 * Default is `password` — identical to behavior before SSH_KEY_PATH support
 * was added. Existing users see no change unless they opt in.
 *
 * `key` is opt-in via SSH_KEY_PATH in ~/.raven/.env. Misconfiguration
 * (path set but file missing) is surfaced as `error` rather than silently
 * falling back to password.
 */
export type SshAuthMode =
  | { kind: "key"; keyPath: string }
  | { kind: "password" }
  | { kind: "error"; message: string };

/**
 * Normalize a hostname for SSH_KEY_HOSTS matching (lowercase, strip domain).
 * IP addresses (v4 or v6) are returned unchanged — splitting on "." would
 * mangle them (e.g., "192.168.1.10" → "192") and prevent SSH_KEY_HOSTS
 * matches for IP-based entries.
 */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  if (isIP(lower)) return lower;
  return lower.split(".")[0]!;
}

/**
 * Decide which auth method to use for a given host.
 *
 * Per-host opt-in: only hosts listed in SSH_KEY_HOSTS use key auth. All
 * other hosts use password auth. There is NO key→password fallback within
 * a single connection.
 *
 * See server-mcp/ssh-client.ts for the full design rationale.
 */
export function getSshAuthMode(
  host: string,
  configuredKey: string | undefined,
  hostList: string | undefined,
): SshAuthMode {
  if (!configuredKey) return { kind: "password" };
  if (!existsSync(configuredKey)) {
    return {
      kind: "error",
      message:
        `SSH_KEY_PATH=${configuredKey} but that file does not exist. ` +
        `Fix the path or unset SSH_KEY_PATH in ~/.raven/.env to use password auth.`,
    };
  }
  if (!hostList) {
    return {
      kind: "error",
      message:
        `SSH_KEY_PATH is set but SSH_KEY_HOSTS is not. ` +
        `Set SSH_KEY_HOSTS to a comma-separated list of hostnames where the key should be used ` +
        `(e.g., SSH_KEY_HOSTS=int01,test01,prod01), ` +
        `or set SSH_KEY_HOSTS=* to use the key on all hosts, ` +
        `or unset SSH_KEY_PATH to use password auth.`,
    };
  }
  const allowed = hostList.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes("*") || allowed.includes(normalizeHost(host))) {
    return { kind: "key", keyPath: configuredKey };
  }
  return { kind: "password" };
}

/**
 * Build the command string to execute on the remote server.
 * Prepends nohist to prevent commands appearing in remote bash history.
 * For sudo mode, wraps in: sudo -S -u <user> bash -c '...'
 * with the sudo password piped to sudo's stdin.
 */
function buildRemoteCommand(command: string, sudoUser?: string): string {
  const nohist = "unset HISTFILE; set +o history";
  if (!sudoUser) {
    return `${nohist} && ${command}`;
  }
  const inner = shellEscape(`${nohist} && ${command}`);
  return `${nohist} && sudo -S -u ${sudoUser} bash -c ${inner}`;
}

/**
 * Build the ssh2 ConnectConfig for a single auth attempt.
 *
 * Strict invariant: this function MUST set exactly one of `privateKey` or
 * `password`, never both. Auth-method routing happens upstream via
 * SSH_KEY_HOSTS — by the time we reach this function we know whether
 * we're using key or password for this specific host.
 *
 * Never sets `agent` or `tryKeyboard` — those would offer additional auth
 * methods and amplify failed-login counts.
 *
 * Exported for unit testing the auth-method invariant.
 */
export function buildConnectOpts(
  host: string,
  username: string,
  authMode: SshAuthMode,
  password: string | undefined,
  passphrase: string | undefined,
  privateKeyBytes: Buffer | undefined,
): ConnectConfig {
  // ssh2 exposes no public default list. Read its installed defaults instead
  // of copying them and accidentally re-enabling a disabled algorithm later.
  const { DEFAULT_SERVER_HOST_KEY } = createRequire(import.meta.url)("ssh2/lib/protocol/constants.js") as {
    DEFAULT_SERVER_HOST_KEY: ServerHostKeyAlgorithm[];
  };
  const opts: ConnectConfig = {
    host,
    port: 22,
    username,
    readyTimeout: 30_000,
    // RSEC-006: verify against ~/.ssh/known_hosts. Set
    // RAVEN_SSH_INSECURE_HOST_KEYS=true to restore the previous
    // accept-anything behavior (the old `ssh -o StrictHostKeyChecking=no`).
    hostVerifier: createHostVerifier(host),
    algorithms: { serverHostKey: preferKnownHostKeyAlgorithms(host, DEFAULT_SERVER_HOST_KEY) },
  };
  if (authMode.kind === "key") {
    if (!privateKeyBytes) {
      throw new Error("buildConnectOpts: privateKeyBytes required for key mode");
    }
    opts.privateKey = privateKeyBytes;
    if (passphrase) opts.passphrase = passphrase;
  } else if (authMode.kind === "password") {
    if (!password) {
      throw new Error("buildConnectOpts: password required for password mode");
    }
    opts.password = password;
  } else {
    // authMode.kind === "error" — callers must handle this upstream and
    // never reach buildConnectOpts. Throwing here keeps the single-method
    // invariant honest if a future caller forgets the early-return.
    throw new Error(`buildConnectOpts: cannot build config for error mode: ${authMode.message}`);
  }
  return opts;
}

/**
 * Execute a command on a remote server via ssh2 (raw, no rate limit). Use
 * the exported {@link sshExec} below for the rate-limited public entry
 * point. Replaces the previous expect-script-based implementation.
 *
 * Authentication:
 *   - Default: password auth via SERVER_A_PASSWORD (~/.raven/.env)
 *   - Opt-in: key-based auth via SSH_KEY_PATH (~/.raven/.env)
 *
 * Sudo (when sudoUser is set) always uses SERVER_A_PASSWORD on stdin,
 * regardless of which SSH auth method was used.
 *
 * Security model:
 * Host keys are verified against `~/.ssh/known_hosts` (RSEC-006). RAVEN reaches
 * BC Gov application servers (prod01/test01/int01) over authenticated VPN, but
 * the VPN tunnel is no longer treated as sufficient on its own: this helper
 * also sends the `SERVER_A_PASSWORD` credential and pipes the sudo password
 * over stdin, so an unverified peer is a credential disclosure, not just an
 * integrity question.
 *
 * An unknown or mismatched key fails the connection with an actionable
 * message. Setting `RAVEN_SSH_INSECURE_HOST_KEYS=true` restores the previous
 * accept-anything behavior, which is the legacy `server-cmd.exp`
 * `StrictHostKeyChecking=no` semantics — use it only as a temporary,
 * deliberate exception.
 */
async function sshExecRaw(
  host: string,
  command: string,
  sudoUser?: string,
  timeoutMs: number = 60_000,
): Promise<SshResult> {
  // Defense-in-depth: now that sshExec is part of the public client surface,
  // re-run the validators here so external consumers can't bypass them and
  // inject shell metacharacters via `command` or `sudoUser`. Internal callers
  // already validate, so this is a no-op for them.
  if (!validateCommand(command)) {
    const firstToken = command.trim().split(/\s+/)[0] ?? "";
    return {
      stdout: "",
      stderr: `Command rejected: "${firstToken}" is not in the allowlist or contains shell metacharacters.`,
      exitCode: 1,
    };
  }
  if (sudoUser !== undefined && !validateSudoUser(sudoUser)) {
    return {
      stdout: "",
      stderr: `sudoUser rejected: "${sudoUser}" is not in the allowlist (${ALLOWED_SUDO_USER_LIST}).`,
      exitCode: 1,
    };
  }

  const authMode = getSshAuthMode(
    host,
    loadEnvVar("SSH_KEY_PATH"),
    loadEnvVar("SSH_KEY_HOSTS"),
  );
  if (authMode.kind === "error") {
    return { stdout: "", stderr: authMode.message, exitCode: 1 };
  }

  // SERVER_A_PASSWORD is required for password-based SSH and for sudo.
  // The only case where it's not strictly needed is key-auth + no sudo.
  const password = loadEnvVar("SERVER_A_PASSWORD");
  if (authMode.kind === "password" && !password) {
    return {
      stdout: "",
      stderr: "SERVER_A_PASSWORD not set. Add it to ~/.raven/.env.",
      exitCode: 1,
    };
  }
  if (sudoUser && !password) {
    return {
      stdout: "",
      stderr: "SERVER_A_PASSWORD not set (required for sudo). Add it to ~/.raven/.env.",
      exitCode: 1,
    };
  }

  const user = getSshUser();
  const fullCommand = buildRemoteCommand(command, sudoUser);

  let connectOpts: ConnectConfig;
  try {
    const privateKeyBytes =
      authMode.kind === "key" ? readFileSync(authMode.keyPath) : undefined;
    const passphrase =
      authMode.kind === "key" ? loadEnvVar("SSH_KEY_PASSPHRASE") : undefined;
    connectOpts = buildConnectOpts(host, user, authMode, password, passphrase, privateKeyBytes);
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }

  return new Promise<SshResult>((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ stdout, stderr: "SSH command timed out.", exitCode: 1 });
    }, timeoutMs);

    conn.once("ready", () => {
      conn.exec(fullCommand, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout: "", stderr: err.message, exitCode: 1 });
          return;
        }

        // If sudoing, pipe the password to sudo -S stdin
        if (sudoUser && password) {
          stream.stdin.write(password + "\n");
        }
        stream.stdin.end();

        stream.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });

    // ssh2's connect() can throw synchronously for malformed config (e.g.,
    // encrypted private key without SSH_KEY_PASSPHRASE). Convert to a result.
    try {
      conn.connect(connectOpts);
    } catch (err) {
      clearTimeout(timer);
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
      });
    }
  });
}

/**
 * Public sshExec — wraps {@link sshExecRaw} with per-host rate limiting
 * and a circuit breaker. See `@nrs/auth/rate-limit`. Tunable via env vars
 * (RATE_LIMIT_SSH_BURST, RATE_LIMIT_SSH_RPS, etc.).
 */
export const sshExec = wrapSshExecWithLimits(
  sshExecRaw,
  ([host]) => host,
  sshLimiterOpts(),
);
