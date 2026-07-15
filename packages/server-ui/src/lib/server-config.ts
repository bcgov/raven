/**
 * Server configuration for the web UI.
 *
 * Core read functions are re-exported from @nrs/auth (the shared single
 * source of truth). This module adds write support and logging for the
 * server-ui settings page.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";
import {
  loadServerConfig as _loadServerConfig,
  reloadServerConfig as _reloadServerConfig,
  getServerNames as _getServerNames,
  getServerConfig as _getServerConfig,
} from "@nrs/auth";
import type { ServerEntry } from "@nrs/auth";

export type { ServerEntry };

const BIN_DIR = process.env["SERVER_TOOLS_BIN"] ?? join(homedir(), "bin");
const SERVERS_CONF = join(BIN_DIR, "servers.conf");

/** Load server config (delegates to @nrs/auth, adds logging on first load). */
export function loadServerConfig(): ServerEntry[] {
  const result = _loadServerConfig();
  if (result.length > 0) {
    logger.info("Loaded server config", {
      count: result.length,
      servers: result.map((s) => s.name).join(", "),
    });
  }
  return result;
}

/** Get just the server names. */
export function getServerNames(): string[] {
  return _getServerNames();
}

/** Get the full server config array. */
export function getServerConfig(): ServerEntry[] {
  return _getServerConfig();
}

/** Clear the in-memory cache (forces re-read on next access). */
export function reloadServerConfig(): ServerEntry[] {
  return _reloadServerConfig();
}

/**
 * Serialize ServerEntry array back to servers.conf format.
 */
function serializeServersConf(servers: ServerEntry[]): string {
  const header = `# Server Connect Configuration
# Format: name|hostname|ssh_user|sudo_user|role|description|apps_base|logs_base
#
# name        = friendly label shown in menu
# hostname    = server hostname or IP
# ssh_user    = your SSH username
# sudo_user   = the account to sudo su into
# role        = environment label (e.g. INT, TEST, PROD) — used by server-ui
# description = optional human-readable description — used by server-ui
# apps_base   = base path for deployed apps (default: /apps_ux)
# logs_base   = base path for log files (default: /apps_ux/logs)
#
# Example:
# app-server|app01.example.internal|jsmith|appuser|PROD|Production Tomcat|/apps_ux|/apps_ux/logs
# ofm-server|ofm01.example.internal|jsmith|oracle|PROD|OFM Server|/sw_ux/oracle/ofm|/sw_ux/oracle/ofm/logs`;

  const lines = servers.map(
    (s) =>
      `${s.name}|${s.host}|${s.sshUser}|${s.sudoUser}|${s.role}|${s.description}|${s.appsBase}|${s.logsBase}`
  );

  return header + "\n" + lines.join("\n") + "\n";
}

/**
 * Save server configuration to ~/bin/servers.conf and update the in-memory cache.
 */
export function saveServerConfig(servers: ServerEntry[]): void {
  writeFileSync(SERVERS_CONF, serializeServersConf(servers), "utf-8");
  _reloadServerConfig();
  logger.info("Saved server config", {
    count: servers.length,
    path: SERVERS_CONF,
  });
}
