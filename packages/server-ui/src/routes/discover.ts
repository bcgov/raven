/**
 * GET /api/discover/cache     — return cached discovery results (no SSH)
 * GET /api/discover/:server   — discover on one server (ssh2), update cache
 */
import { Router } from "express";
import { discoverApps, parseDiscoverOutput } from "@nrs/server-mcp/client";
import { validateServer } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";
import { logger } from "../lib/logger.js";
import { readCache, writeCache, upsertServer } from "../lib/discover-cache.js";

export const discoverRouter = Router();

/** Return cached discovery data — no SSH, instant response. */
discoverRouter.get("/cache", (_req, res) => {
  res.json({ servers: readCache() });
});

/** Discover apps on a single server via ssh2, then update the cache. */
discoverRouter.get("/:server", async (req, res) => {
  const server = validateServer(req.params.server);
  if (!server) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }

  const entry = getServerConfig().find((s) => s.name === server);
  if (!entry) {
    res.status(400).json({ error: `Server "${server}" not found in config` });
    return;
  }

  const start = Date.now();
  logger.info("Discovery starting", { server, host: entry.host, user: entry.sshUser });

  const result = await discoverApps(entry);
  const duration = Date.now() - start;

  if (result.exitCode !== 0) {
    const errMsg = result.output.slice(0, 200);
    const isAuthError = /auth|password|denied|unauthorized/i.test(errMsg);
    logger.error("Discovery failed", {
      server,
      host: entry.host,
      duration: `${duration}ms`,
      exitCode: result.exitCode,
      authFailure: isAuthError,
      error: errMsg,
    });
    if (isAuthError) {
      logger.error(
        "AUTH FAILURE — check SERVER_A_PASSWORD in ~/.raven/.env. " +
        "Repeated failures may trigger security alerts.",
        { server, user: entry.sshUser },
      );
    }
    // result.output may be empty (e.g., SSH connection dropped before any
    // bytes flowed) — surface a useful message rather than {error: ""}.
    res.status(500).json({
      error: result.output || `Discovery failed for ${server} (exit ${result.exitCode}, no output)`,
    });
    return;
  }

  const apps = parseDiscoverOutput(result.output);
  logger.info("Discovery succeeded", {
    server,
    duration: `${duration}ms`,
    appCount: apps.length,
  });

  const discoveredAt = new Date().toISOString();
  // Cache write failures (permissions, disk full) must not take down the
  // request — SSH succeeded and the client gets the discovery result. Log
  // the failure so the operator notices, but keep serving.
  try {
    writeCache(upsertServer(readCache(), server, apps, discoveredAt));
  } catch (err) {
    logger.error("Discovery cache write failed", {
      server,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  res.json({ server, apps, discoveredAt });
});
