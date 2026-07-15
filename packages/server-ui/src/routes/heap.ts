/**
 * GET /api/heap?server&app&component          — one-shot heap snapshot
 * GET /api/heap/stream?server&app&component   — SSE live stream
 *
 * JVM heap monitoring with optional auto-refresh via Server-Sent Events.
 */
import { Router } from "express";
import { getJvmHeap, type HeapMetrics } from "@nrs/server-mcp/client";
import { validateServer, validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";

export const heapRouter = Router();

/**
 * Browser contract (public/js/views/heap.js): heapMaxMb/heapPercent/edenPercent/etc.
 * In-process HeapMetrics uses heapCapMb/heapPct and omits the *Percent fields,
 * so adapt here to keep the existing client untouched.
 */
interface HeapData {
  pid: string;
  heapUsedMb: number;
  heapMaxMb: number;
  heapPercent: number;
  edenUsedMb: number;
  edenMaxMb: number;
  edenPercent: number;
  oldUsedMb: number;
  oldMaxMb: number;
  oldPercent: number;
  metaUsedMb: number;
  metaMaxMb: number;
  metaPercent: number;
  youngGcCount: number;
  youngGcTime: number;
  fullGcCount: number;
  fullGcTime: number;
}

function pct(used: number, max: number): number {
  return max > 0 ? (used * 100) / max : 0;
}

function toHeapData(m: HeapMetrics): HeapData {
  return {
    pid: m.pid,
    heapUsedMb: m.heapUsedMb,
    heapMaxMb: m.heapCapMb,
    heapPercent: m.heapPct,
    edenUsedMb: m.edenUsedMb,
    edenMaxMb: m.edenCapMb,
    edenPercent: pct(m.edenUsedMb, m.edenCapMb),
    oldUsedMb: m.oldUsedMb,
    oldMaxMb: m.oldCapMb,
    oldPercent: pct(m.oldUsedMb, m.oldCapMb),
    metaUsedMb: m.metaUsedMb,
    metaMaxMb: m.metaCapMb,
    metaPercent: pct(m.metaUsedMb, m.metaCapMb),
    youngGcCount: m.youngGcCount,
    youngGcTime: m.youngGcTime,
    fullGcCount: m.fullGcCount,
    fullGcTime: m.fullGcTime,
  };
}

function validateInputs(req: { query: Record<string, unknown> }): {
  ok: true;
  server: string;
  app: string;
  component: string;
} | { ok: false; status: number; error: string } {
  const server = validateServer(req.query.server as string);
  const app = req.query.app as string;
  const component = req.query.component as string;

  if (!server) return { ok: false, status: 400, error: "Invalid or missing server name" };
  if (!app || !validateAppName(app)) return { ok: false, status: 400, error: "Invalid or missing app name" };
  if (!component || !validateAppName(component)) return { ok: false, status: 400, error: "Invalid or missing component name" };
  return { ok: true, server, app, component };
}

/** One-shot heap snapshot. */
heapRouter.get("/", async (req, res) => {
  const v = validateInputs(req);
  if (!v.ok) {
    res.status(v.status).json({ error: v.error });
    return;
  }

  const entry = getServerConfig().find((s) => s.name === v.server);
  if (!entry) {
    res.status(400).json({ error: `Server "${v.server}" not found in config` });
    return;
  }

  const result = await getJvmHeap(entry, v.app, v.component);
  if (!result.ok) {
    res.json({ raw: result.message });
    return;
  }
  res.json({ server: v.server, app: v.app, component: v.component, heap: toHeapData(result.metrics) });
});

/** SSE stream for live heap updates. */
heapRouter.get("/stream", async (req, res) => {
  const v = validateInputs(req);
  if (!v.ok) {
    res.status(v.status).json({ error: v.error });
    return;
  }
  const entry = getServerConfig().find((s) => s.name === v.server);
  if (!entry) {
    res.status(400).json({ error: `Server "${v.server}" not found in config` });
    return;
  }

  const interval = Math.max(3, parseInt((req.query.interval as string) || "5", 10));

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
      const result = await getJvmHeap(entry, v.app, v.component);
      const data = result.ok
        ? { server: v.server, app: v.app, component: v.component, heap: toHeapData(result.metrics) }
        : { raw: result.message };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify({ error: "Failed to fetch heap data" })}\n\n`);
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
