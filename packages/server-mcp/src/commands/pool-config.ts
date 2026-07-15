import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

/**
 * Build the remote command that emits a context.xml between sentinel lines.
 * Tries the canonical META-INF path first, then searches up to 3 levels deep
 * under the webapps dir — handles ROOT.war layouts and components whose
 * webapp dir doesn't match the component name.
 *
 * Mirrors ~/bin/server-read-config for the context.xml case.
 */
export function buildReadContextCommand(appsBase: string, app: string, component: string): string {
  const appBase = `${appsBase}/${app}/${component}/current`;
  return (
    `echo '___CONFIG_BEGIN___' && (` +
    `if [ -f ${appBase}/webapps/${component}/META-INF/context.xml ]; then` +
    `  cat ${appBase}/webapps/${component}/META-INF/context.xml;` +
    ` else` +
    `  f=$(find ${appBase}/webapps -maxdepth 3 -name context.xml -path '*/META-INF/*' 2>/dev/null | head -1);` +
    `  if [ -n "$f" ]; then cat "$f"; else exit 1; fi;` +
    ` fi` +
    `) && echo '___CONFIG_END___' || echo '___CONFIG_NOTFOUND___'`
  );
}

/** Extract the content between the sentinel lines; null if not present or empty. */
export function extractConfigPayload(output: string): string | null {
  const beginIdx = output.indexOf("___CONFIG_BEGIN___");
  const endIdx = output.indexOf("___CONFIG_END___");
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) return null;
  const between = output
    .slice(beginIdx + "___CONFIG_BEGIN___".length, endIdx)
    .split("\n")
    .filter((l) => !l.includes("___CONFIG_BEGIN___") && !l.includes("___CONFIG_END___"))
    .join("\n")
    .trim();
  if (!between || !between.includes("<")) return null;
  return between;
}

/** Read a deployed app's context.xml. Returns null when not found. */
export async function readContextXml(
  entry: ServerEntry,
  app: string,
  component: string,
  timeoutMs: number = 30_000,
): Promise<string | null> {
  const command = buildReadContextCommand(entry.appsBase, app, component);
  const result = await sshExec(entry, command, timeoutMs);
  return extractConfigPayload(result.stdout);
}
