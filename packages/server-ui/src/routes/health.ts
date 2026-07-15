/**
 * GET /api/health
 *
 * Health check endpoint for OpenShift probes and external monitoring.
 * Always returns HTTP 200. The status field indicates actual health:
 *   - "healthy"  — all configured servers are reachable
 *   - "degraded" — one or more servers unreachable
 *   - "starting" — collector hasn't completed its first run yet
 */
import { Router } from "express";
import { getServerStatuses, loadStore } from "../lib/store.js";
import {
  getCollectorStatus,
  startCollector,
  stopCollector,
} from "../lib/collector.js";

export const healthRouter = Router();

/**
 * POST /api/health/collector/start — manually start the background collector.
 * The collector is disabled by default (was previously started in createApp())
 * because its 30-min polling pattern fanned out SSH to all servers in a way
 * that could trigger MaxAuthTries alerts on the bastion. Operators who need
 * the historical metrics it produces can opt in via this endpoint.
 *
 * Side effect: starting the collector immediately runs one full collection
 * pass (1 server-dashboard call + N server-heap calls), then continues every
 * 30 minutes. Operators should expect the SSH activity associated with that
 * cadence after enabling.
 */
healthRouter.post("/collector/start", (_req, res) => {
  const before = getCollectorStatus();
  if (before.running) {
    res.json({ running: true, alreadyRunning: true });
    return;
  }
  startCollector();
  res.json({ running: getCollectorStatus().running, alreadyRunning: false });
});

/** POST /api/health/collector/stop — stop the background collector. */
healthRouter.post("/collector/stop", (_req, res) => {
  const before = getCollectorStatus();
  if (!before.running) {
    res.json({ running: false, alreadyStopped: true });
    return;
  }
  stopCollector();
  res.json({ running: getCollectorStatus().running, alreadyStopped: false });
});

healthRouter.get("/", (_req, res) => {
  const serverStatuses = getServerStatuses();
  const collector = getCollectorStatus();
  const store = loadStore();

  const serverKeys = Object.keys(serverStatuses);
  const allReachable = serverKeys.every((k) => serverStatuses[k].reachable);

  let status: "healthy" | "degraded" | "starting";
  if (serverKeys.length === 0) {
    status = "starting";
  } else if (allReachable) {
    status = "healthy";
  } else {
    status = "degraded";
  }

  res.json({
    status,
    uptime: Math.floor(process.uptime()),
    version: "0.1.0",
    servers: serverStatuses,
    collector: {
      running: collector.running,
      lastRun: collector.lastRun,
      nextRun: collector.nextRun,
      errorSnapshotCount: store.errorSnapshots.length,
      versionSnapshotCount: store.versionSnapshots.length,
    },
  });
});
