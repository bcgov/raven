#!/usr/bin/env node
// Generate the catalog region of docs/TOOL_INVENTORY.md from code.
//
//   node scripts/gen-inventory.mjs          # rewrite the generated region in place
//   node scripts/gen-inventory.mjs --check  # fail (exit 1) if the region is stale
//
// Only the block between the GEN:START / GEN:END markers is owned by this script;
// the surrounding prose (intro, env-var table, "how this was derived") is curated.
// Run after `npm run build` — it imports each server's built dist/server.js factory.
import "./gen-setup.mjs"; // MUST be first — sets placeholder host config before any server module loads
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classify, render, spliceRegion } from "./gen-inventory.lib.mjs";

import { createJiraServer } from "../packages/jira-mcp/dist/server.js";
import { createConfluenceServer } from "../packages/confluence-mcp/dist/server.js";
import { createBitbucketServer } from "../packages/bitbucket-mcp/dist/server.js";
import { createAdoServer } from "../packages/ado-mcp/dist/server.js";
import { createAssetsServer } from "../packages/assets-mcp/dist/server.js";
import { createServerMonitoringServer } from "../packages/server-mcp/dist/server.js";
import { createImisServer } from "../packages/imis-mcp/dist/server.js";
import { createSonarServer } from "../packages/sonar-mcp/dist/server.js";
import { createJenkinsServer } from "../packages/jenkins-mcp/dist/server.js";
import { createHealthServer } from "../packages/health-mcp/dist/server.js";
import { createOverviewServer } from "../packages/overview-mcp/dist/server.js";
import { createBugClassifierServer } from "../packages/bug-classifier-mcp/dist/server.js";
import { createRfcBuddyServer } from "../packages/rfcbuddy-mcp/dist/server.js";
import { createArtifactoryServer } from "../packages/artifactory-mcp/dist/server.js";

const INVENTORY = fileURLToPath(new URL("../docs/TOOL_INVENTORY.md", import.meta.url));

// Display order + grouping for the static (locally-registered) servers.
const SERVERS = [
  { display: "Jira", pkg: "jira-mcp", mcpKey: "jira", group: "Atlassian (shared auth session)", factory: createJiraServer },
  { display: "Confluence", pkg: "confluence-mcp", mcpKey: "confluence", group: "Atlassian (shared auth session)", factory: createConfluenceServer },
  { display: "Bitbucket", pkg: "bitbucket-mcp", mcpKey: "bitbucket", group: "Atlassian (shared auth session)", factory: createBitbucketServer },
  { display: "Assets (CMDB)", pkg: "assets-mcp", mcpKey: "assets", group: "Atlassian (shared auth session)", factory: createAssetsServer },
  { display: "Overview", pkg: "overview-mcp", mcpKey: "overview", group: "Atlassian (shared auth session)", factory: createOverviewServer },
  { display: "Health", pkg: "health-mcp", mcpKey: "health", group: "Atlassian (shared auth session)", factory: createHealthServer },
  { display: "Bug Classifier", pkg: "bug-classifier-mcp", mcpKey: "bug-classifier", group: "Atlassian (shared auth session)", factory: createBugClassifierServer },
  { display: "Server Monitor", pkg: "server-mcp", mcpKey: "server-monitor", group: "Server / infrastructure", factory: createServerMonitoringServer, note: "`.mcp.json` key is `server-monitor`; tools are exposed to the AI as `mcp__server-monitor__*`." },
  { display: "IMIS", pkg: "imis-mcp", mcpKey: "imis", group: "Server / infrastructure", factory: createImisServer },
  { display: "Azure DevOps", pkg: "ado-mcp", mcpKey: "ado", group: "Azure DevOps", factory: createAdoServer },
  { display: "Sonar", pkg: "sonar-mcp", mcpKey: "sonar", group: "Code quality", factory: createSonarServer },
  { display: "Jenkins", pkg: "jenkins-mcp", mcpKey: "jenkins", group: "CI/CD", factory: createJenkinsServer },
  { display: "RFC Buddy", pkg: "rfcbuddy-mcp", mcpKey: "rfcbuddy", group: "RFC tracking & schedules", factory: createRfcBuddyServer },
  { display: "Artifactory", pkg: "artifactory-mcp", mcpKey: "artifactory", group: "Build and artifact infrastructure", factory: createArtifactoryServer },
];

async function listTools(factory) {
  const server = factory();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gen-inventory", version: "0.0.0" }, { capabilities: {} });
  try {
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function collect() {
  const data = [], missing = [];
  for (const s of SERVERS) {
    const tools = await listTools(s.factory);
    const c = classify(tools, s.pkg);
    missing.push(...c.missing);
    data.push({ display: s.display, pkg: s.pkg, mcpKey: s.mcpKey, group: s.group, note: s.note, total: tools.length, read: c.read, write: c.write });
  }
  return { data, missing };
}

const check = process.argv.includes("--check");
const { data, missing } = await collect();

if (missing.length) {
  console.error(`ERROR: ${missing.length} tool(s) are missing an explicit readOnlyHint annotation:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error("Every server.tool() must declare { readOnlyHint: true|false }.");
  process.exit(1);
}

const file = readFileSync(INVENTORY, "utf8");
let next;
try {
  next = spliceRegion(file, render(data));
} catch (e) {
  console.error(`ERROR: ${e.message} in ${INVENTORY}`);
  process.exit(1);
}

if (check) {
  if (next !== file) {
    console.error("ERROR: docs/TOOL_INVENTORY.md is out of date. Run `npm run gen-inventory` and commit the result.");
    process.exit(1);
  }
  console.log("TOOL_INVENTORY.md is up to date.");
} else {
  writeFileSync(INVENTORY, next);
  const localTotal = data.reduce((n, s) => n + s.total, 0);
  console.log(`Wrote ${INVENTORY} — ${localTotal} local tools across ${data.length} servers (+ jarvis).`);
}
