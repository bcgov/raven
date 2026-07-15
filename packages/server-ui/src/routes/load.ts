/**
 * GET /api/load/:server          — one-shot server load snapshot
 * GET /api/load/stream/:server   — SSE live stream (all servers if :server is "all")
 *
 * System load: uptime, load averages, memory, disk usage.
 */
import { Router } from "express";
import { getServerLoad } from "@nrs/server-mcp/client";
import { validateServer } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";

export const loadRouter = Router();

function resolveEntries(serverParam: string) {
  const all = getServerConfig();
  if (serverParam === "all") return all;
  const valid = validateServer(serverParam);
  if (!valid) return [];
  return all.filter((e) => e.name === valid);
}

loadRouter.get("/stream/:server", async (req, res) => {
  const entries = resolveEntries(req.params.server);
  if (entries.length === 0) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }

  const interval = Math.max(5, parseInt((req.query.interval as string) || "10", 10));

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let running = true;
  req.on("close", () => {
    running = false;
  });

  const sendUpdate = async () => {
    try {
      const results = await Promise.all(
        entries.map(async (entry) => {
          const load = await getServerLoad(entry);
          return load ? { server: entry.name, load } : { server: entry.name, raw: "" };
        }),
      );
      res.write(`data: ${JSON.stringify(results)}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify({ error: "Failed to fetch load data" })}\n\n`);
    }
  };

  await sendUpdate();

  const timer = setInterval(async () => {
    if (!running) {
      clearInterval(timer);
      return;
    }
    await sendUpdate();
  }, interval * 1000);

  req.on("close", () => clearInterval(timer));
});

loadRouter.get("/:server", async (req, res) => {
  const entries = resolveEntries(req.params.server);
  if (entries.length !== 1) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }
  const entry = entries[0]!;

  const load = await getServerLoad(entry);
  if (!load) {
    res.json({ server: entry.name, raw: "Load metrics unavailable (parse failed)" });
    return;
  }
  res.json({ server: entry.name, load });
});
