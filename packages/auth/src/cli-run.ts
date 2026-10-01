import type { CacheCheck } from "./session-manager.js";
import type { SpoCookies } from "./types.js";

/** What the CLI needs from the SiteMinder session manager; `SessionManager` satisfies it. */
export interface CliSessionManager {
  checkCache(): Promise<CacheCheck>;
  invalidate(failedCookie?: string): Promise<void>;
  authenticate(): Promise<string>;
}

/** What the CLI needs from the SharePoint session manager; `SpoSessionManager` satisfies it. */
export interface CliSpoSessionManager {
  invalidate(failedPair?: SpoCookies): Promise<void>;
  authenticate(): Promise<SpoCookies>;
}

/** Everything {@link runCli} touches outside itself, so it can run without a browser, a network or a home directory. */
export interface CliDeps {
  /** Create the SiteMinder manager (only called for a SiteMinder login). */
  readonly sessionManager: () => CliSessionManager;
  /** Create the SharePoint manager (only called for a SharePoint login). */
  readonly spoSessionManager: () => CliSpoSessionManager;
  /** The cached SharePoint pair, if one is present and within its TTL. */
  readonly readCachedSpoSession: () => Promise<SpoCookies | null>;
  /** Normal output. */
  readonly log: (line: string) => void;
  /** Error output. */
  readonly error: (line: string) => void;
}

/** The text printed by `--help` and after a usage error. */
export const USAGE = [
  "Usage: raven-auth [--sharepoint] [--force] [--help]",
  "",
  "  (no options)   Log in to SiteMinder (Jira, Confluence, Bitbucket, Jenkins, ...).",
  "                 A cached session is first checked against the server.",
  "  --sharepoint   Log in to SharePoint Online instead.",
  "  --force        Ignore the cached session and log in again.",
  "  --help, -h     Show this help.",
  "",
  "Exit codes: 0 a session is ready; 1 the login failed or the options were wrong;",
  "            2 a cached SiteMinder session exists but the server could not be reached to confirm it.",
].join("\n");

const KNOWN_OPTIONS = new Set(["--force", "--sharepoint", "--help", "-h"]);

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function siteMinderLogin(deps: CliDeps, force: boolean): Promise<number> {
  deps.log("RAVEN Auth - SiteMinder Session Manager");
  deps.log("======================================\n");

  const sm = deps.sessionManager();

  if (force) {
    deps.log("--force: ignoring any cached session.\n");
    await sm.invalidate();
  } else {
    // A cookie's age says nothing about whether the server still honours it,
    // so ask the server before declaring the cache good.
    const check = await sm.checkCache();
    if (check.state === "live") {
      deps.log("Valid SMSESSION found in cache (confirmed with the server).");
      deps.log("  Cache:  ~/.workflow-suite/session.json");
      deps.log("\nYour RAVEN tools should work. Session refreshes automatically.");
      return 0;
    }
    if (check.state === "unknown") {
      deps.log("A cached SMSESSION exists, but the server could not be reached to confirm it.");
      deps.log("Check your VPN/network; run with --force to log in again regardless.");
      return 2;
    }
    if (check.state === "dead") {
      deps.log("The cached SMSESSION was rejected by the server (expired or logged off).");
      deps.log("Discarding it and logging in again...\n");
      await sm.invalidate(check.cookie);
    }
  }

  deps.log("No valid session found. Opening browser for IDIR login...");
  deps.log("  - A Chromium window will open");
  deps.log("  - Log in with your IDIR credentials");
  deps.log("  - The window closes automatically once authenticated");
  deps.log("  - If a page shows 'This site can't be reached', it retries");
  deps.log("    automatically; refresh the page manually if it lingers\n");

  try {
    await sm.authenticate();
  } catch (err) {
    deps.error(`\nAuthentication failed: ${describe(err)}`);
    return 1;
  }
  deps.log("\nAuthentication successful!");
  deps.log("  Cached: ~/.workflow-suite/session.json");
  deps.log("  TTL:    25 minutes");
  deps.log("\nYour RAVEN tools (Jira, Confluence, Bitbucket) are ready to use.");
  return 0;
}

async function sharePointLogin(deps: CliDeps, force: boolean): Promise<number> {
  deps.log("RAVEN Auth - SharePoint Online Session Manager");
  deps.log("==============================================\n");

  const sm = deps.spoSessionManager();

  if (force) {
    deps.log("--force: ignoring any cached SharePoint session.\n");
    await sm.invalidate();
  } else if (await deps.readCachedSpoSession()) {
    deps.log("Valid SharePoint session found in cache.");
    deps.log("  Cache:  ~/.workflow-suite/spo-session.json");
    deps.log("\nYour SharePoint tools should work. Session refreshes automatically.");
    return 0;
  }

  deps.log("No valid session found. Opening browser for IDIR/Entra login...");
  deps.log("  - A Chromium window will open at your SharePoint tenant");
  deps.log("  - Log in with your IDIR credentials (and MFA if prompted)");
  deps.log("  - The window closes automatically once authenticated");
  deps.log("  - If a page shows 'This site can't be reached', it retries");
  deps.log("    automatically; refresh the page manually if it lingers\n");

  try {
    await sm.authenticate();
  } catch (err) {
    deps.error(`\nAuthentication failed: ${describe(err)}`);
    return 1;
  }
  deps.log("\nAuthentication successful!");
  deps.log("  Cached: ~/.workflow-suite/spo-session.json");
  deps.log("  TTL:    8 hours");
  deps.log("\nYour RAVEN SharePoint tools are ready to use.");
  return 0;
}

/**
 * Run the `raven-auth` command.
 *
 * Unknown options are rejected rather than ignored: a mistyped `--force` used
 * to be dropped silently, and the login then trusted the cached session.
 *
 * @param argv - The command-line arguments after the program name.
 * @param deps - Managers and output; injected so the command is testable.
 * @returns The process exit code: 0 a session is ready; 1 the login failed or
 *   the options were wrong; 2 a cached SiteMinder session exists but the server
 *   could not be reached to confirm it.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const unknown = argv.filter((arg) => !KNOWN_OPTIONS.has(arg));
  if (unknown.length > 0) {
    deps.error(`Unknown option: ${unknown.join(" ")}\n`);
    deps.error(USAGE);
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.log(USAGE);
    return 0;
  }

  const force = argv.includes("--force");
  return argv.includes("--sharepoint") ? sharePointLogin(deps, force) : siteMinderLogin(deps, force);
}
