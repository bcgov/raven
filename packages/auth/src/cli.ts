#!/usr/bin/env node

/**
 * RAVEN Auth CLI - Authenticate to BC Gov SiteMinder and SharePoint Online.
 *
 * Run this before using RAVEN tools in MstyStudio or other non-interactive
 * contexts. Opens a browser window for IDIR login, captures the SMSESSION
 * cookie (or SPO fedAuth/rtFa pair), and caches it.
 *
 * Usage:
 *   npx raven-auth                    # SiteMinder (default)
 *   npx raven-auth --force            # SiteMinder, ignore the cached session
 *   npx raven-auth --sharepoint       # SharePoint Online
 *   npx raven-auth --sharepoint --force
 *   node packages/auth/dist/cli.js
 *
 * The behaviour lives in `cli-run.ts` so it can be tested; this file only
 * wires it to the real managers, the environment and the process exit code.
 * The credentials (a keychain read on macOS, PowerShell on Windows) are loaded
 * only once a login is under way, so `--help` and a mistyped option never
 * touch them.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { runCli } from "./cli-run.js";
import { loadEnv } from "./load-env.js";
import { SessionManager } from "./session-manager.js";
import { readCachedSpoSession } from "./spo-cookie-cache.js";
import { SpoSessionManager } from "./spo-session-manager.js";

const spoCachePath = join(homedir(), ".workflow-suite", "spo-session.json");

let envLoaded = false;

/** Run `use` after the environment has been loaded (once). The managers and the cache TTL read it. */
function withEnv<T>(use: () => T): T {
  if (!envLoaded) {
    loadEnv();
    envLoaded = true;
  }
  return use();
}

runCli(process.argv.slice(2), {
  sessionManager: () => withEnv(() => new SessionManager()),
  spoSessionManager: () => withEnv(() => new SpoSessionManager()),
  readCachedSpoSession: () =>
    withEnv(() => readCachedSpoSession(spoCachePath, Number(process.env["SHAREPOINT_SESSION_TTL"]) || undefined)),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`\nraven-auth failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
);
