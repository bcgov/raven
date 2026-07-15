import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";
import { buildDiscoverCommand } from "./discover.js";

/**
 * Parse pipe-delimited version lines into a Map keyed by "APP|COMP".
 * Reuses the same output format as discover (APP|COMP|VERSION|PORT).
 */
export function parseVersionOutput(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!/^[A-Z][A-Z0-9_-]*\|/.test(trimmed)) continue;
    const parts = trimmed.split("|");
    if (parts.length < 3) continue;
    const key = `${parts[0]}|${parts[1]}`;
    result.set(key, parts[2] ?? "");
  }
  return result;
}

/**
 * Detect components where different servers report different versions.
 * Ignores "—" (not deployed on that server).
 * Returns a list of "APP/COMP" strings that have mismatches.
 */
export function detectMismatches(
  serverData: Map<string, Map<string, string>>,
): string[] {
  // Collect all known app|comp keys
  const allKeys = new Set<string>();
  for (const versions of serverData.values()) {
    for (const key of versions.keys()) allKeys.add(key);
  }

  const mismatches: string[] = [];
  for (const key of allKeys) {
    const versions = [...serverData.values()]
      .map(m => m.get(key) ?? "—")
      .filter(v => v !== "—");
    if (versions.length > 1 && new Set(versions).size > 1) {
      const [app = "", comp = ""] = key.split("|");
      mismatches.push(`${app}/${comp}`);
    }
  }
  return mismatches;
}

/** Fetch version data for all apps on a single server. */
export async function fetchVersions(
  entry: ServerEntry,
  appFilter?: string,
): Promise<Map<string, string>> {
  const command = buildDiscoverCommand(entry.appsBase, appFilter);
  const result = await sshExec(entry, command);
  return parseVersionOutput(result.stdout);
}
