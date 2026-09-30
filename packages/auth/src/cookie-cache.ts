import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionData } from "./types.js";

const DEFAULT_TTL_SECONDS = 1500; // 25 minutes

/**
 * Whether a value is a real SMSESSION. SiteMinder answers a dead or logged-off
 * session with `SMSESSION=LOGGEDOFF`, which is a marker rather than a session:
 * caching it passes the age check and then fails every downstream request.
 */
export function isUsableSmsession(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  return !!trimmed && trimmed.toUpperCase() !== "LOGGEDOFF";
}

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

    if (!isUsableSmsession(data.smsession)) return null;

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
 * Refuses an unusable value (see {@link isUsableSmsession}) and leaves any
 * existing cache untouched.
 */
export async function writeCachedSession(
  cachePath: string,
  cookie: string,
  capturedFor: string = new URL(
    process.env["ATLASSIAN_BASE_URL"] ?? "https://apps.example.gov.bc.ca"
  ).hostname
): Promise<void> {
  if (!isUsableSmsession(cookie)) {
    throw new Error("Refusing to cache an unusable SMSESSION value");
  }

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

/**
 * Delete the cache only if it still holds `failedCookie` (or holds nothing
 * usable). A sibling process or the CLI may have cached a fresher login since
 * the caller's cookie died; deleting that would throw the new login away.
 * Returns whether the file was removed.
 */
export async function clearCachedSessionIf(
  cachePath: string,
  failedCookie: string
): Promise<boolean> {
  try {
    if (!existsSync(cachePath)) return false;

    const data: SessionData = JSON.parse(await readFile(cachePath, "utf-8"));
    if (isUsableSmsession(data.smsession) && data.smsession !== failedCookie) return false;
  } catch {
    // Unreadable or corrupt cache is not worth keeping.
  }

  await clearCachedSession(cachePath);
  return true;
}
