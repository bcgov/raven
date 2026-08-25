import { config, parse } from "dotenv";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Load Atlassian credentials from ~/.raven/.env into process.env.
 *
 * Only sets variables that are NOT already set, so explicit env vars
 * (e.g. from .mcp.json or the shell) always take precedence.
 *
 * On Windows, if ~/.raven/.env.dpapi exists (a DPAPI-encrypted JSON file
 * created by scripts/setup-credentials.ps1) it is decrypted first. On
 * macOS, the login keychain item written by scripts/setup-credentials-mac.mjs
 * is read first. The plain-text ~/.raven/.env is still loaded afterwards as
 * a fallback, so both mechanisms can coexist.
 *
 * Call this once at server startup before initialising any clients.
 */
export function loadEnv(): void {
  // 1. Try OS-encrypted credentials first.
  if (process.platform === "win32") {
    loadDpapi();
  } else if (process.platform === "darwin") {
    loadKeychain();
  }

  // 2. Fall back to plain-text .env (values already set are NOT overwritten).
  const envPath = join(homedir(), ".raven", ".env");
  config({
    path: envPath,
    override: false, // don't clobber existing env vars
    quiet: true, // suppress stdout banner — required for MCP stdio transport
  });
  warnUnquotedHashes(envPath);
}

/**
 * Read a single variable with dotenv semantics: process.env wins, otherwise
 * the value comes from the given .env file (default ~/.raven/.env). Quoted
 * and unquoted values are both accepted; quotes are stripped only when they
 * wrap the whole value.
 *
 * Returns undefined when the variable is unset, empty, or the file is
 * missing/unreadable. An env var explicitly set to the empty string counts
 * as deliberately cleared (mirroring dotenv's override:false) — the file
 * value is NOT used in that case.
 */
export function loadEnvVar(
  name: string,
  envPath = join(homedir(), ".raven", ".env"),
): string | undefined {
  if (name in process.env) return process.env[name] || undefined;
  try {
    return parse(readFileSync(envPath, "utf-8"))[name] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find keys whose unquoted value contains a '#' glued to surrounding text.
 * dotenv treats an unquoted '#' as the start of an inline comment, so such
 * values are silently truncated — a common cause of broken authentication
 * when a password contains '#'. Values wrapped in quotes are safe, and a
 * '#' preceded by whitespace is assumed to be an intentional comment.
 */
export function findUnquotedHashKeys(content: string): string[] {
  // dotenv's quoted-value grammar: the opening delimiter must be closed
  // (backslash-escaped delimiters allowed inside, newlines allowed for
  // multiline values) and followed only by whitespace and an optional
  // comment before the end of the line — otherwise dotenv backtracks and
  // treats the whole value as unquoted.
  const quotedValue: Record<string, RegExp> = {
    '"': /^"(?:\\"|[^"])*"[ \t]*(?:#[^\n]*)?(?=\n|$)/,
    "'": /^'(?:\\'|[^'])*'[ \t]*(?:#[^\n]*)?(?=\n|$)/,
    "`": /^`(?:\\`|[^`])*`[ \t]*(?:#[^\n]*)?(?=\n|$)/,
  };
  const keys: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/);
    if (!m) continue;
    // Keep the raw (untrimmed) value so "KEY= #comment" reads as a comment
    // separated by whitespace rather than a '#' glued to the '=' sign.
    const rawValue = m[2]!;
    const value = rawValue.trimStart();
    if (!value) continue;
    const re = quotedValue[value[0]!];
    if (re) {
      // Join with the following lines so a valid multiline quoted value is
      // recognized; skip its continuation lines when it closes.
      const closed = [value, ...lines.slice(i + 1)].join("\n").match(re);
      if (closed) {
        i += closed[0].split("\n").length - 1;
        continue;
      }
    }
    if (/(^|\S)#/.test(rawValue)) keys.push(m[1]!);
  }
  return keys;
}

/**
 * Warn (on stderr — stdout is reserved for the MCP stdio transport) about
 * values that dotenv will silently truncate at an unquoted '#'.
 */
function warnUnquotedHashes(envPath: string): void {
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const key of findUnquotedHashKeys(content)) {
      console.error(
        `[raven] Warning: the value of ${key} in ${envPath} contains an unquoted '#'. ` +
          `Everything from the '#' on is treated as a comment and dropped, which can break authentication. ` +
          `If the '#' is part of the value, wrap the whole value in double quotes.`,
      );
    }
  } catch {
    // File missing or unreadable — nothing to warn about.
  }
}

/** Keychain item coordinates; the service can be overridden for testing. */
export const KEYCHAIN_ACCOUNT = "credentials";
const DEFAULT_KEYCHAIN_SERVICE = "raven";

/** Encode a credential record as the base64 JSON blob stored in the keychain. */
export function encodeKeychainBlob(record: Record<string, string>): string {
  return Buffer.from(JSON.stringify(record), "utf-8").toString("base64");
}

/**
 * Decode the keychain blob back into a credential record. Non-string values
 * are dropped. Throws on malformed input — readKeychainRecord() wraps the
 * throw as KeychainReadError; loadKeychain() swallows it.
 */
export function decodeKeychainBlob(blob: string): Record<string, string> {
  const parsed = JSON.parse(Buffer.from(blob.trim(), "base64").toString("utf-8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Keychain blob is not a JSON object");
  }
  const record: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === "string") record[key] = val;
  }
  return record;
}

/** Minimal execFileSync shape so tests can inject a fake `security` binary. */
export type KeychainExec = (
  cmd: string,
  args: string[],
  opts: { encoding?: "utf-8"; timeout?: number; stdio?: unknown; input?: string },
) => string;

const SECURITY_BIN = "/usr/bin/security";

/** Keychain service name; RAVEN_KEYCHAIN_SERVICE overrides it for testing. */
export function keychainService(): string {
  const value = process.env["RAVEN_KEYCHAIN_SERVICE"] || DEFAULT_KEYCHAIN_SERVICE;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("RAVEN_KEYCHAIN_SERVICE must match /^[A-Za-z0-9._-]+$/");
  }
  return value;
}

/**
 * Thrown by readKeychainRecord() when the keychain item exists but cannot be
 * read: the keychain is locked and the unlock prompt was dismissed, access
 * was denied, `security` timed out, or the stored blob is corrupt. Distinct
 * from "item does not exist" (which readKeychainRecord reports as null) so
 * callers never mistake a transient read failure for an empty record.
 */
export class KeychainReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainReadError";
  }
}

/** True when a `security` failure means "no such item" (errSecItemNotFound). */
function isKeychainItemNotFound(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  if (status === 44) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /could not be found/i.test(message);
}

/**
 * Read the RAVEN credential blob from the login keychain. Returns null ONLY
 * when the item does not exist. Any other read failure (locked keychain,
 * access denied, `security` unavailable) or a corrupt/malformed blob throws
 * KeychainReadError instead — treating those as "no credentials stored"
 * would let a caller like setKeychainEntry silently overwrite every stored
 * credential with just the one new key.
 */
export function readKeychainRecord(
  exec: KeychainExec = execFileSync as unknown as KeychainExec,
): Record<string, string> | null {
  const service = keychainService(); // throws before exec on an invalid service name
  let output: string;
  try {
    output = exec(
      SECURITY_BIN,
      ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"],
      {
        encoding: "utf-8",
        timeout: 10_000,
        // Suppress stderr so security warnings don't leak to stdout (MCP stdio transport)
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch (err) {
    if (isKeychainItemNotFound(err)) return null;
    const message = err instanceof Error ? err.message : String(err);
    throw new KeychainReadError(
      `Keychain item exists but could not be read (locked, access denied, or corrupt): ${message}`,
    );
  }
  try {
    return decodeKeychainBlob(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KeychainReadError(
      `Keychain item exists but could not be read (locked, access denied, or corrupt): ${message}`,
    );
  }
}

/** `security -i` reads each command through a 4096-byte buffer (measured: 4095-byte chunks). */
const SECURITY_MAX_LINE = 4095;

/**
 * Replace the RAVEN credential blob in the login keychain. Uses `security -i`
 * so the blob travels on stdin, never in the process argument list where any
 * same-user process could momentarily see it. Throws on failure.
 *
 * `security -i` executes stdin in SECURITY_MAX_LINE-byte chunks: an oversized
 * command line would have its first chunk run (replacing the item with a
 * truncated, undecodable blob) before the tail fails. To avoid destroying
 * stored credentials, the full line is measured and rejected before `security`
 * is invoked at all.
 */
export function writeKeychainRecord(
  record: Record<string, string>,
  exec: KeychainExec = execFileSync as unknown as KeychainExec,
): void {
  const service = keychainService(); // throws before exec on an invalid service name
  const blob = encodeKeychainBlob(record);
  const line = `add-generic-password -U -s ${service} -a ${KEYCHAIN_ACCOUNT} -w ${blob}\n`;
  const lineBytes = Buffer.byteLength(line, "utf-8");
  if (lineBytes > SECURITY_MAX_LINE) {
    throw new Error(
      `Keychain record too large (${lineBytes} bytes; security -i accepts at most ${SECURITY_MAX_LINE} per command). Remove unused entries.`,
    );
  }
  exec(SECURITY_BIN, ["-i"], {
    encoding: "utf-8",
    timeout: 10_000,
    input: line,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

/** Keys stored in the keychain blob are environment-variable names. */
export const KEYCHAIN_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Set one key in the keychain blob, creating the item if needed. Other keys
 * are preserved. Throws on an invalid key, an empty value, or a write failure.
 * Not safe for concurrent writers (read-modify-write); only the interactive
 * CLI writes, MCP servers never do.
 */
export function setKeychainEntry(
  key: string,
  value: string,
  exec: KeychainExec = execFileSync as unknown as KeychainExec,
): void {
  if (!KEYCHAIN_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid keychain key "${key}": expected an UPPER_SNAKE_CASE name.`);
  }
  if (!value) {
    throw new Error(`Refusing to store an empty value for ${key}.`);
  }
  const record = readKeychainRecord(exec) ?? {};
  record[key] = value;
  writeKeychainRecord(record, exec);
}

/**
 * Remove one key from the keychain blob. Returns true when the key existed.
 * Never creates the item; a missing item or key is not an error.
 */
export function deleteKeychainEntry(
  key: string,
  exec: KeychainExec = execFileSync as unknown as KeychainExec,
): boolean {
  const record = readKeychainRecord(exec);
  if (!record || !(key in record)) return false;
  delete record[key];
  writeKeychainRecord(record, exec);
  return true;
}

/**
 * Read the RAVEN credential blob from the macOS login keychain and merge it
 * into process.env. Values are only written when the key is NOT already
 * set, preserving the explicit-env-var-wins contract. Silent no-op on any failure.
 */
export function loadKeychain(exec?: KeychainExec): void {
  let record: Record<string, string> | null;
  try {
    record = readKeychainRecord(exec);
  } catch {
    // Locked keychain, access denied, `security` unavailable, or a corrupt
    // blob — loadEnv() falls back to ~/.raven/.env, so stay silent here.
    return;
  }
  if (!record) return;
  for (const [key, val] of Object.entries(record)) {
    if (KEYCHAIN_KEY_PATTERN.test(key) && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

/**
 * Decrypt ~/.raven/.env.dpapi using PowerShell's DPAPI SecureString and
 * merge the resulting key=value pairs into process.env.
 *
 * Silently no-ops when:
 *   - the file does not exist (user hasn't run setup-credentials.ps1)
 *   - powershell.exe is not available
 *   - decryption fails for any reason
 *
 * Each value is only written into process.env when the key is NOT already
 * set, preserving the explicit-env-var-wins contract.
 */
function loadDpapi(): void {
  const dpapiPath = join(homedir(), ".raven", ".env.dpapi");
  if (!existsSync(dpapiPath)) return;

  // PowerShell one-liner: read JSON, decrypt each SecureString value, emit KEY=value lines.
  // Using -EncodedCommand avoids quoting issues with special characters in the path.
  const psScript = `
$file = '${dpapiPath.replace(/'/g, "''")}';
$data = Get-Content $file -Raw | ConvertFrom-Json;
foreach ($prop in $data.PSObject.Properties) {
  try {
    $sec  = ConvertTo-SecureString $prop.Value;
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);
    $val  = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr);
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr);
    Write-Output "$($prop.Name)=$val";
  } catch { }
}`.trim();

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");

  try {
    const output = execFileSync("powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-EncodedCommand",
      encoded,
    ], {
      encoding: "utf-8",
      timeout: 10_000,
      // Suppress stderr so any PS warnings don't leak to stdout (MCP stdio transport)
      stdio: ["ignore", "pipe", "ignore"],
    });

    for (const line of output.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1); // preserve any = in the value
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // Decryption failure (wrong user/machine) or powershell not found — silently skip.
  }
}
