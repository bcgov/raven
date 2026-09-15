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
  assertSafeServerBasePath,
} from "@nrs/auth";
import type { ServerEntry } from "@nrs/auth";

export type { ServerEntry };

const BIN_DIR = process.env["SERVER_TOOLS_BIN"] ?? join(homedir(), "bin");
const SERVERS_CONF = join(BIN_DIR, "servers.conf");

export class ServerConfigValidationError extends Error {}

/** Validate every field before trimming or serializing the pipe-delimited file. */
function validateServerConfig(value: unknown): ServerEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ServerConfigValidationError("Expected a non-empty array of servers");
  }

  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ServerConfigValidationError("Each server must be an object");
    }
    const input = entry as Record<string, unknown>;
    const readField = (field: keyof ServerEntry, fallback = ""): string => {
      const raw = input[field];
      if (raw === undefined || (raw === null && (field === "appsBase" || field === "logsBase"))) {
        return fallback;
      }
      if (typeof raw !== "string") {
        throw new ServerConfigValidationError(`Server field "${field}" must be a string`);
      }
      if (/[|\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(raw)) {
        throw new ServerConfigValidationError(`Server field "${field}" cannot contain pipes or control characters`);
      }
      return raw.trim() || fallback;
    };

    const server: ServerEntry = {
      name: readField("name").toLowerCase(),
      host: readField("host"),
      sshUser: readField("sshUser"),
      sudoUser: readField("sudoUser"),
      role: readField("role"),
      description: readField("description"),
      appsBase: readField("appsBase", "/apps_ux"),
      logsBase: readField("logsBase", "/apps_ux/logs"),
    };
    if (!/^[a-z0-9_-]+$/.test(server.name)) {
      throw new ServerConfigValidationError("Invalid server name. Use lowercase letters, numbers, hyphens, underscores.");
    }
    for (const field of ["host", "sshUser", "role"] as const) {
      if (!server[field]) {
        throw new ServerConfigValidationError(`Server "${server.name}" requires "${field}"`);
      }
    }
    // Host and SSH user are passed to ssh2; the sudo user is shell-quoted or empty for direct SSH.
    // Base paths are interpolated into shell commands and need a stricter grammar.
    try {
      assertSafeServerBasePath(server.appsBase, "appsBase");
      assertSafeServerBasePath(server.logsBase, "logsBase");
    } catch (error) {
      throw new ServerConfigValidationError(error instanceof Error ? error.message : "Invalid server base path");
    }
    if (names.has(server.name)) {
      throw new ServerConfigValidationError(`Duplicate server name: "${server.name}"`);
    }
    names.add(server.name);
    return server;
  });
}

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
export function saveServerConfig(value: unknown): void {
  const servers = validateServerConfig(value);
  writeFileSync(SERVERS_CONF, serializeServersConf(servers), "utf-8");
  _reloadServerConfig();
  logger.info("Saved server config", {
    count: servers.length,
    path: SERVERS_CONF,
  });
}
