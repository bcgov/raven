import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";
import type { SessionData } from "./types.js";

const DEFAULT_TTL_SECONDS = 1500; // 25 minutes

/** How far in the future a cached timestamp may be before it is distrusted (clock skew allowance). */
const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * The host recorded beside a cached cookie (informational only; never read
 * back): the configured Atlassian host, or "unknown" when that is blank or not
 * a URL. Computed here, not in a default parameter, so a bad environment value
 * can never make a cache write throw after a successful login.
 */
function defaultCapturedFor(): string {
  try {
    return new URL(process.env["ATLASSIAN_BASE_URL"] || "https://apps.example.gov.bc.ca").hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Whether a value is a real SMSESSION. SiteMinder answers a dead or logged-off
 * session with `SMSESSION=LOGGEDOFF`, which is a marker rather than a session:
 * caching it passes the age check and then fails every downstream request.
 * Accepts `unknown` because it is applied to values parsed from a cache file
 * that anything may have written.
 */
export function isUsableSmsession(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.toUpperCase() !== "LOGGEDOFF";
}

/**
 * Read a cached SMSESSION from disk.
 * Returns the cookie value if valid and not expired, null otherwise. An entry
 * whose timestamp is missing, non-numeric or far in the future is rejected:
 * the age of such an entry is NaN or negative, which would otherwise compare
 * as "younger than the TTL" and be served forever.
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
    if (!Number.isFinite(data.cachedAt)) return null;

    const ageSeconds = (Date.now() - data.cachedAt) / 1000;
    if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS || ageSeconds >= ttlSeconds) {
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
 * existing cache untouched. The write is atomic (see {@link writeFileAtomic}).
 */
export async function writeCachedSession(
  cachePath: string,
  cookie: string,
  capturedFor: string = defaultCapturedFor()
): Promise<void> {
  if (!isUsableSmsession(cookie)) {
    throw new Error("Refusing to cache an unusable SMSESSION value");
  }

  const data: SessionData = {
    smsession: cookie,
    cachedAt: Date.now(),
    capturedFor,
  };

  await writeFileAtomic(cachePath, JSON.stringify(data, null, 2));
}

/**
 * Delete the cached session file.
 * Returns true when the file is gone afterwards (removed, or it was not there)
 * and false when it could not be removed, so callers can tell the cache is
 * still in place instead of assuming it was cleared.
 */
export async function clearCachedSession(cachePath: string): Promise<boolean> {
  try {
    await unlink(cachePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Delete the cache only if it still holds `failedCookie` (or a value that is
 * not a usable session). A sibling process or the CLI may have cached a
 * fresher login since the caller's cookie died; deleting that would throw the
 * new login away. A file that cannot be read or parsed is left alone: writes
 * are atomic, so it is not a sibling's half-finished write, and readers
 * already ignore it until the next write replaces it. Returns true only when
 * the file is gone afterwards; false when it was left alone or could not be
 * removed.
 *
 * The read and the unlink are two steps, so a sibling could still cache a new
 * cookie between them. That window is well under a millisecond and the worst
 * outcome is one extra login, so it is accepted rather than locked.
 */
export async function clearCachedSessionIf(
  cachePath: string,
  failedCookie: string
): Promise<boolean> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(cachePath, "utf-8"));
  } catch {
    return false;
  }
  const cached = (data as Partial<SessionData> | null)?.smsession;
  if (isUsableSmsession(cached) && cached !== failedCookie) return false;

  return clearCachedSession(cachePath);
}
