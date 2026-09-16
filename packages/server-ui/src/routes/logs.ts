/**
 * GET /api/logs?server&app&component&pattern&logType&date&dateFrom&dateTo&maxLines&context
 *
 * Search application logs on a remote server.
 * Supports single date (date=YYYY-MM-DD) or range (dateFrom + dateTo).
 */
import { Router } from "express";
import { searchLogs, isValidLogDate, type LogType } from "@nrs/server-mcp/client";
import { validateServer, validateAppName, validatePattern } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";
import { logger } from "../lib/logger.js";

export const logsRouter = Router();

logsRouter.get("/", async (req, res) => {
  const server = validateServer(req.query.server as string);
  const app = req.query.app as string;
  const component = req.query.component as string;
  const pattern = req.query.pattern as string;

  if (!server) {
    res.status(400).json({ error: "Invalid or missing server name" });
    return;
  }
  if (!app || !validateAppName(app)) {
    res.status(400).json({ error: "Invalid or missing app name" });
    return;
  }
  if (!component || !validateAppName(component)) {
    res.status(400).json({ error: "Invalid or missing component name" });
    return;
  }
  if (!pattern || !validatePattern(pattern)) {
    res.status(400).json({ error: "Invalid or missing search pattern" });
    return;
  }

  const logTypeRaw = (req.query.logType as string) || "app";
  if (!["app", "catalina", "access"].includes(logTypeRaw)) {
    res.status(400).json({ error: "Invalid logType (use app, catalina, or access)" });
    return;
  }
  const logType = logTypeRaw as LogType;
  const date = req.query.date as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;
  const maxLines = Math.min(parseInt((req.query.maxLines as string) || "100", 10), 500);
  const context = Math.min(parseInt((req.query.context as string) || "0", 10), 10);

  if (dateFrom !== undefined && !isValidLogDate(dateFrom)) {
    res.status(400).json({ error: "Invalid dateFrom format (use YYYY-MM-DD)" });
    return;
  }
  if (dateTo !== undefined && !isValidLogDate(dateTo)) {
    res.status(400).json({ error: "Invalid dateTo format (use YYYY-MM-DD)" });
    return;
  }
  // `date` is forwarded to buildLogSearchCommand, which now rejects anything
  // that is not YYYY-MM-DD or "today". Check it here so a malformed value
  // returns the same 400 as its siblings rather than a 500 raised from the
  // builder. "current" is this route's sentinel for the active log file and
  // is mapped to undefined below.
  if (date !== undefined && date !== "current" && date !== "today" && !isValidLogDate(date)) {
    res.status(400).json({ error: "Invalid date format (use YYYY-MM-DD, 'today', or 'current')" });
    return;
  }

  const entry = getServerConfig().find((s) => s.name === server);
  if (!entry) {
    res.status(400).json({ error: `Server "${server}" not found in config` });
    return;
  }

  // A complete date range supersedes a single date, and "current" names the
  // active log file; both mean "no dated filename", so both map to undefined.
  // The range test matches the builder's own `dateFrom && dateTo` condition —
  // an incomplete range is not a range, and the explicit date still wins.
  const hasRange = Boolean(dateFrom && dateTo);
  const effectiveDate = hasRange || !date || date === "current" ? undefined : date;

  const result = await searchLogs(entry, {
    app,
    component,
    pattern,
    logType,
    date: effectiveDate,
    dateFrom,
    dateTo,
    maxLines,
    contextLines: context,
  });

  if (result.exitCode !== 0) {
    logger.error("log search failed", { server, app, component, exitCode: result.exitCode });
    res.status(500).json({ error: result.output || "Log search failed" });
    return;
  }

  res.json({
    server,
    app,
    component,
    pattern,
    lines: result.output
      .split("\n")
      .filter((l) => l.trim() !== ""),
  });
});
