/**
 * GET /api/logs/download?server&app&component&logType&date — download a log file.
 *
 * Reads the chosen log file over ssh2 (key-aware) and gzip-streams the
 * content back to the browser. No local temp file — the cat output flows
 * directly through gzip into the response.
 */
import { Router } from "express";
import { sshExec, sshExecStream } from "@nrs/server-mcp/client";
import { validateServer, validateAppName } from "../lib/validate.js";
import { getServerConfig } from "../lib/server-config.js";
import { createGzip } from "node:zlib";
import { logger } from "../lib/logger.js";

export const logDownloadRouter = Router();

const FILENAME_RE = /^[A-Za-z0-9._-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Hard ceiling on download size — sanity guard against runaway transfers. */
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

logDownloadRouter.get("/", async (req, res) => {
  const server = validateServer(req.query.server as string);
  const app = req.query.app as string;
  const component = req.query.component as string;
  const logType = (req.query.logType as string) || "app";
  const date = req.query.date as string | undefined;

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
  if (!["app", "catalina", "access"].includes(logType)) {
    res.status(400).json({ error: "Invalid logType" });
    return;
  }
  if (date && date !== "current" && !DATE_RE.test(date)) {
    res.status(400).json({ error: "Invalid date (YYYY-MM-DD or 'current')" });
    return;
  }

  const entry = getServerConfig().find((s) => s.name === server);
  if (!entry) {
    res.status(400).json({ error: `Server "${server}" not found in config` });
    return;
  }

  const logDir = `${entry.logsBase}/${app}/${component}`;
  const today = new Date().toISOString().slice(0, 10);
  let logFileName: string;
  switch (logType) {
    case "catalina":
      logFileName = `catalina.${date && date !== "current" ? date : today}.log`;
      break;
    case "access":
      logFileName = `localhost_access_log.${date && date !== "current" ? date : today}.log`;
      break;
    default:
      logFileName = date && date !== "current" ? `${component}.${date}.log` : `${component}.log`;
  }

  if (!FILENAME_RE.test(logFileName)) {
    res.status(400).json({ error: "Invalid log file name" });
    return;
  }

  const remotePath = `${logDir}/${logFileName}`;

  // Pre-flight: confirm the file is a readable regular file and within the
  // size ceiling BEFORE committing response headers. `wc -c` emits the byte
  // count; the guard emits MISSING when the path isn't readable. This keeps
  // the clean 404/413 semantics that streaming alone can't offer once bytes
  // are flowing.
  const probe = await sshExec(
    entry,
    `if [ -r ${remotePath} ] && [ -f ${remotePath} ]; then wc -c < ${remotePath}; else echo MISSING; fi`,
    30_000,
  );
  const probeOut = probe.stdout.trim();
  if (probe.exitCode !== 0 || probeOut === "MISSING" || probeOut === "") {
    logger.warn("log download not readable", {
      server,
      remotePath,
      exitCode: probe.exitCode,
      stderr: probe.stderr.slice(0, 200),
    });
    res.status(404).json({ error: `Log file not readable: ${remotePath}` });
    return;
  }
  const sizeBytes = parseInt(probeOut, 10);
  if (Number.isFinite(sizeBytes) && sizeBytes > MAX_DOWNLOAD_BYTES) {
    res.status(413).json({
      error:
        `Log file is ${Math.round(sizeBytes / (1024 * 1024))} MB, exceeding the ` +
        `${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB download limit. Use tail or search instead.`,
    });
    return;
  }

  // Stream the file straight through gzip to the response — the ssh2 channel
  // is piped without ever buffering the whole file in memory.
  let stream;
  try {
    stream = await sshExecStream(entry, `cat ${remotePath}`, 60_000);
  } catch (err) {
    logger.warn("log download stream failed to start", {
      server,
      remotePath,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ error: `Failed to read log file: ${remotePath}` });
    return;
  }

  const downloadName = `${server}-${app}-${component}-${logFileName}.gz`;
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);

  const gzip = createGzip();
  // Tear down the SSH channel if the client disconnects or anything errors,
  // so we never leak the connection.
  res.on("close", () => stream.destroy());
  stream.on("error", (err: Error) => {
    logger.warn("log download stream error", { server, remotePath, error: err.message });
    gzip.destroy();
    res.destroy();
  });
  gzip.on("error", () => {
    stream.destroy();
    res.destroy();
  });

  stream.pipe(gzip).pipe(res);
});
