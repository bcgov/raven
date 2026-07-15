import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export interface DashboardData {
  versions: Map<string, string>;  // "APP|COMP" -> version
  errors:   Map<string, number>;  // "APP|COMP" -> error count
  jvm:      Map<string, string>;  // "APP|COMP" -> Xmx setting
}

const SKIP_DIRS = ["logs", "liferay", "temp", "wwwadm", "wwwsvr", "midtadm", "nrscdua", "Backup"];

/**
 * Build the compound dashboard command for one SSH session.
 * Outputs tagged lines: VER:app|comp|ver  ERR:app|comp|count  JVM:app|comp|xmx
 * Mirrors ~/bin/server-dashboard build_dashboard_cmd().
 */
export function buildDashboardCommand(appsBase: string, logsBase: string, appFilter?: string): string {
  const skipCase = SKIP_DIRS.join("|");
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
      version=$(basename "$(readlink "\${comp_dir}current")")
      echo "VER:\${app}|\${comp}|\${version}"
    fi
  done
done
today=$(date +%Y-%m-%d)
for app_dir in ${logsBase}/*/; do
  [ -d "$app_dir" ] || continue
  app=$(basename "$app_dir")
${filterClause}  for comp_dir in "$app_dir"*/; do
    comp=$(basename "$comp_dir")
    [ -d "$comp_dir" ] || continue
    for logf in "\${comp_dir}\${comp}.log" "\${comp_dir}\${comp}.\${today}.log"; do
      if [ -f "$logf" ]; then
        count=$(grep -c -E "ERROR|FATAL|Exception|ORA-" "$logf" 2>/dev/null || echo 0)
        echo "ERR:\${app}|\${comp}|\${count}"
        break
      fi
    done
  done
done
ps -ef 2>/dev/null | grep "[j]ava" | while read -r line; do
  xmx=$(echo "$line" | grep -oE "\\-Xmx[^ ]+" | sed "s/-Xmx//" || true)
  base=$(echo "$line" | grep -oE "catalina\\.base=[^ ]+" | head -1 | cut -d= -f2 | sed "s|/current/tomcat$||; s|/current$||")
  if [ -n "$base" ]; then
    app=$(echo "$base" | awk -F/ '{print $(NF-1)}')
    comp=$(echo "$base" | awk -F/ '{print $NF}')
    echo "JVM:\${app}|\${comp}|\${xmx:-?}"
  fi
done`.trim();
}

/** Parse tagged dashboard output lines. */
export function parseDashboardOutput(raw: string): DashboardData {
  const versions = new Map<string, string>();
  const errors   = new Map<string, number>();
  const jvm      = new Map<string, string>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("VER:")) {
      const [app, comp, ver] = trimmed.slice(4).split("|");
      if (app && comp && ver) versions.set(`${app}|${comp}`, ver);
    } else if (trimmed.startsWith("ERR:")) {
      const [app, comp, count] = trimmed.slice(4).split("|");
      if (app && comp) errors.set(`${app}|${comp}`, parseInt(count ?? "0", 10));
    } else if (trimmed.startsWith("JVM:")) {
      const [app, comp, xmx] = trimmed.slice(4).split("|");
      if (app && comp && xmx) jvm.set(`${app}|${comp}`, xmx);
    }
  }

  return { versions, errors, jvm };
}

/** Run the dashboard command on a single server. */
export async function runDashboard(
  entry: ServerEntry,
  appFilter?: string,
  timeoutMs: number = 180_000,
): Promise<DashboardData> {
  const command = buildDashboardCommand(entry.appsBase, entry.logsBase, appFilter);
  const result = await sshExec(entry, command, timeoutMs);
  return parseDashboardOutput(result.stdout);
}
