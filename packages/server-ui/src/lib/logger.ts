/**
 * File logger for the Server Monitor Web UI.
 *
 * Writes to ~/.raven/logs/server-ui.log with daily rotation.
 * Logs API requests, responses, CLI tool executions, and errors.
 * Never logs passwords or sensitive credentials.
 */
import { createWriteStream, mkdirSync, existsSync, renameSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Request, Response, NextFunction } from "express";

const LOG_DIR = join(homedir(), ".raven", "logs");
const LOG_FILE = join(LOG_DIR, "server-ui.log");
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB before rotation

/** Log levels. */
type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

/** Numeric severity for filtering (higher = more severe). */
const LEVEL_SEVERITY: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/**
 * Decide whether a level should be written given a threshold.
 * Pure logic, exported for testing.
 */
export function shouldLog(level: Level, threshold: Level): boolean {
  return LEVEL_SEVERITY[level] >= LEVEL_SEVERITY[threshold];
}

/** Resolve the configured threshold from env (LOG_LEVEL or ~/.raven/.env). */
function resolveThreshold(): Level {
  const candidate = (
    process.env["LOG_LEVEL"] ?? readLogLevelFromEnvFile() ?? "INFO"
  ).toUpperCase();
  return candidate in LEVEL_SEVERITY ? (candidate as Level) : "INFO";
}

function readLogLevelFromEnvFile(): string | undefined {
  try {
    const content = readFileSync(join(homedir(), ".raven", ".env"), "utf-8");
    const m = content.match(/^LOG_LEVEL=(.+)$/m);
    return m?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const threshold: Level = resolveThreshold();

let stream: ReturnType<typeof createWriteStream>;
let currentSize = 0;

function ensureStream(): void {
  if (stream) return;
  mkdirSync(LOG_DIR, { recursive: true });
  stream = createWriteStream(LOG_FILE, { flags: "a" });
  // Estimate current file size
  try {
    currentSize = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;
  } catch {
    currentSize = 0;
  }
}

function rotate(): void {
  if (currentSize < MAX_SIZE) return;
  try {
    stream.end();
    const timestamp = new Date().toISOString().slice(0, 10);
    const rotated = join(LOG_DIR, `server-ui.${timestamp}.log`);
    if (existsSync(LOG_FILE)) {
      renameSync(LOG_FILE, rotated);
    }
    stream = createWriteStream(LOG_FILE, { flags: "a" });
    currentSize = 0;
  } catch {
    // If rotation fails, keep writing to current file
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Write a log entry. Filtered by the LOG_LEVEL env var (default INFO).
 * Errors always reach stderr regardless of file-write filtering.
 */
export function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level, threshold)) {
    // Skip writes below threshold — but ERROR always reaches stderr.
    if (level === "ERROR") {
      const entry = meta
        ? `${formatTimestamp()} [${level}] ${message} ${JSON.stringify(meta)}\n`
        : `${formatTimestamp()} [${level}] ${message}\n`;
      process.stderr.write(entry);
    }
    return;
  }

  ensureStream();
  rotate();

  const entry = meta
    ? `${formatTimestamp()} [${level}] ${message} ${JSON.stringify(meta)}\n`
    : `${formatTimestamp()} [${level}] ${message}\n`;

  stream.write(entry);
  currentSize += Buffer.byteLength(entry);

  // Also write errors to stderr for visibility
  if (level === "ERROR") {
    process.stderr.write(entry);
  }
}

/** Convenience methods. */
export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => log("INFO", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("WARN", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("ERROR", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log("DEBUG", msg, meta),
};

/**
 * Express middleware — logs every API request and response.
 *
 * Format: METHOD /path → STATUS (duration ms)
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const level: Level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    log(level, `${req.method} ${req.originalUrl} → ${res.statusCode}`, {
      duration: `${duration}ms`,
      ...(req.query && Object.keys(req.query).length > 0 && { query: req.query }),
      ...(req.params && Object.keys(req.params).length > 0 && { params: req.params }),
    });
  });

  next();
}
