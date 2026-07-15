/**
 * Express app factory for the Server Monitor Web UI.
 *
 * Mounts API routes and serves the static frontend.
 */
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requestLogger } from "./lib/logger.js";
import { loadServerConfig } from "./lib/server-config.js";
import { discoverRouter } from "./routes/discover.js";
import { versionsRouter } from "./routes/versions.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { logsRouter } from "./routes/logs.js";
import { heapRouter } from "./routes/heap.js";
import { loadRouter } from "./routes/load.js";
import { logTailRouter } from "./routes/log-tail.js";
import { logDownloadRouter } from "./routes/log-download.js";
import { poolRouter } from "./routes/pool.js";
import { settingsRouter } from "./routes/settings.js";
import { trendsRouter } from "./routes/trends.js";
import { alertsRouter } from "./routes/alerts.js";
import { healthRouter } from "./routes/health.js";
import { deploysRouter } from "./routes/deploys.js";
// Note: startCollector is intentionally not imported. The background
// collector is disabled by default to avoid auto-SSH on startup. It can
// be started at runtime via POST /api/health/collector/start.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createApp(): express.Express {
  // Load (and seed) server config on startup
  loadServerConfig();

  const app = express();

  // JSON body parsing for PUT /api/servers
  app.use(express.json());

  // --- Request logging (API routes only) ---
  app.use("/api", requestLogger);

  // --- API routes ---
  app.use("/api/servers", settingsRouter);
  app.use("/api/discover", discoverRouter);
  app.use("/api/versions", versionsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/logs/tail", logTailRouter);
  app.use("/api/logs/download", logDownloadRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api/heap", heapRouter);
  app.use("/api/load", loadRouter);
  app.use("/api/pool", poolRouter);
  app.use("/api/trends", trendsRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/deploys", deploysRouter);

  // Background collector is disabled by default. To enable at runtime:
  //   POST /api/health/collector/start  (and /stop to disable)
  // See routes/health.ts. Disabled-by-default avoids auto-SSH on startup,
  // which previously contributed to MaxAuthTries alerts on the bastion.

  // --- Static frontend ---
  app.use(express.static(join(__dirname, "..", "public")));

  // SPA fallback — serve index.html for any non-API route (Express 5 syntax)
  app.get("{*path}", (_req, res) => {
    res.sendFile(join(__dirname, "..", "public", "index.html"));
  });

  return app;
}
