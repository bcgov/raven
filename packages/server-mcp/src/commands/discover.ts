import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export interface AppInfo {
  app: string;
  component: string;
  version: string;
  port: string;
}

const SKIP_DIRS = new Set([
  "logs", "liferay", "temp", "wwwadm", "wwwsvr", "midtadm", "nrscdua", "Backup",
]);

/**
 * Build the bash command that discovers apps on a remote server.
 * Mirrors the remote_cmd in ~/bin/server-discover.
 * Outputs lines: APP|COMP|VERSION|PORT
 */
export function buildDiscoverCommand(appsBase: string, appFilter?: string): string {
  const filterClause = appFilter
    ? `    [ "$app" != "${appFilter}" ] && continue\n`
    : "";
  const skipList = [...SKIP_DIRS].join("|");

  return `
for app_dir in ${appsBase}/*/; do
  [ -d "$app_dir" ] || continue
  app=$(basename "$app_dir")
  case "$app" in
    ${skipList}|jdk*|s6_*) continue ;;
  esac
${filterClause}  for comp_dir in "$app_dir"*/; do
    comp=$(basename "$comp_dir")
    [ -d "$comp_dir" ] || continue
    if [ -L "\${comp_dir}current" ]; then
      version=$(basename "$(readlink "\${comp_dir}current")")
      port=""
      for pf in "\${comp_dir}"port:*; do
        [ -e "$pf" ] && port=$(basename "$pf") && break
      done
      echo "\${app}|\${comp}|\${version}|\${port}"
    fi
  done
done`.trim();
}

/**
 * Parse pipe-delimited app lines from discover command output.
 * Ignores header/status lines that don't match APP|COMP|VER|PORT format.
 */
export function parseDiscoverOutput(raw: string): AppInfo[] {
  return raw
    .split("\n")
    .filter(line => /^[A-Z][A-Z0-9_-]*\|/.test(line.trim()))
    .map(line => {
      const [app = "", component = "", version = "", port = ""] = line.trim().split("|");
      return { app, component, version, port };
    });
}

/** Discover all deployed apps on a server. */
export async function discoverApps(
  entry: ServerEntry,
  appFilter?: string,
): Promise<{ output: string; exitCode: number }> {
  const command = buildDiscoverCommand(entry.appsBase, appFilter);
  const result = await sshExec(entry, command);
  return { output: result.stdout || result.stderr, exitCode: result.exitCode };
}
