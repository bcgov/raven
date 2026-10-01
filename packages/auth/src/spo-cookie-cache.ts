import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";
import type { SpoCookies, SpoSessionData } from "./types.js";

const DEFAULT_TTL_SECONDS = 28800; // 8 hours — SPO cookies far outlive SMSESSION

/** How far in the future a cached timestamp may be before it is distrusted (clock skew allowance). */
const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * Whether a value is a usable SharePoint cookie pair: `fedAuth` and `rtFa` are
 * both non-blank strings. Accepts `unknown` because it is applied to values
 * parsed from a cache file that anything may have written, and to what the
 * capture child reported.
 */
export function isUsableSpoPair(value: unknown): value is SpoCookies {
  const pair = value as Partial<Record<keyof SpoCookies, unknown>> | null | undefined;
  const nonBlank = (cookie: unknown): boolean => typeof cookie === "string" && cookie.trim() !== "";
  return nonBlank(pair?.fedAuth) && nonBlank(pair?.rtFa);
}

/**
 * Read a cached SharePoint Online cookie pair from disk.
 * Returns the pair if present and not past the TTL, null otherwise. An entry
 * whose cookies are not non-blank strings, or whose timestamp is missing,
 * non-numeric or far in the future, is rejected: the age of such an entry is
 * NaN or negative, which would otherwise compare as "younger than the TTL" and
 * be served long after it should have expired.
 */
export async function readCachedSpoSession(
  cachePath: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<SpoCookies | null> {
  try {
    if (!existsSync(cachePath)) return null;

    const raw = await readFile(cachePath, "utf-8");
    const data: SpoSessionData = JSON.parse(raw);

    if (!isUsableSpoPair(data)) return null;

    // A missing/garbage cachedAt makes the age NaN, which would bypass the
    // TTL comparison and never expire — reject the entry instead.
    if (!Number.isFinite(data.cachedAt)) return null;

    const ageSeconds = (Date.now() - data.cachedAt) / 1000;
    if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS || ageSeconds >= ttlSeconds) return null;

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
 * when the file is gone afterwards (removed, or it was not there).
 */
export async function clearCachedSpoSessionIf(
  cachePath: string,
  failedPair: SpoCookies
): Promise<boolean> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(cachePath, "utf-8"));
  } catch (err) {
    // A missing file is already gone; any other failure leaves it as it was.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (isUsableSpoPair(data) && (data.fedAuth !== failedPair.fedAuth || data.rtFa !== failedPair.rtFa)) {
    return false;
  }

  return clearCachedSpoSession(cachePath);
}
