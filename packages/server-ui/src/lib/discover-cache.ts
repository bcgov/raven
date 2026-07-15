/**
 * On-disk cache of per-server discovery results.
 *
 * Backs the /api/discover/cache route — lets the UI populate dropdowns
 * without doing any SSH on app startup. The cache is updated only when
 * a user explicitly refreshes a server via /api/discover/:server.
 *
 * File format: JSON array of CachedServer objects.
 * Default location: ~/.raven/cache/discover.json
 * Override the location via the constructor for tests.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CachedServerApp {
  app: string;
  component: string;
  version: string;
  port: string;
}

export interface CachedServer {
  server: string;
  apps: CachedServerApp[];
  /** ISO 8601 timestamp of when this server was last discovered. */
  discoveredAt: string;
}

const DEFAULT_CACHE_FILE = join(homedir(), ".raven", "cache", "discover.json");

/** Read the cache. Returns empty array if missing or corrupt — never throws. */
export function readCache(file: string = DEFAULT_CACHE_FILE): CachedServer[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Write the cache atomically: writes to a sibling temp file and renames it
 * into place. A crash mid-write leaves the previous cache intact rather
 * than producing a corrupt JSON that readCache would silently treat as
 * empty (and cause every server to look "never discovered").
 */
export function writeCache(
  data: CachedServer[],
  file: string = DEFAULT_CACHE_FILE,
): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, file);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw err;
  }
}

/**
 * Replace one server's entry in the cache (or add it). Returns the new cache,
 * sorted by server name. Pure function — does not write to disk.
 */
export function upsertServer(
  cache: CachedServer[],
  server: string,
  apps: CachedServerApp[],
  discoveredAt: string,
): CachedServer[] {
  const filtered = cache.filter((s) => s.server !== server);
  filtered.push({ server, apps, discoveredAt });
  return filtered.sort((a, b) => a.server.localeCompare(b.server));
}
