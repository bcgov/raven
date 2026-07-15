#!/usr/bin/env node

/**
 * RAVEN Auth CLI - Authenticate to BC Gov SiteMinder and cache the session.
 *
 * Run this before using RAVEN tools in MstyStudio or other non-interactive
 * contexts. Opens a browser window for IDIR login, captures the SMSESSION
 * cookie, and caches it to ~/.workflow-suite/session.json (25 min TTL).
 *
 * Usage:
 *   npx raven-auth
 *   node packages/auth/dist/cli.js
 */

import { SessionManager } from "./session-manager.js";
import { readCachedSession } from "./cookie-cache.js";
import { join } from "node:path";
import { homedir } from "node:os";

const cachePath = join(homedir(), ".workflow-suite", "session.json");

async function main(): Promise<void> {
  console.log("RAVEN Auth - SiteMinder Session Manager");
  console.log("======================================\n");

  // Check if we already have a valid session
  const existing = await readCachedSession(cachePath, 1500);
  if (existing) {
    console.log("Valid SMSESSION found in cache.");
    console.log(`  Cache:  ~/.workflow-suite/session.json`);
    console.log("\nYour RAVEN tools should work. Session refreshes automatically.");
    return;
  }

  console.log("No valid session found. Opening browser for IDIR login...");
  console.log("  - A Chromium window will open");
  console.log("  - Log in with your IDIR credentials");
  console.log("  - The window closes automatically once authenticated\n");

  const sm = new SessionManager();

  try {
    const cookie = await sm.authenticate();
    console.log("\nAuthentication successful!");
    console.log(`  Cached: ~/.workflow-suite/session.json`);
    console.log(`  TTL:    25 minutes`);
    console.log("\nYour RAVEN tools (Jira, Confluence, Bitbucket) are ready to use.");
  } catch (err) {
    console.error(
      "\nAuthentication failed:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }
}

main();
