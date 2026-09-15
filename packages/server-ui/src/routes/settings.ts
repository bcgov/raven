/**
 * GET  /api/servers  — return configured server list
 * PUT  /api/servers  — update server configuration (writes to ~/bin/servers.conf)
 */
import { Router } from "express";
import {
  getServerConfig,
  saveServerConfig,
  ServerConfigValidationError,
} from "../lib/server-config.js";

export const settingsRouter = Router();

/** Return the current server configuration. */
settingsRouter.get("/", (_req, res) => {
  res.json(getServerConfig());
});

/** Update the server configuration. */
settingsRouter.put("/", (req, res) => {
  try {
    saveServerConfig(req.body);
  } catch (error) {
    if (!(error instanceof ServerConfigValidationError)) throw error;
    res.status(400).json({ error: error.message });
    return;
  }
  res.json(getServerConfig());
});
