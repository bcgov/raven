import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

/** Tuning for {@link withAuthLock}; the defaults suit an interactive browser login. */
export interface AuthLockOptions {
  /** A lock older than this is treated as abandoned (default 6 min, above the longest capture's 5 min process timeout). */
  readonly staleMs?: number;
  /** How long to wait for another owner before giving up (default 6 min, so a waiter outlasts the longest capture). */
  readonly waitMs?: number;
  /** Delay between attempts while waiting (default 250 ms). */
  readonly pollMs?: number;
  /**
   * Called once, the first time the lock turns out to be held and the caller
   * has to wait, which normally means another login is in progress. A login can
   * take minutes, so without a notice the waiter looks hung. Not called when the
   * lock is free or is reclaimed at once; it can still be called briefly while
   * several waiters race to reclaim a dead owner's lock. If it returns a
   * promise, a rejection is ignored.
   */
  readonly onWait?: () => void;
}

interface LockRecord {
  readonly pid: number;
  readonly at: number;
  readonly token: string;
}

/** What is on disk at the lock path. */
type LockState =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "held"; readonly record: LockRecord };

/** The default for {@link AuthLockOptions.staleMs}; exported so the capture time budgets can be checked against it. */
export const DEFAULT_STALE_MS = 360_000;
const DEFAULT_WAIT_MS = 360_000;
const DEFAULT_POLL_MS = 250;
const REAP_STALE_MS = 10_000;
const RELEASE_ATTEMPTS = 5;
const RELEASE_RETRY_MS = 20;

/** errno values Windows reports, instead of EEXIST, while another process has the file open or pending delete. */
const WINDOWS_BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * How many consecutive attempts may fail with a Windows busy code before it is
 * taken for the real error it is. A lock file that is being deleted is free again
 * within moments; a permission problem on the directory reports the same codes
 * and never clears, and would otherwise be waited out for the whole timeout and
 * then blamed on another RAVEN process.
 */
const WINDOWS_BUSY_GRACE_ATTEMPTS = 20;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** Whether an exclusive create failed with a code Windows uses for a file that is momentarily unavailable. */
function isWindowsBusy(err: unknown): boolean {
  const code = errnoCode(err);
  return process.platform === "win32" && code !== undefined && WINDOWS_BUSY_CODES.has(code);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return errnoCode(err) === "EPERM";
  }
}

async function inspectLock(lockPath: string): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch (err) {
    return errnoCode(err) === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    const record = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof record.pid === "number" && typeof record.at === "number" && typeof record.token === "string") {
      return { kind: "held", record: record as LockRecord };
    }
  } catch {
    // Empty or caught mid-write by its owner; treated as unreadable below.
  }
  return { kind: "unreadable" };
}

/** Unlink `path`. True when it is gone afterwards (removed, or already missing); false when it could not be removed. */
async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    return errnoCode(err) === "ENOENT";
  }
}

/**
 * Remove the lock if it is abandoned: its owner died, or it is older than
 * `staleMs` (which also covers a recycled pid). A readable record is re-read
 * and compared by token just before unlinking so a lock that changed hands in
 * the meantime is left alone; an empty or partial record is judged by the age
 * of the file instead. Returns true only if the lock is gone afterwards;
 * a lock that is judged stale but cannot be unlinked reports false so the
 * caller keeps waiting (and honours its deadline) instead of retrying in a
 * tight loop. Callers must hold the reclaim lease (see {@link clearIfStale});
 * without it, check-then-unlink is not atomic.
 */
async function removeIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const seen = await inspectLock(lockPath);
  if (seen.kind === "missing") return false;
  if (seen.kind === "unreadable") {
    // Empty or partial: either an owner mid-write (fresh) or one that died
    // between creating the file and writing its record (old). Go by mtime.
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs <= staleMs) return false;
    } catch {
      return false;
    }
    return removeFile(lockPath);
  }

  const { record } = seen;
  if (pidAlive(record.pid) && Date.now() - record.at <= staleMs) return false;

  const current = await inspectLock(lockPath);
  if (current.kind !== "held" || current.record.token !== record.token) return false;
  return removeFile(lockPath);
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
 * millisecond section.) Any trouble taking, writing or releasing the lease
 * simply means "not reclaimed this round": the caller keeps waiting.
 */
async function clearIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  const leasePath = `${lockPath}.reap`;
  let lease;
  try {
    lease = await open(leasePath, "wx", 0o600);
  } catch (err) {
    if (errnoCode(err) === "EEXIST") {
      try {
        if (Date.now() - (await stat(leasePath)).mtimeMs > REAP_STALE_MS) await unlink(leasePath);
      } catch {
        // Released or replaced while we looked; the next poll sorts it out.
      }
    }
    return false;
  }

  try {
    await lease.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    await lease.close();
  } catch {
    await lease.close().catch(() => {});
    await removeFile(leasePath);
    return false;
  }
  try {
    return await removeIfStale(lockPath, staleMs);
  } finally {
    await removeFile(leasePath);
  }
}

/**
 * Remove our own lock after the critical section. Only a lock that still
 * carries our token is removed (it may have been judged stale and taken over).
 * A transient failure to read or unlink is retried briefly; if the lock still
 * cannot be removed it is left for the stale rules to recover, because a
 * failed release must not turn a successful login into an error.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    const state = await inspectLock(lockPath);
    if (state.kind === "missing") return;
    if (state.kind === "held") {
      if (state.record.token !== token) return;
      if (await removeFile(lockPath)) return;
    }
    await sleep(RELEASE_RETRY_MS * (attempt + 1));
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
  let announcedWait = false;
  let busyStreak = 0;

  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (err) {
      // EEXIST: somebody holds the lock, so wait. A Windows busy code is waited
      // out too, but only briefly (see WINDOWS_BUSY_GRACE_ATTEMPTS); anything
      // else is a real error.
      const held = errnoCode(err) === "EEXIST";
      if (held) busyStreak = 0;
      else if (!isWindowsBusy(err) || (busyStreak += 1) > WINDOWS_BUSY_GRACE_ATTEMPTS) throw err;
      // A reclaimed lock means the next open can win straight away; anything
      // else falls through to the deadline check and a sleep, so a lock that
      // cannot be removed never becomes a busy loop.
      if (held && (await clearIfStale(lockPath, staleMs)) && Date.now() < deadline) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for another RAVEN process to finish logging in. " +
            `If none is running, delete ${lockPath} and try again.`
        );
      }
      if (held && !announcedWait) {
        announcedWait = true;
        try {
          // The callback may be async: its rejection must not escape unhandled.
          void Promise.resolve(options.onWait?.()).catch(() => {});
        } catch {
          // A failing notice must never break the wait.
        }
      }
      await sleep(pollMs);
      continue;
    }

    try {
      const record: LockRecord = { pid: process.pid, at: Date.now(), token };
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
    } catch (err) {
      // We created the file but could not record ourselves in it. An empty
      // lock is judged only by its age, so leaving it would block every other
      // process for the full stale limit although nobody is logging in.
      await handle.close().catch(() => {});
      await removeFile(lockPath);
      throw err;
    }
    break;
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
