import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export interface DeployEntry {
  server: string;
  app: string;
  component: string;
  version: string;
  previousVersion: string | null;
  /** ISO timestamp from the directory's modification time on the server. */
  deployedAt: string;
  /** Whether this is the currently active version. */
  isCurrent: boolean;
}

const SKIP_DIRS = ["logs", "jdk", "liferay", "s6_", "temp", "wwwadm", "wwwsvr", "midtadm", "nrscdua", "Backup"];

/**
 * Build remote command emitting one line per component:
 *   APP|COMP|CURRENT_VER|ver1:epoch,ver2:epoch,...
 * Mirrors ~/bin/server-deploy-history remote_cmd.
 */
export function buildDeployHistoryCommand(appsBase: string, appFilter?: string): string {
  const skipCase = SKIP_DIRS.map((d) => (d.endsWith("_") ? `${d}*` : d)).join("|");
  const filterClause = appFilter ? `    [ "$app" != "${appFilter}" ] && continue\n` : "";
  return `
for app_dir in ${appsBase}/*/; do
  [ -d "$app_dir" ] || continue
  app=$(basename "$app_dir")
  case "$app" in ${skipCase}|jdk*|s6_*) continue ;; esac
${filterClause}  for comp_dir in "$app_dir"*/; do
    comp=$(basename "$comp_dir")
    [ -d "$comp_dir" ] || continue
    if [ -L "\${comp_dir}current" ]; then
      current_ver=$(basename "$(readlink "\${comp_dir}current")")
      ver_list=""
      for ver_dir in "\${comp_dir}"*/; do
        [ -d "$ver_dir" ] || continue
        ver_name=$(basename "$ver_dir")
        [ "$ver_name" = "current" ] && continue
        ts=$(stat -c "%Y" "$ver_dir" 2>/dev/null || echo "0")
        if [ -n "$ver_list" ]; then ver_list="\${ver_list},\${ver_name}:\${ts}"
        else ver_list="\${ver_name}:\${ts}"; fi
      done
      echo "\${app}|\${comp}|\${current_ver}|\${ver_list}"
    fi
  done
done`.trim();
}

/**
 * Parse the pipe-delimited deploy lines into a flat timeline (newest first).
 * Versions with epoch=0 are skipped (stat returned 0).
 */
export function parseDeployHistoryOutput(raw: string, server: string): DeployEntry[] {
  const entries: DeployEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!/^[A-Z][A-Z0-9_-]*\|/.test(trimmed)) continue;
    const parts = trimmed.split("|");
    if (parts.length < 4) continue;
    const [app, component, currentVer, verListStr] = parts;
    if (!app || !component || !currentVer) continue;

    const versions = (verListStr || "")
      .split(",")
      .filter(Boolean)
      .map((v) => {
        const colon = v.lastIndexOf(":");
        if (colon < 0) return null;
        const ver = v.slice(0, colon);
        const epoch = parseInt(v.slice(colon + 1), 10);
        if (!ver || isNaN(epoch) || epoch === 0) return null;
        return { version: ver, epochMs: epoch * 1000 };
      })
      .filter((v): v is { version: string; epochMs: number } => v !== null);

    versions.sort((a, b) => b.epochMs - a.epochMs);

    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      const prev = versions[i + 1];
      entries.push({
        server,
        app,
        component,
        version: v.version,
        previousVersion: prev ? prev.version : null,
        deployedAt: new Date(v.epochMs).toISOString(),
        isCurrent: v.version === currentVer.trim(),
      });
    }
  }

  return entries;
}

/** Fetch deploy timeline for one server. */
export async function fetchDeployHistory(
  entry: ServerEntry,
  appFilter?: string,
  timeoutMs: number = 120_000,
): Promise<DeployEntry[]> {
  const command = buildDeployHistoryCommand(entry.appsBase, appFilter);
  const result = await sshExec(entry, command, timeoutMs);
  return parseDeployHistoryOutput(result.stdout, entry.name);
}
