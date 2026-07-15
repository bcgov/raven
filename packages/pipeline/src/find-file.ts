#!/usr/bin/env node
/** Quick script to find a file in a Bitbucket repo by name pattern. */
import { loadEnv, createBasicAuthFetch } from "@nrs/auth";
import { BitbucketClient } from "@nrs/bitbucket-mcp/client";

loadEnv();
const f = createBasicAuthFetch(
  process.env["ATLASSIAN_EMAIL"]!,
  process.env["ATLASSIAN_PASSWORD"]!
);
const bb = new BitbucketClient(
  f,
  process.env["ATLASSIAN_BASE_URL"]! + "/int/stash"
);

const project = process.argv[2] ?? "CWM";
const repo = process.argv[3] ?? "cwm-sos-api";
const pattern = process.argv[4] ?? "UUID";

async function walk(path: string, depth: number): Promise<void> {
  if (depth > 15) return;
  try {
    const browse = await bb.browseFiles(project, repo, path);
    const children = browse.children?.values;
    if (!children) return;
    for (const child of children) {
      const cp = path ? `${path}/${child.path.toString}` : child.path.toString;
      if (child.type === "FILE" && child.path.toString.toLowerCase().includes(pattern.toLowerCase())) {
        console.log(cp);
      } else if (child.type === "DIRECTORY") {
        await walk(cp, depth + 1);
      }
    }
  } catch {
    // skip inaccessible dirs
  }
}

console.log(`Searching ${project}/${repo} for files matching "${pattern}"...`);
await walk("", 0);
console.log("Done");
