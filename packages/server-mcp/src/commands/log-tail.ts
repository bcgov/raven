import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";
import type { LogType } from "./log-search.js";

/**
 * Build the remote `tail -n N` command for a Tomcat app log. Falls back to
 * the newest matching log file if the canonical name (current-day for
 * catalina/access, plain for app) is absent.
 *
 * Mirrors ~/bin/server-tail-batch remote_cmd. The shell parameter expansion
 * `$(date +%Y-%m-%d)` happens on the remote side at exec time, so dated
 * filenames always refer to "today on the server".
 */
export function buildTailCommand(
  logsBase: string,
  app: string,
  component: string,
  logType: LogType,
  lines: number,
): string {
  const logDir = `${logsBase}/${app}/${component}`;
  let logFile: string;
  let fallbackGlob: string;
  switch (logType) {
    case "app":
      logFile = `${logDir}/${component}.log`;
      fallbackGlob = `${component}*.log`;
      break;
    case "catalina":
      logFile = `${logDir}/catalina.$(date +%Y-%m-%d).log`;
      fallbackGlob = "catalina*.log";
      break;
    case "access":
      logFile = `${logDir}/localhost_access_log.$(date +%Y-%m-%d).log`;
      fallbackGlob = "localhost_access_log*.log";
      break;
  }
  return (
    `if [ -f ${logFile} ]; then tail -n ${lines} ${logFile};` +
    ` else newest=$(ls -t ${logDir}/${fallbackGlob} 2>/dev/null | head -1);` +
    `   if [ -n "$newest" ]; then tail -n ${lines} "$newest";` +
    `   else echo 'Log file not found: ${logFile}'; fi; fi`
  );
}

/** Return the last `lines` lines of the chosen log on a remote server. */
export async function tailLog(
  entry: ServerEntry,
  app: string,
  component: string,
  logType: LogType,
  lines: number,
  timeoutMs: number = 60_000,
): Promise<{ output: string; exitCode: number }> {
  const command = buildTailCommand(entry.logsBase, app, component, logType, lines);
  const result = await sshExec(entry, command, timeoutMs);
  return { output: result.stdout || result.stderr, exitCode: result.exitCode };
}
