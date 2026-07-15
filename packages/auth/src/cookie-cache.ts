import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionData } from "./types.js";

const DEFAULT_TTL_SECONDS = 1500; // 25 minutes

/**
 * Read a cached SMSESSION from disk.
 * Returns the cookie value if valid and not expired, null otherwise.
 */
export async function readCachedSession(
  cachePath: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string | null> {
  try {
    if (!existsSync(cachePath)) return null;

    const raw = await readFile(cachePath, "utf-8");
    const data: SessionData = JSON.parse(raw);

    if (!data.smsession) return null;

    const ageSeconds = (Date.now() - data.cachedAt) / 1000;
    if (ageSeconds >= ttlSeconds) {
      return null;
    }

    return data.smsession;
  } catch {
    return null;
  }
}

/**
 * Write an SMSESSION cookie to the cache file.
 */
export async function writeCachedSession(
  cachePath: string,
  cookie: string,
  capturedFor: string = new URL(
    process.env["ATLASSIAN_BASE_URL"] ?? "https://apps.example.gov.bc.ca"
  ).hostname
): Promise<void> {
  const data: SessionData = {
    smsession: cookie,
    cachedAt: Date.now(),
    capturedFor,
  };

  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await writeFile(cachePath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Delete the cached session file.
 */
export async function clearCachedSession(cachePath: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(cachePath);
  } catch {
    // File doesn't exist, that's fine
  }
}
