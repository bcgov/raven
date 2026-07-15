/**
 * GET /api/logs/tail?server&app&component&logType        — one-shot last N lines
 * GET /api/logs/tail/stream?server&app&component&logType — SSE live stream
 */
import { Router } from "express";
import { tailLog, type LogType } from "@nrs/server-mcp/client";
import { validateServer, validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";

export const logTailRouter = Router();

function validateInputs(req: { query: Record<string, unknown> }): {
  ok: true;
  server: string;
  app: string;
  component: string;
  logType: LogType;
} | { ok: false; status: number; error: string } {
  const server = validateServer(req.query.server as string);
  const app = req.query.app as string;
  const component = req.query.component as string;
  const logTypeRaw = (req.query.logType as string) || "app";

  if (!server) return { ok: false, status: 400, error: "Invalid or missing server name" };
  if (!app || !validateAppName(app)) return { ok: false, status: 400, error: "Invalid or missing app name" };
  if (!component || !validateAppName(component)) return { ok: false, status: 400, error: "Invalid or missing component name" };
  if (!["app", "catalina", "access"].includes(logTypeRaw)) return { ok: false, status: 400, error: "Invalid logType" };
  return { ok: true, server, app, component, logType: logTypeRaw as LogType };
}

logTailRouter.get("/", async (req, res) => {
  const v = validateInputs(req);
  if (!v.ok) {
    res.status(v.status).json({ error: v.error });
    return;
  }
  const lines = Math.min(parseInt((req.query.lines as string) || "100", 10), 500);

  const entry = getServerConfig().find((s) => s.name === v.server);
  if (!entry) {
    res.status(400).json({ error: `Server "${v.server}" not found in config` });
    return;
  }

  const result = await tailLog(entry, v.app, v.component, v.logType, lines);
  if (result.exitCode !== 0) {
    res.status(500).json({ error: result.output || "Tail failed" });
    return;
  }

  const outputLines = result.output.split("\n").filter((l) => l.trim() !== "");
  res.json({ server: v.server, app: v.app, component: v.component, logType: v.logType, lines: outputLines });
});

logTailRouter.get("/stream", async (req, res) => {
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
  const interval = Math.max(3, parseInt((req.query.interval as string) || "3", 10));

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let running = true;
  let seenLines = new Set<string>();
  let initialized = false;

  req.on("close", () => {
    running = false;
  });

  const sendUpdate = async () => {
    try {
      const result = await tailLog(entry, v.app, v.component, v.logType, 100, 30_000);
      const allLines = result.output.split("\n").filter((l) => l.trim() !== "");

      if (!initialized) {
        seenLines = new Set(allLines);
        initialized = true;
        res.write(`data: ${JSON.stringify({ lines: allLines, newCount: 0, total: allLines.length })}\n\n`);
        return;
      }

      const newLines = allLines.filter((l) => !seenLines.has(l));
      seenLines = new Set(allLines);
      res.write(`data: ${JSON.stringify({ lines: allLines, newCount: newLines.length, total: allLines.length })}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify({ error: "Failed to fetch log tail" })}\n\n`);
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
