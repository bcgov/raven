import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { SpoCookies, SpoSessionData } from "./types.js";

const DEFAULT_TTL_SECONDS = 28800; // 8 hours — SPO cookies far outlive SMSESSION

/**
 * Read a cached SharePoint Online cookie pair from disk.
 * Returns the pair if present and not past the TTL, null otherwise.
 */
export async function readCachedSpoSession(
  cachePath: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<SpoCookies | null> {
  try {
    if (!existsSync(cachePath)) return null;

    const raw = await readFile(cachePath, "utf-8");
    const data: SpoSessionData = JSON.parse(raw);

    if (!data.fedAuth || !data.rtFa) return null;

    // A missing/garbage cachedAt makes the age NaN, which would bypass the
    // TTL comparison and never expire — reject the entry instead.
    if (!Number.isFinite(data.cachedAt)) return null;

    const ageSeconds = (Date.now() - data.cachedAt) / 1000;
    if (ageSeconds >= ttlSeconds) return null;

    return { fedAuth: data.fedAuth, rtFa: data.rtFa };
  } catch {
    return null;
  }
}

/**
 * Write a SharePoint Online cookie pair to the cache file (mode 0600).
 */
export async function writeCachedSpoSession(
  cachePath: string,
  cookies: SpoCookies,
  capturedFor: string = "sharepoint.com"
): Promise<void> {
  const data: SpoSessionData = {
    fedAuth: cookies.fedAuth,
    rtFa: cookies.rtFa,
    cachedAt: Date.now(),
    capturedFor,
  };

  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await writeFile(cachePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Delete the cached SPO session file. */
export async function clearCachedSpoSession(cachePath: string): Promise<void> {
  try {
    await unlink(cachePath);
  } catch {
    // File doesn't exist, that's fine
  }
}
