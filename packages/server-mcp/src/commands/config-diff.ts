import type { ServerEntry } from "@nrs/auth";
import { sshExec } from "../ssh-client.js";

export type ConfigFile = "context.xml" | "web.xml" | "server.xml";

const ALLOWED_CONFIG_FILES = new Set<ConfigFile>(["context.xml", "web.xml", "server.xml"]);

/** Build remote path for a config file based on the app structure. */
function buildRemotePath(appsBase: string, app: string, component: string, file: ConfigFile): string {
  switch (file) {
    case "context.xml": return `${appsBase}/${app}/${component}/current/webapps/${component}/META-INF/context.xml`;
    case "web.xml":     return `${appsBase}/${app}/${component}/current/webapps/${component}/WEB-INF/web.xml`;
    case "server.xml":  return `${appsBase}/${app}/${component}/current/tomcat/conf/server.xml`;
  }
}

/** Fetch a config file from a remote server. Returns content or null if not found. */
async function fetchConfig(
  entry: ServerEntry,
  app: string,
  component: string,
  file: ConfigFile,
): Promise<string | null> {
  const path = buildRemotePath(entry.appsBase, app, component, file);
  // Use delimiters to cleanly extract file content from SSH output noise
  const command = `echo '___BEGIN___' && cat ${path} 2>/dev/null && echo '___END___' || echo '___NOTFOUND___'`;
  const result = await sshExec(entry, command);
  const output = result.stdout;
  if (!output.includes("___BEGIN___") || !output.includes("___END___")) return null;
  const content = output
    .split("___BEGIN___")[1]
    ?.split("___END___")[0]
    ?.trim() ?? "";
  return content.length > 0 ? content : null;
}

/** Generate a unified-style diff between two strings. Returns null if identical. */
function simpleDiff(labelA: string, labelB: string, a: string, b: string): string | null {
  if (a === b) return null;
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const lines: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen; i++) {
    const la = linesA[i];
    const lb = linesB[i];
    if (la !== lb) {
      if (la !== undefined) lines.push(`- ${la}`);
      if (lb !== undefined) lines.push(`+ ${lb}`);
    }
  }
  return lines.join("\n");
}

/** Compare a config file across multiple servers. */
export async function diffConfig(
  entries: ServerEntry[],
  app: string,
  component: string,
  file: ConfigFile,
): Promise<string> {
  if (!ALLOWED_CONFIG_FILES.has(file)) {
    return `Error: Unknown config file '${file}'. Use: context.xml, web.xml, server.xml`;
  }
  if (entries.length < 2) {
    return "Error: Need at least 2 servers to compare.";
  }

  const fetched: { name: string; content: string }[] = [];
  for (const entry of entries) {
    const content = await fetchConfig(entry, app, component, file);
    fetched.push({
      name: entry.name,
      content: content ?? `(not found on ${entry.name})`,
    });
  }

  const lines: string[] = [`Comparing ${file} for ${app}/${component}\n`];
  let hasDiffs = false;

  for (let i = 0; i < fetched.length - 1; i++) {
    for (let j = i + 1; j < fetched.length; j++) {
      lines.push(`--- ${fetched[i].name} vs ${fetched[j].name} ---`);
      const diff = simpleDiff(
        `${fetched[i].name}: ${app}/${component}/${file}`,
        `${fetched[j].name}: ${app}/${component}/${file}`,
        fetched[i].content,
        fetched[j].content,
      );
      if (diff) {
        lines.push(diff);
        hasDiffs = true;
      } else {
        lines.push("No differences.");
      }
      lines.push("");
    }
  }

  if (!hasDiffs) {
    lines.push(`All servers have identical ${file} for ${app}/${component}.`);
  }

  return lines.join("\n");
}
