import { config } from "dotenv";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
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
  config({
    path: join(homedir(), ".raven", ".env"),
    override: false, // don't clobber existing env vars
    quiet: true, // suppress stdout banner — required for MCP stdio transport
  });
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
