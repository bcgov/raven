import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";
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
 * The write is atomic (see {@link writeFileAtomic}), so a sibling process
 * never reads a truncated file.
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

  await writeFileAtomic(cachePath, JSON.stringify(data, null, 2));
}

/**
 * Delete the cached SPO session file.
 * Returns true when the file is gone afterwards (removed, or it was not there)
 * and false when it could not be removed.
 */
export async function clearCachedSpoSession(cachePath: string): Promise<boolean> {
  try {
    await unlink(cachePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Delete the cache only if it still holds `failedPair`. A sibling process may
 * have cached a fresher login since the caller's pair died; deleting that
 * would throw the new login away. The SharePoint twin of
 * `clearCachedSessionIf`: a file that cannot be read or parsed is left alone,
 * and valid JSON that is not a usable record is removed. Returns true only
 * when the file is gone afterwards.
 */
export async function clearCachedSpoSessionIf(
  cachePath: string,
  failedPair: SpoCookies
): Promise<boolean> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(cachePath, "utf-8"));
  } catch {
    return false;
  }
  const cached = data as Partial<SpoSessionData> | null;
  const usable = !!cached?.fedAuth && !!cached?.rtFa;
  if (usable && (cached?.fedAuth !== failedPair.fedAuth || cached?.rtFa !== failedPair.rtFa)) {
    return false;
  }

  return clearCachedSpoSession(cachePath);
}
