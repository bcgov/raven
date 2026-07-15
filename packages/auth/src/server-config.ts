/**
 * Server configuration — reads ~/bin/servers.conf (the CLI tools' config).
 *
 * This is the single source of truth for server names and environment labels
 * across all RAVEN packages (server-mcp, server-ui, etc.).
 *
 * Format: name|hostname|ssh_user|sudo_user|role|description|apps_base|logs_base
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_APPS_BASE = "/apps_ux";
const DEFAULT_LOGS_BASE = "/apps_ux/logs";

/** A configured server entry. */
export interface ServerEntry {
  name: string;
  host: string;
  sshUser: string;
  sudoUser: string;
  role: string;
  description: string;
  appsBase: string;
  logsBase: string;
}

const BIN_DIR = process.env["SERVER_TOOLS_BIN"] ?? join(homedir(), "bin");
const SERVERS_CONF = join(BIN_DIR, "servers.conf");

/** In-memory cache of the server config. */
let cachedConfig: ServerEntry[] | null = null;

/**
 * Parse servers.conf content into ServerEntry array.
 * Skips blank lines and comment lines (starting with #).
 */
function parseServersConf(content: string): ServerEntry[] {
  const entries: ServerEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split("|");
    if (parts.length < 4) continue;

    entries.push({
      name: parts[0].trim(),
      host: parts[1].trim(),
      sshUser: parts[2].trim(),
      sudoUser: parts[3].trim(),
      role: (parts[4] ?? "").trim(),
      description: (parts[5] ?? "").trim(),
      appsBase: (parts[6] ?? "").trim() || DEFAULT_APPS_BASE,
      logsBase: (parts[7] ?? "").trim() || DEFAULT_LOGS_BASE,
    });
  }
  return entries;
}

/**
 * Load server configuration from ~/bin/servers.conf.
 */
export function loadServerConfig(): ServerEntry[] {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(SERVERS_CONF)) {
    cachedConfig = [];
    return cachedConfig;
  }

  try {
    const raw = readFileSync(SERVERS_CONF, "utf-8");
    cachedConfig = parseServersConf(raw);
    return cachedConfig;
  } catch {
    cachedConfig = [];
    return cachedConfig;
  }
}

/** Get just the server names. */
export function getServerNames(): string[] {
  return loadServerConfig().map((s) => s.name);
}

/** Get the full server config array. */
export function getServerConfig(): ServerEntry[] {
  return loadServerConfig();
}

/** Build a description string like "int01=INT, test01=TEST, prod01=PROD". */
export function getServerDescription(): string {
  return loadServerConfig()
    .map((s) => `${s.name}=${s.role}`)
    .join(", ");
}

/** Clear the in-memory cache (forces re-read on next access). */
export function reloadServerConfig(): ServerEntry[] {
  cachedConfig = null;
  return loadServerConfig();
}
