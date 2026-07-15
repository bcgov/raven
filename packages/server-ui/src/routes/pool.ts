/**
 * GET /api/pool?server&app&component — connection pool configuration and events.
 *
 * Reads context.xml from the deployed app to extract JDBC pool settings,
 * and searches recent logs for pool-related events.
 * IMPORTANT: Database passwords are always masked in the response.
 */
import { Router } from "express";
import { readContextXml, searchLogs } from "@nrs/server-mcp/client";
import { validateServer, validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";
import { parsePoolConfig } from "../lib/parsers.js";

export const poolRouter = Router();

const POOL_LOG_PATTERNS =
  "pool exhausted|Cannot get a connection|abandoned|DBCP|HikariPool|DataSource.*error|connection.*refused";

poolRouter.get("/", async (req, res) => {
  const server = validateServer(req.query.server as string);
  const app = req.query.app as string;
  const component = req.query.component as string;

  if (!server) {
    res.status(400).json({ error: "Invalid or missing server name" });
    return;
  }
  if (!app || !validateAppName(app)) {
    res.status(400).json({ error: "Invalid or missing app name" });
    return;
  }
  if (!component || !validateAppName(component)) {
    res.status(400).json({ error: "Invalid or missing component name" });
    return;
  }

  const entry = getServerConfig().find((s) => s.name === server);
  if (!entry) {
    res.status(400).json({ error: `Server "${server}" not found in config` });
    return;
  }

  let poolConfig: ReturnType<typeof parsePoolConfig> = [];
  try {
    const xml = await readContextXml(entry, app, component);
    if (xml) poolConfig = parsePoolConfig(xml);
  } catch {
    // Treat read failure as "no config" — leaves events check intact.
  }

  let events: string[] = [];
  try {
    const result = await searchLogs(entry, {
      app,
      component,
      pattern: POOL_LOG_PATTERNS,
      logType: "app",
      maxLines: 30,
      contextLines: 0,
    });
    if (result.exitCode === 0) {
      events = result.output
        .split("\n")
        .filter((l) => l.trim() !== "")
        .slice(0, 30);
    }
  } catch {
    // Empty events on failure
  }

  res.json({ server, app, component, pool: poolConfig, events });
});
