/**
 * GET /api/dashboard?app=
 *
 * Morning status dashboard: versions, error counts, JVM settings.
 * Fans out per-server runDashboard() calls in parallel and aggregates
 * into the multi-column shape the browser UI consumes.
 */
import { Router } from "express";
import { runDashboard, type DashboardData as PerServerDashboard } from "@nrs/server-mcp/client";
import { validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";
import { logger } from "../lib/logger.js";

export const dashboardRouter = Router();

interface DashboardRow {
  appComponent: string;
  servers: Record<string, string>;
}

interface AggregatedDashboard {
  versions: DashboardRow[];
  errors: DashboardRow[];
  jvmHeap: DashboardRow[];
}

/**
 * Convert per-server Maps (keyed "APP|COMP") into multi-column rows
 * keyed "APP/COMP" with one cell per server name. Missing values render
 * as "—" to match the legacy parseDashboard output.
 */
export function aggregateDashboard(
  perServer: { name: string; data: PerServerDashboard }[],
): AggregatedDashboard {
  const names = perServer.map((p) => p.name);

  const collect = (
    pick: (d: PerServerDashboard) => Map<string, string | number>,
  ): DashboardRow[] => {
    const keys = new Set<string>();
    for (const p of perServer) for (const k of pick(p.data).keys()) keys.add(k);
    const rows: DashboardRow[] = [];
    for (const key of [...keys].sort()) {
      const [app, comp] = key.split("|", 2);
      if (!app || !comp) continue;
      const servers: Record<string, string> = {};
      for (const p of perServer) {
        const v = pick(p.data).get(key);
        servers[p.name] = v === undefined || v === "" ? "—" : String(v);
      }
      rows.push({ appComponent: `${app}/${comp}`, servers });
    }
    return rows;
  };

  // The `names` reference is captured by the closure but not used directly inside collect;
  // it is implicitly used through `perServer`. Touch it so TS doesn't flag it as unused.
  void names;

  return {
    versions: collect((d) => d.versions),
    errors: collect((d) => d.errors),
    jvmHeap: collect((d) => d.jvm),
  };
}

dashboardRouter.get("/", async (req, res) => {
  const appFilter = req.query.app as string | undefined;
  if (appFilter && !validateAppName(appFilter)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }

  const entries = getServerConfig();
  if (entries.length === 0) {
    res.status(500).json({ error: "No servers configured" });
    return;
  }

  logger.info("dashboard request", { app: appFilter ?? "(all)", servers: entries.length });

  const results = await Promise.allSettled(
    entries.map(async (entry) => ({
      name: entry.name,
      data: await runDashboard(entry, appFilter),
    })),
  );

  const ok: { name: string; data: PerServerDashboard }[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const entry = entries[i];
    if (r.status === "fulfilled") {
      ok.push(r.value);
    } else {
      logger.warn("dashboard per-server failed", {
        server: entry?.name,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  if (ok.length === 0) {
    res.status(500).json({ error: "All server dashboard queries failed" });
    return;
  }

  res.json(aggregateDashboard(ok));
});
