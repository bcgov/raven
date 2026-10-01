import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

/** Tuning for {@link withAuthLock}; the defaults suit an interactive browser login. */
export interface AuthLockOptions {
  /** A lock older than this is treated as abandoned (default 5 min, above the 4 min capture timeout). */
  readonly staleMs?: number;
  /** How long to wait for another owner before giving up (default 5 min). */
  readonly waitMs?: number;
  /** Delay between attempts while waiting (default 250 ms). */
  readonly pollMs?: number;
}

interface LockRecord {
  readonly pid: number;
  readonly at: number;
  readonly token: string;
}

const DEFAULT_STALE_MS = 300_000;
const DEFAULT_WAIT_MS = 300_000;
const DEFAULT_POLL_MS = 250;
const REAP_STALE_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(lockPath: string): Promise<LockRecord | null> {
  try {
    const record = JSON.parse(await readFile(lockPath, "utf-8")) as Partial<LockRecord>;
    if (typeof record.pid === "number" && typeof record.at === "number" && typeof record.token === "string") {
      return record as LockRecord;
    }
  } catch {
    // Missing, or caught mid-write by the owner; the caller re-reads next poll.
  }
  return null;
}

/**
 * Remove the lock if it is abandoned: its owner died, or it is older than
 * `staleMs` (which also covers a recycled pid). The record is re-read and
 * compared by token just before unlinking so a lock that changed hands in the
 * meantime is left alone. Callers must hold the reclaim lease (see
 * {@link clearIfStale}); without it, check-then-unlink is not atomic.
 */
async function removeIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const seen = await readLock(lockPath);
  if (!seen) {
    // Empty or partial: either an owner mid-write (fresh) or one that died
    // between creating the file and writing its record (old). Go by mtime.
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs <= staleMs) return false;
    } catch {
      return false;
    }
    await unlink(lockPath).catch(() => {});
    return true;
  }
  if (pidAlive(seen.pid) && Date.now() - seen.at <= staleMs) return false;

  const current = await readLock(lockPath);
  if (current?.token !== seen.token) return false;
  await unlink(lockPath).catch(() => {});
  return true;
}

/**
 * Reclaim an abandoned lock, one process at a time.
 *
 * Judging a lock stale and unlinking it are two steps. Unserialised, two
 * waiters could both judge the same stale lock, the first could unlink it and
 * take a fresh one, and the second could then unlink that fresh lock and enter
 * the critical section alongside it. Reclaiming therefore needs its own
 * short-lived lease, `<lockPath>.reap`, created exclusively: whoever holds it
 * judges and removes, everyone else just keeps polling. A second waiter that
 * later wins the lease finds the first one's new, live lock and leaves it.
 *
 * The lease is held for milliseconds, so one older than `REAP_STALE_MS` was
 * left by a crash and is cleared for the next poll. (That clearing is itself
 * unserialised, but it only fires for a holder that stalled for 10 s inside a
 * millisecond section.)
 */
async function clearIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const leasePath = `${lockPath}.reap`;
  let lease;
  try {
    lease = await open(leasePath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - (await stat(leasePath)).mtimeMs > REAP_STALE_MS) await unlink(leasePath);
    } catch {
      // Released or replaced while we looked; the next poll sorts it out.
    }
    return false;
  }

  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
  } finally {
    await lease.close();
  }
  try {
    return await removeIfStale(lockPath, staleMs);
  } finally {
    await unlink(leasePath).catch(() => {});
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock.
 *
 * Every SiteMinder and SharePoint capture shares one persistent Chromium
 * profile, and Chromium lets only a single process own a profile. When several
 * MCP servers hit session expiry together (Claude issues parallel tool calls),
 * the losers would fail on the profile lock. Serialising them here lets each
 * waiter re-check the session cache once it owns the lock and adopt the login
 * the winner just finished instead of opening another browser.
 */
export async function withAuthLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: AuthLockOptions = {}
): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        const record: LockRecord = { pid: process.pid, at: Date.now(), token };
        await handle.writeFile(JSON.stringify(record));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await clearIfStale(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for another RAVEN process to finish logging in. " +
            `If none is running, delete ${lockPath} and try again.`
        );
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    // Only remove our own lock; it may have been judged stale and taken over.
    if ((await readLock(lockPath))?.token === token) {
      await unlink(lockPath).catch(() => {});
    }
  }
}
