import { Client, type ConnectConfig } from "ssh2";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { isIP } from "node:net";
import type { SshResult } from "./types.js";
import { wrapSshExecWithLimits, sshLimiterOpts } from "@nrs/auth";

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

/** Shell metacharacters that indicate injection attempts. */
const SHELL_META = /[;&|`$(){}\\<>]/;

/** Validate sudo_user against allowlist and format. */
export function validateSudoUser(user: string): boolean {
  return USERNAME_RE.test(user) && ALLOWED_SUDO_USERS.has(user);
}

/** Validate that a command starts with an allowed binary and has no shell injection. */
export function validateCommand(command: string): boolean {
  if (SHELL_META.test(command)) return false;
  const firstToken = command.trim().split(/\s+/)[0];
  return ALLOWED_COMMANDS.has(firstToken);
}

/** Validate and return an absolute path, rejecting traversal and injection. */
export function sanitizePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Path must be absolute (start with /)");
  }
  if (path.includes("..")) {
    throw new Error("Path traversal (..) is not allowed");
  }
  if (SHELL_META.test(path)) {
    throw new Error("Path contains invalid characters");
  }
  return path;
}

/** Load a named variable from ~/.raven/.env (same logic as server-mcp). */
function loadEnvVar(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;

  try {
    const envPath = join(homedir(), ".raven", ".env");
    const content = readFileSync(envPath, "utf-8");
    const re = new RegExp(`^${name}=(.+)$`, "m");
    const match = content.match(re);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/** Shell-escape a single argument (wrap in single quotes). */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Get the SSH username. Checks IMIS_SSH_USER env, falls back to current user + _a. */
function getSshUser(): string {
  return loadEnvVar("IMIS_SSH_USER") ?? `${userInfo().username}_a`;
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
  const opts: ConnectConfig = {
    host,
    port: 22,
    username,
    readyTimeout: 30_000,
    // Match server-cmd.exp: ssh -o StrictHostKeyChecking=no
    hostVerifier: () => true,
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
 * Security model — designed for trusted internal networks only:
 * Host key verification is intentionally disabled (`hostVerifier: () => true`,
 * matching the legacy `server-cmd.exp` behavior of `StrictHostKeyChecking=no`).
 * RAVEN reaches BC Gov application servers (prod01/test01/int01) over
 * authenticated VPN; the trust boundary is the VPN tunnel and the
 * `SERVER_A_PASSWORD` credential, not TLS-style host key pinning. Do not
 * reuse this helper to talk to hosts outside that trust boundary — an
 * on-path attacker on an untrusted network could MITM the SSH handshake.
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
