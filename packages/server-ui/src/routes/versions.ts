/**
 * GET /api/versions?app=&server=
 *
 * Show deployed versions across environments with mismatch detection.
 */
import { Router } from "express";
import { fetchVersions, detectMismatches } from "@nrs/server-mcp/client";
import { validateServer, validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";

export const versionsRouter = Router();

interface VersionRow {
  app: string;
  component: string;
  servers: Record<string, string>;
  mismatch: boolean;
}

versionsRouter.get("/", async (req, res) => {
  const app = req.query.app as string | undefined;
  const server = req.query.server as string | undefined;

  if (app && !validateAppName(app)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }
  if (server && !validateServer(server)) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }

  const allEntries = getServerConfig();
  const entries = server ? allEntries.filter((s) => s.name === server) : allEntries;
  if (entries.length === 0) {
    res.status(400).json({ error: "No matching servers in config" });
    return;
  }

  const results = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      versions: await fetchVersions(entry, app),
    })),
  );

  const serverNames = entries.map((e) => e.name);
  const perServer = new Map<string, Map<string, string>>();
  for (const r of results) perServer.set(r.name, r.versions);

  const mismatches = new Set(detectMismatches(perServer));

  const allKeys = new Set<string>();
  for (const m of perServer.values()) for (const k of m.keys()) allKeys.add(k);

  const rows: VersionRow[] = [];
  for (const key of [...allKeys].sort()) {
    const [appName, component] = key.split("|", 2);
    if (!appName || !component) continue;
    const servers: Record<string, string> = {};
    for (const name of serverNames) {
      servers[name] = perServer.get(name)?.get(key) ?? "—";
    }
    rows.push({
      app: appName,
      component,
      servers,
      mismatch: mismatches.has(`${appName}/${component}`),
    });
  }

  res.json({ versions: rows });
});
