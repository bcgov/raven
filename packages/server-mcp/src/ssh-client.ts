import { Client, type ConnectConfig } from "ssh2";
import type { Readable } from "node:stream";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import type { ServerEntry } from "@nrs/auth";
import { wrapSshExecWithLimits, sshLimiterOpts } from "@nrs/auth";

export interface SshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Load a named variable from ~/.raven/.env */
function loadEnvVar(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const content = readFileSync(join(homedir(), ".raven", ".env"), "utf-8");
    const match = content.match(new RegExp(`^${name}=(.+)$`, "m"));
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/** Shell-escape a single argument (wrap in single quotes). */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * SSH authentication mode.
 *
 * Default is `password` — identical to behavior before SSH_KEY_PATH support
 * was added. Existing users see no change unless they opt in.
 *
 * `key` is opt-in via SSH_KEY_PATH in ~/.raven/.env. Misconfiguration
 * (path set but file missing) is surfaced as `error` rather than silently
 * falling back to password — to avoid the password-auth-after-key-failure
 * pattern that triggers MaxAuthTries alerts on the BC Gov bastion.
 */
export type SshAuthMode =
  | { kind: "key"; keyPath: string }
  | { kind: "password" }
  | { kind: "error"; message: string };

/**
 * Normalize a hostname for SSH_KEY_HOSTS matching.
 * Lowercases and strips any domain (e.g., "Int01.example.internal" → "int01").
 * IP addresses (v4 or v6) are returned unchanged — splitting on "." would
 * mangle them (e.g., "192.168.1.10" → "192") and prevent SSH_KEY_HOSTS
 * matches for IP-based entries that servers.conf.example permits.
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
 * a single connection — we never offer multiple methods, so a rejected key
 * does not generate a follow-up password attempt that compounds failed-login
 * counts on the bastion.
 *
 * Resolution order:
 *   1. SSH_KEY_PATH unset → password (transparency invariant for users
 *      who haven't opted in)
 *   2. SSH_KEY_PATH set, file missing → error
 *   3. SSH_KEY_PATH set, SSH_KEY_HOSTS unset → error (forces explicitness)
 *   4. SSH_KEY_PATH set, host listed (or `*` wildcard) → key
 *   5. SSH_KEY_PATH set, host NOT listed → password
 *
 * Pure logic — no env access. Production callers pass
 * `loadEnvVar("SSH_KEY_PATH")` and `loadEnvVar("SSH_KEY_HOSTS")`.
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
 * Build the remote command string.
 * Always prepends nohist to prevent history pollution on the remote server.
 * Sudos to the service account when sudoUser is provided (server-mcp tools
 * need service account permissions to read app files and run jstat).
 * When sudoUser is empty, runs directly as the SSH user — used for servers
 * where the _A account has direct read access (e.g. NR Apache httpd servers).
 *
 * Pattern with sudo (mirrors server-cmd.exp "exec" mode):
 *   unset HISTFILE; set +o history &&
 *   sudo -S -u <sudoUser> bash -c 'unset HISTFILE; set +o history && <command>'
 *
 * Pattern without sudo:
 *   unset HISTFILE; set +o history && <command>
 *
 * The sudo password is piped to stdin by the caller when sudoUser is set.
 */
export function buildRemoteCommand(command: string, sudoUser: string): string {
  const nohist = "unset HISTFILE; set +o history";
  if (!sudoUser) {
    return `${nohist} && ${command}`;
  }
  const inner = shellEscape(`${nohist} && ${command}`);
  // -p '' suppresses sudo's "[sudo] password for <user>:" prompt, which it
  // writes to stderr on every fresh auth even when the password piped to -S
  // succeeds. Without this, any command that legitimately produces empty
  // stdout (e.g. a log search with zero matches) surfaces that prompt and
  // looks like an auth failure. Genuine sudo errors still print to stderr.
  // sudoUser comes from servers.conf (config-trusted, not end-user input),
  // but shell-escape it anyway as defense-in-depth so a malformed/hostile
  // entry can't break out of the `sudo -u` argument into the command line.
  return `${nohist} && sudo -S -p '' -u ${shellEscape(sudoUser)} bash -c ${inner}`;
}

/**
 * Build the ssh2 ConnectConfig for a single auth attempt.
 *
 * Strict invariant: this function MUST set exactly one of `privateKey` or
 * `password`, never both. Auth-method routing happens upstream via
 * SSH_KEY_HOSTS — by the time we reach this function we know whether
 * we're using key or password for this specific host. Setting only one
 * means ssh2 makes exactly one auth attempt; a rejection produces one
 * failed-login log entry, no fallback to compound it.
 *
 * Never sets `agent` (no ssh-agent auto-discovery) or `tryKeyboard` (no
 * keyboard-interactive fallback) — those would offer additional auth
 * methods and amplify failed-login counts.
 *
 * Exported for unit testing the auth-method invariant.
 */
export function buildConnectOpts(
  entry: ServerEntry,
  authMode: SshAuthMode,
  password: string | undefined,
  passphrase: string | undefined,
  privateKeyBytes: Buffer | undefined,
): ConnectConfig {
  const opts: ConnectConfig = {
    host: entry.host,
    port: 22,
    username: entry.sshUser,
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
 * Execute a read-only command on a BC Gov server via ssh2 (raw, no rate
 * limit). Use the exported {@link sshExec} below for the rate-limited
 * public entry point.
 *
 * Authentication:
 *   - Default: password auth via SERVER_A_PASSWORD (~/.raven/.env)
 *   - Opt-in: key-based auth via SSH_KEY_PATH (~/.raven/.env)
 *
 * Sudo (when entry.sudoUser is set) always uses SERVER_A_PASSWORD on stdin,
 * regardless of which SSH auth method was used.
 */
/**
 * Resolve auth mode and build the ssh2 ConnectConfig for an entry, reading
 * SSH_KEY_PATH / SSH_KEY_HOSTS / SERVER_A_PASSWORD from the environment.
 *
 * Shared by {@link sshExecRaw} (buffered) and {@link sshExecStream}
 * (streaming) so both honour the identical single-auth-method invariant.
 * Returns `{ ok: false, stderr }` on any misconfiguration so callers can
 * surface a clean error before opening a connection.
 */
function prepareConnection(
  entry: ServerEntry,
):
  | { ok: true; connectOpts: ConnectConfig; password: string | undefined }
  | { ok: false; stderr: string } {
  const authMode = getSshAuthMode(
    entry.host,
    loadEnvVar("SSH_KEY_PATH"),
    loadEnvVar("SSH_KEY_HOSTS"),
  );
  if (authMode.kind === "error") {
    return { ok: false, stderr: authMode.message };
  }

  // SERVER_A_PASSWORD is required for password-based SSH and for sudo.
  // The only case where it's not strictly needed is key-auth + no sudo.
  const password = loadEnvVar("SERVER_A_PASSWORD");
  if (authMode.kind === "password" && !password) {
    return { ok: false, stderr: "SERVER_A_PASSWORD not set. Add it to ~/.raven/.env." };
  }
  if (entry.sudoUser && !password) {
    return { ok: false, stderr: "SERVER_A_PASSWORD not set (required for sudo). Add it to ~/.raven/.env." };
  }

  try {
    const privateKeyBytes =
      authMode.kind === "key" ? readFileSync(authMode.keyPath) : undefined;
    const passphrase =
      authMode.kind === "key" ? loadEnvVar("SSH_KEY_PASSPHRASE") : undefined;
    const connectOpts = buildConnectOpts(entry, authMode, password, passphrase, privateKeyBytes);
    return { ok: true, connectOpts, password };
  } catch (err) {
    return { ok: false, stderr: err instanceof Error ? err.message : String(err) };
  }
}

async function sshExecRaw(
  entry: ServerEntry,
  command: string,
  timeoutMs: number = 120_000,
): Promise<SshResult> {
  const prep = prepareConnection(entry);
  if (!prep.ok) {
    return { stdout: "", stderr: prep.stderr, exitCode: 1 };
  }
  const { connectOpts, password } = prep;
  const fullCommand = buildRemoteCommand(command, entry.sudoUser);

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

        // Pipe sudo password to stdin for sudo -S (only needed when using sudo)
        if (entry.sudoUser && password) {
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
 * Streaming counterpart to {@link sshExec} for large payloads (e.g. full log
 * downloads) where buffering the whole output in memory would risk OOM.
 *
 * Resolves once the remote command is executing and hands back the live
 * stdout stream; the caller pipes it onward (e.g. through gzip to an HTTP
 * response). The underlying SSH connection is closed automatically when the
 * stream ends, errors, or is destroyed by the caller.
 *
 * Rejects — before any byte is emitted — on misconfiguration or a
 * connection/exec failure, so callers can still send a clean error status
 * before committing response headers. `timeoutMs` bounds only the
 * connect-and-exec handshake; once the stream is flowing there is no
 * completion timeout, since a legitimate large download may take a while.
 *
 * Unlike {@link sshExec} this is NOT rate-limited — downloads are explicit,
 * one-shot user actions rather than automated polling.
 */
export function sshExecStream(
  entry: ServerEntry,
  command: string,
  timeoutMs: number = 180_000,
): Promise<Readable> {
  const prep = prepareConnection(entry);
  if (!prep.ok) {
    return Promise.reject(new Error(prep.stderr));
  }
  const { connectOpts, password } = prep;
  const fullCommand = buildRemoteCommand(command, entry.sudoUser);

  return new Promise<Readable>((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(new Error("SSH connection timed out."));
    }, timeoutMs);

    conn.once("ready", () => {
      conn.exec(fullCommand, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            conn.end();
            reject(err);
          }
          return;
        }

        // Pipe the sudo password to stdin for sudo -S (only when sudoing).
        if (entry.sudoUser && password) {
          stream.stdin.write(password + "\n");
        }
        stream.stdin.end();

        // Tie the connection lifetime to the stream: close it on normal end,
        // on stream error, or when the caller destroys the stream (e.g. the
        // HTTP client disconnected mid-download).
        stream.once("close", () => conn.end());
        stream.once("error", () => conn.end());

        clearTimeout(timer);
        settled = true;
        resolve(stream);
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    try {
      conn.connect(connectOpts);
    } catch (err) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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
  ([entry]) => entry.host,
  sshLimiterOpts(),
);
