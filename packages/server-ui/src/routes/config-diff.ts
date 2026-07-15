/**
 * GET /api/config-diff?app&component&file&servers
 *
 * Compare config files between servers.
 */
import { Router } from "express";
import { diffConfig, type ConfigFile } from "@nrs/server-mcp/client";
import { validateAppName } from "../lib/validate.js";
import { getServerConfig, getServerNames } from "../lib/server-config.js";

export const configDiffRouter = Router();

const VALID_FILES: ConfigFile[] = ["context.xml", "web.xml", "server.xml"];

configDiffRouter.get("/", async (req, res) => {
  const app = req.query.app as string;
  const component = req.query.component as string;
  const file = (req.query.file as string) || "context.xml";
  const serversParam = (req.query.servers as string) || getServerNames().join(",");

  if (!app || !validateAppName(app)) {
    res.status(400).json({ error: "Invalid or missing app name" });
    return;
  }
  if (!component || !validateAppName(component)) {
    res.status(400).json({ error: "Invalid or missing component name" });
    return;
  }
  if (!VALID_FILES.includes(file as ConfigFile)) {
    res.status(400).json({ error: "Invalid config file name" });
    return;
  }

  const requested = serversParam.split(",").map((s) => s.trim()).filter(Boolean);
  const allEntries = getServerConfig();
  const entries = requested
    .map((name) => allEntries.find((e) => e.name === name))
    .filter((e): e is NonNullable<typeof e> => e !== undefined);

  if (entries.length < 2) {
    res.status(400).json({ error: "Need at least 2 known servers to compare" });
    return;
  }

  const diff = await diffConfig(entries, app, component, file as ConfigFile);
  res.json({ app, component, file, servers: serversParam, diff });
});
