#!/usr/bin/env node
/**
 * Server Monitor Web UI — entry point.
 *
 * Loads environment from ~/.raven/.env and starts the Express server
 * on 127.0.0.1:3777 (localhost only, no network exposure).
 */
import { loadEnv } from "@nrs/auth";
import { createApp } from "./server.js";
import { logger } from "./lib/logger.js";
import { join } from "node:path";
import { homedir } from "node:os";

loadEnv();

const PORT = parseInt(process.env["SERVER_UI_PORT"] ?? "3777", 10);
const LOG_FILE = join(homedir(), ".raven", "logs", "server-ui.log");
const app = createApp();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server Monitor UI → http://localhost:${PORT}`);
  console.log(`Logging to          ${LOG_FILE}`);
  logger.info("Server started", { port: PORT, logFile: LOG_FILE });
});
