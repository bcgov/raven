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
 *   npx raven-auth --sharepoint       # SharePoint Online
 *   node packages/auth/dist/cli.js
 */

import { SessionManager } from "./session-manager.js";
import { readCachedSession } from "./cookie-cache.js";
import { SpoSessionManager } from "./spo-session-manager.js";
import { readCachedSpoSession } from "./spo-cookie-cache.js";
import { join } from "node:path";
import { homedir } from "node:os";

const cachePath = join(homedir(), ".workflow-suite", "session.json");
const spoCachePath = join(homedir(), ".workflow-suite", "spo-session.json");

async function siteMinderAuth(): Promise<void> {
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
  console.log("  - The window closes automatically once authenticated");
  console.log("  - If a page shows 'This site can't be reached', it retries");
  console.log("    automatically; refresh the page manually if it lingers\n");

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

async function sharePointAuth(): Promise<void> {
  console.log("RAVEN Auth - SharePoint Online Session Manager");
  console.log("==============================================\n");

  const existing = await readCachedSpoSession(spoCachePath);
  if (existing) {
    console.log("Valid SharePoint session found in cache.");
    console.log("  Cache:  ~/.workflow-suite/spo-session.json");
    console.log("\nYour SharePoint tools should work. Session refreshes automatically.");
    return;
  }

  console.log("No valid session found. Opening browser for IDIR/Entra login...");
  console.log("  - A Chromium window will open at your SharePoint tenant");
  console.log("  - Log in with your IDIR credentials (and MFA if prompted)");
  console.log("  - The window closes automatically once authenticated");
  console.log("  - If a page shows 'This site can't be reached', it retries");
  console.log("    automatically; refresh the page manually if it lingers\n");

  const sm = new SpoSessionManager();

  try {
    await sm.authenticate();
    console.log("\nAuthentication successful!");
    console.log("  Cached: ~/.workflow-suite/spo-session.json");
    console.log("  TTL:    8 hours");
    console.log("\nYour RAVEN SharePoint tools are ready to use.");
  } catch (err) {
    console.error(
      "\nAuthentication failed:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--sharepoint")) {
    await sharePointAuth();
    return;
  }
  await siteMinderAuth();
}

main();
