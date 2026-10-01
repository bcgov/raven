import { readFile, unlink } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * How long after a failed browser login further attempts fail fast instead of
 * opening another login. Several MCP servers can queue behind one login; if it
 * fails (the user ignores the window, the browser is missing), each waiter
 * would otherwise open its own window in turn and autofill the password again,
 * which is how an IDIR account gets locked.
 */
export const AUTH_FAILURE_COOLDOWN_MS = 30_000;

const MAX_MESSAGE_CHARS = 200;

/** Clock-skew allowance for a memo stamped in the future. */
const MAX_FUTURE_MS = 60_000;

/** A recent failed browser login, as recorded by {@link recordAuthFailure}. */
export interface RecentAuthFailure {
  /** When the login failed (epoch milliseconds). */
  readonly at: number;
  /** One line saying why. */
  readonly message: string;
}

/**
 * Record that a browser login just failed. Keeps only the time and the first
 * line of the reason (bounded). Never throws: the memo is a courtesy that
 * spares the next caller a pointless login, not part of the login itself.
 *
 * @param memoPath - The per-product memo file, beside the capture lock.
 * @param message - Why the login failed.
 */
export async function recordAuthFailure(memoPath: string, message: string): Promise<void> {
  try {
    const line = message.split("\n")[0].slice(0, MAX_MESSAGE_CHARS);
    await writeFileAtomic(memoPath, JSON.stringify({ at: Date.now(), message: line }));
  } catch {
    // Nothing to do: without a memo the next caller simply tries the login.
  }
}

/**
 * The failure recorded by {@link recordAuthFailure} if it happened within
 * `withinMs`; null when there is none, it is older, or the file cannot be
 * trusted (unreadable, not a record, no usable time, stamped in the future).
 * A bad file therefore can never block a login.
 *
 * @param memoPath - The per-product memo file.
 * @param withinMs - How recent the failure must be to count.
 */
export async function readRecentAuthFailure(
  memoPath: string,
  withinMs: number
): Promise<RecentAuthFailure | null> {
  try {
    const data = JSON.parse(await readFile(memoPath, "utf-8")) as Partial<RecentAuthFailure> | null;
    if (!data || typeof data.at !== "number" || !Number.isFinite(data.at) || typeof data.message !== "string") {
      return null;
    }
    const age = Date.now() - data.at;
    if (age < -MAX_FUTURE_MS || age >= withinMs) return null;
    return { at: data.at, message: data.message };
  } catch {
    return null;
  }
}

/**
 * Forget a recorded failure (after a successful login, or an explicit reset).
 * Removing nothing is not an error.
 *
 * @param memoPath - The per-product memo file.
 */
export async function clearAuthFailure(memoPath: string): Promise<void> {
  try {
    await unlink(memoPath);
  } catch {
    // Missing, or not removable; either way the cooldown expires on its own.
  }
}
