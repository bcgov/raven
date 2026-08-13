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
 * created by scripts/setup-credentials.ps1) it is decrypted first. The
 * plain-text ~/.raven/.env is still loaded afterwards as a fallback, so
 * both mechanisms can coexist.
 *
 * Call this once at server startup before initialising any clients.
 */
export function loadEnv(): void {
  // 1. Try DPAPI-encrypted credentials on Windows first.
  if (process.platform === "win32") {
    loadDpapi();
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
 * missing/unreadable.
 */
export function loadEnvVar(
  name: string,
  envPath = join(homedir(), ".raven", ".env"),
): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
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
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const rawValue = m[2];
    if (!rawValue || /^["'`]/.test(rawValue)) continue;
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
