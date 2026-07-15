/**
 * Deployment history API — reads deployment dates from server filesystem
 * via in-process ssh2 (key-aware).
 *
 * GET /api/deploys?server=int01&app=RRS
 */
import { Router, type Request, type Response } from "express";
import { fetchDeployHistory, type DeployEntry } from "@nrs/server-mcp/client";
import { validateServer, validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";
import { logger } from "../lib/logger.js";

export const deploysRouter = Router();

deploysRouter.get("/", async (req: Request, res: Response) => {
  const serverParam = req.query.server as string | undefined;
  const app = req.query.app as string | undefined;

  if (app && !validateAppName(app)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }

  const allEntries = getServerConfig();
  let entries = allEntries;
  if (serverParam) {
    const valid = validateServer(serverParam);
    if (!valid) {
      res.status(400).json({ error: "Invalid server name" });
      return;
    }
    entries = allEntries.filter((e) => e.name === valid);
  }
  if (entries.length === 0) {
    res.status(400).json({ error: "No matching servers in config" });
    return;
  }

  const settled = await Promise.allSettled(
    entries.map((entry) => fetchDeployHistory(entry, app)),
  );

  const all: DeployEntry[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const entry = entries[i];
    if (r.status === "fulfilled") {
      all.push(...r.value);
    } else {
      logger.warn("deploy history failed", {
        server: entry?.name,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  all.sort((a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime());

  res.json({ entries: all });
});
