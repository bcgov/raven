/**
 * GET  /api/servers  — return configured server list
 * PUT  /api/servers  — update server configuration (writes to ~/bin/servers.conf)
 */
import { Router } from "express";
import {
  getServerConfig,
  saveServerConfig,
  type ServerEntry,
} from "../lib/server-config.js";

export const settingsRouter = Router();

/** Return the current server configuration. */
settingsRouter.get("/", (_req, res) => {
  res.json(getServerConfig());
});

/** Update the server configuration. */
settingsRouter.put("/", (req, res) => {
  const body = req.body;

  if (!Array.isArray(body) || body.length === 0) {
    res.status(400).json({ error: "Expected a non-empty array of servers" });
    return;
  }

  // Validate each entry
  const servers: ServerEntry[] = [];
  const names = new Set<string>();

  for (const entry of body) {
    const name = String(entry.name ?? "").trim().toLowerCase();
    const host = String(entry.host ?? "").trim();
    const sshUser = String(entry.sshUser ?? "").trim();
    const sudoUser = String(entry.sudoUser ?? "").trim();
    const role = String(entry.role ?? "").trim();
    const description = String(entry.description ?? "").trim();
    const appsBase = String(entry.appsBase ?? "/apps_ux").trim();
    const logsBase = String(entry.logsBase ?? "/apps_ux/logs").trim();

    if (!name || !/^[a-z0-9_-]+$/.test(name)) {
      res.status(400).json({
        error: `Invalid server name: "${name}". Use lowercase letters, numbers, hyphens, underscores.`,
      });
      return;
    }
    if (!host) {
      res.status(400).json({
        error: `Server "${name}" requires a hostname.`,
      });
      return;
    }
    if (!sshUser) {
      res.status(400).json({
        error: `Server "${name}" requires an SSH user.`,
      });
      return;
    }
    if (!sudoUser) {
      res.status(400).json({
        error: `Server "${name}" requires a sudo user.`,
      });
      return;
    }
    if (!role) {
      res.status(400).json({
        error: `Server "${name}" requires a role (e.g. DEV, TEST, PROD).`,
      });
      return;
    }
    if (names.has(name)) {
      res.status(400).json({ error: `Duplicate server name: "${name}"` });
      return;
    }

    names.add(name);
    servers.push({ name, host, sshUser, sudoUser, role, description, appsBase, logsBase });
  }

  saveServerConfig(servers);
  res.json(getServerConfig());
});
