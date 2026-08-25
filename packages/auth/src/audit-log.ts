import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** prevHash of the first record in every audit file. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in their
 * original order, undefined / function / symbol properties dropped, and
 * `toJSON(key)` honoured with JSON.stringify's key semantics (`""` at the
 * root, the property name inside an object, the index as a string inside
 * an array).
 *
 * Keys are emitted in plain string (UTF-16 code unit) order, so
 * `{ "10": 1, "2": 2 }` becomes `{"10":1,"2":2}`. This deliberately differs
 * from JavaScript's own enumeration order (integer-like keys first,
 * ascending numerically): the serialiser builds the string itself instead
 * of handing a sorted copy to `JSON.stringify`, which would re-impose the
 * numeric order. A re-implementation in another language must sort keys as
 * strings, not as numbers, to reproduce the same output and hash.
 *
 * Throws on `undefined` at the root (the return type is `string`), and on a
 * circular reference or a `BigInt` anywhere in `value`, same as
 * `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  const out = canon(value, "", []);
  if (out === undefined) throw new Error("canonicalJson: cannot canonicalise undefined");
  return out;
}

function canon(value: unknown, key: string, ancestors: object[]): string | undefined {
  if (value && typeof value === "object" && typeof (value as any).toJSON === "function") {
    // Checked before Array.isArray so an array subclass with its own toJSON()
    // is canonicalised the way JSON.stringify would serialise it.
    value = (value as { toJSON(k: string): unknown }).toJSON(key);
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    value = value.valueOf();
  }
  if (typeof value === "bigint") throw new TypeError("canonicalJson: cannot serialise a BigInt");
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (ancestors.includes(value)) throw new TypeError("canonicalJson: converting circular structure to JSON");
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((v, i) => canon(v, String(i), ancestors) ?? "null").join(",") + "]";
    }
    // Object.keys() already excludes symbols and non-enumerable properties;
    // an own "__proto__" key is ordinary data here, never a prototype write.
    const parts: string[] = [];
    for (const k of Object.keys(value).sort()) {
      const item = canon((value as Record<string, unknown>)[k], k, ancestors);
      if (item !== undefined) parts.push(JSON.stringify(k) + ":" + item);
    }
    return "{" + parts.join(",") + "}";
  } finally {
    ancestors.pop();
  }
}

/** Chain hash: sha256(prevHash + "\n" + canonicalJson(record)). `record` must not contain `hash`. */
export function hashRecord(prevHash: string, recordWithoutHash: object): string {
  return createHash("sha256")
    .update(prevHash + "\n" + canonicalJson(recordWithoutHash))
    .digest("hex");
}

/** Time-sortable id: base-36 milliseconds, "-", 8 random hex characters. */
export function newAuditId(clock: () => Date = () => new Date()): string {
  return `${clock().getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface AuditLogOptions {
  /** File-name prefix, e.g. "db-mcp". */
  stream: string;
  /** Directory; default ~/.raven/audit. */
  dir?: string;
  /** Injectable clock for tests. */
  clock?: () => Date;
  /** How long `append()` waits for a busy lock before failing; default 5 s. */
  lockTimeoutMs?: number;
}

export type AuditRecord<T extends object = Record<string, unknown>> = T & {
  ts: string;
  id: string;
  prevHash: string;
  hash: string;
};

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const TAIL_READ_BYTES = 64 * 1024;

/** Audit files for a stream, ascending by month. [] when the dir is missing. */
export function listAuditFiles(dir: string, stream: string): string[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${stream.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}\\.jsonl$`);
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => resolve(dir, f));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Split file content into non-blank lines, dropping whitespace-only lines. */
function splitAuditLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

/** Read `file` and return its non-blank lines. */
function readAuditLines(file: string): string[] {
  return splitAuditLines(readFileSync(file, "utf-8"));
}

/**
 * Release a lock file iff its content still equals `token`. A live holder's
 * lock is never reclaimed by anyone else (see withFileLock), so in normal
 * operation the content is always ours; the check guards against an
 * operator deleting and some other process recreating the file meanwhile.
 *
 * @internal — exported for tests only.
 */
export function releaseLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, "utf-8") === token) unlinkSync(lock);
  } catch {
    /* already gone, or unreadable — nothing this holder can do */
  }
}

const TOKEN_RE = /^(\d+)-[0-9a-f]{16}$/;

/** Owner pid encoded in a lock token (`<pid>-<16 hex>`); null if malformed. */
function lockOwnerPid(content: string): number | null {
  const m = TOKEN_RE.exec(content);
  return m ? Number(m[1]) : null;
}

/** True when a process with this pid exists. EPERM means it exists but is not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Decide whether a lock (or reclaim-guard) file is abandoned. A file whose
 * token names a live process is never abandoned, however old it is — a
 * holder that is merely slow or suspended keeps its lock, and waiters time
 * out naming its pid instead of overlapping with it. A file whose token
 * names a dead process is abandoned. A file with no valid token (the holder
 * crashed between create and write) is abandoned once it is older than
 * LOCK_STALE_MS. Returns the content observed, so the caller can make its
 * unlink conditional on that exact content; null when not abandoned or
 * already gone.
 */
function abandonedLockContent(path: string): string | null {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(path, "utf-8");
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null; // vanished — the caller loops and retries
  }
  const pid = lockOwnerPid(content);
  if (pid !== null) return pidAlive(pid) ? null : content;
  return Date.now() - mtimeMs > LOCK_STALE_MS ? content : null;
}

/**
 * Remove an abandoned lock, serialised through a reclaim guard
 * (`<lock>.reclaim`, created with O_EXCL). Only the guard holder may unlink
 * a lock, and it unlinks only if the lock still holds the exact content it
 * judged abandoned. Together these close the two-waiter race: without the
 * guard, waiter B could read the dead token, then waiter A unlinks it and
 * creates a fresh lock, and B's unlink would delete A's live lock. With the
 * guard, A cannot unlink while B holds it, and B's content check sees A's
 * fresh token (tokens are random, so a new lock never repeats a dead one).
 *
 * The guard can itself be abandoned only if a reclaimer dies inside this
 * function — a window of microseconds — and is then cleared by the same
 * liveness rule; a second death inside *that* window is not guarded.
 */
function reclaimAbandonedLock(lock: string, guard: string, observed: string, token: string): void {
  let gfd: number;
  try {
    gfd = openSync(guard, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const staleGuard = abandonedLockContent(guard);
    if (staleGuard !== null) releaseLock(guard, staleGuard);
    return; // another waiter is reclaiming — retry after the sleep
  }
  try {
    writeSync(gfd, token);
  } catch (err) {
    closeSync(gfd);
    try {
      unlinkSync(guard);
    } catch {
      /* best effort — do not mask the original error */
    }
    throw err;
  }
  closeSync(gfd);
  try {
    // While the guard is held nobody else unlinks the lock, and while the
    // lock path exists nobody can create at it (O_EXCL), so a content match
    // here means the same dead holder's file — unlinking it is safe.
    releaseLock(lock, observed);
  } finally {
    releaseLock(guard, token);
  }
}

/**
 * Exclusive lock via atomic create of `<file>.lock`, tagged with
 * `<pid>-<random>` so only the current holder can release it. A lock whose
 * owner is still alive is never reclaimed, however old — the holder may
 * just be suspended — so two live writers can never both hold the lock.
 * A lock whose owner has died (or that carries no valid token and is older
 * than LOCK_STALE_MS) is reclaimed under a reclaim guard; see
 * reclaimAbandonedLock for why that is race-free. Waiters give up after
 * `timeoutMs` with an error naming the owner pid, so an operator can decide
 * whether that process is really gone and delete the file by hand.
 *
 * Liveness is checked with `process.kill(pid, 0)`, which only means
 * something for processes on this machine: the audit directory must be on
 * a local filesystem. A dead holder's pid that the OS has already reused
 * keeps the lock "alive" until the operator removes it — the timeout error
 * says which pid to check.
 */
async function withFileLock<R>(file: string, timeoutMs: number, fn: () => R): Promise<R> {
  const lock = file + ".lock";
  const guard = lock + ".reclaim";
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const abandoned = abandonedLockContent(lock);
      if (abandoned !== null) reclaimAbandonedLock(lock, guard, abandoned, token);
      if (Date.now() > deadline) {
        let owner = "an unknown process";
        try {
          const pid = lockOwnerPid(readFileSync(lock, "utf-8"));
          if (pid !== null) owner = `pid ${pid}`;
        } catch {
          /* lock vanished at the last moment — report it generically */
        }
        throw new Error(
          `Audit log lock timeout: ${lock} is held by ${owner}. If that process is gone, delete the lock file and retry.`
        );
      }
      await sleep(10);
      continue;
    }
    // We created the lock file; a failure writing our token must not leave
    // an empty, ownerless lock behind to wedge the log for LOCK_STALE_MS.
    try {
      writeSync(fd, token);
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        /* best effort — do not mask the original error */
      }
      throw err;
    }
    closeSync(fd);
    break;
  }
  try {
    return fn();
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * Hash of the last record in `file`, or null for a missing/empty file.
 * Throws on a corrupt or partial tail (fail closed — a broken chain must not
 * silently restart from GENESIS_HASH).
 *
 * Reads backwards in growing windows (starting at TAIL_READ_BYTES, doubling
 * each retry) until the window contains a `\n` before the start of the last
 * non-empty line — proof the line is bounded by a real newline in the file,
 * not truncated at the window's edge — or the window reaches the start of
 * the file. This keeps a single large record (e.g. a big payload) from
 * being misread as a corrupt fragment. A window that is entirely blank (e.g.
 * a run of bare `\n` padding after hand-editing) does NOT mean the file is
 * empty — only a window that reaches byte 0 proves that — so a blank window
 * also widens and retries instead of returning null.
 */
function readLastHash(file: string): string | null {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  if (size === 0) return null;
  const fd = openSync(file, "r");
  try {
    let windowBytes = TAIL_READ_BYTES;
    for (;;) {
      const start = Math.max(0, size - windowBytes);
      const buf = Buffer.alloc(size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      if (n !== buf.length) {
        throw new Error(`Audit log ${file}: short read (${n} of ${buf.length} bytes) while checking the tail.`);
      }
      const text = buf.toString("utf-8");
      const lines = splitAuditLines(text);
      const last = lines[lines.length - 1];
      if (last === undefined) {
        if (start === 0) return null;
        windowBytes *= 2;
        continue;
      }
      const capturedFullLastLine = lines.length > 1 || start === 0;
      if (!capturedFullLastLine) {
        windowBytes *= 2;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(last);
      } catch {
        throw new Error(
          `Audit log ${file} ends with a corrupt or partial last line; refusing to append so the chain cannot silently restart. Inspect the file and remove the trailing partial line by hand — the break stays visible to verify().`
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`Audit log ${file} last record has no valid hash; refusing to append.`);
      }
      const hash = (parsed as { hash?: unknown }).hash;
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`Audit log ${file} last record has no valid hash; refusing to append.`);
      }
      // A torn write can leave a complete record with no trailing newline;
      // the next O_APPEND would glue the next record onto that line, which
      // is permanent corruption. Whitespace after a newline-terminated line
      // is fine; a last record not followed by "\n" is not.
      const trailing = /\S(\s*)$/.exec(text)?.[1] ?? "";
      if (!trailing.includes("\n")) {
        throw new Error(
          `Audit log ${file} ends with an unterminated last line (no trailing newline); refusing to append so the next record cannot be glued onto it. Confirm the line is complete, add the newline by hand, and retry — the chain stays verifiable.`
        );
      }
      return hash;
    }
  } finally {
    closeSync(fd);
  }
}

export interface AuditVerifyResult {
  file: string;
  records: number;
  ok: boolean;
  /** 1-based line number of the first record that fails the chain. */
  firstBreak?: number;
  /**
   * `hash` of the last record when the chain verifies and the file is not
   * empty. A local chain cannot detect removal of its newest records, so
   * note this value somewhere outside the audit directory if that matters.
   */
  headHash?: string;
}

export interface AuditTailResult<T extends object> {
  records: AuditRecord<T>[];
  chainOk: boolean;
  breaks: { file: string; line: number }[];
}

/**
 * Recompute the chain of one file. Pure; safe to call on a live file.
 * Reads the whole file into memory — fine for the append-only, roughly
 * one-record-per-call monthly files this library produces; not intended
 * for arbitrarily large files.
 */
export function verifyAuditFile(file: string): AuditVerifyResult {
  const lines = readAuditLines(file);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let rec: unknown;
    try {
      rec = JSON.parse(lines[i]!);
    } catch {
      return { file, records: lines.length, ok: false, firstBreak: i + 1 };
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      return { file, records: lines.length, ok: false, firstBreak: i + 1 };
    }
    const recObj = rec as Record<string, unknown>;
    const { hash, ...withoutHash } = recObj;
    if (recObj["prevHash"] !== prevHash || hashRecord(prevHash, withoutHash) !== hash) {
      return { file, records: lines.length, ok: false, firstBreak: i + 1 };
    }
    prevHash = hash as string;
  }
  return lines.length === 0
    ? { file, records: 0, ok: true }
    : { file, records: lines.length, ok: true, headHash: prevHash };
}

/**
 * Append-only, hash-chained audit log. One JSONL file per calendar month
 * (`${dir}/${stream}.${YYYY-MM}.jsonl`); each line's `hash` binds it to the
 * previous line's `hash`.
 *
 * What the chain guarantees: {@link verifyAuditFile} / {@link AuditLog.verify}
 * detect any edit, insertion, reordering, or deletion of a record that has
 * a later record after it. What it cannot guarantee: removal of the newest
 * record(s) — a cut at the tail leaves every remaining link valid — and
 * deletion of a whole monthly file, because each file starts from
 * GENESIS_HASH. Detecting those needs a reference kept outside the audit
 * directory: note the `headHash` and `records` that `verify()` reports, and
 * the list of monthly files, somewhere the writer cannot reach.
 *
 * Recovery: the library never truncates, deletes, or rewrites an audit
 * file — a corrupt or partial trailing line makes `append()` fail closed
 * instead of silently restarting the chain. Recover by hand: inspect the
 * file and remove the trailing partial line; the break it left stays
 * visible to `verify()`.
 *
 * Durability: `append()` fsyncs the file after every write, but on macOS
 * that is a plain `fsync`, not `F_FULLFSYNC` — the drive's own write cache
 * is not flushed. The directory entry for a newly created monthly file is
 * not fsynced either. Both are adequate for a workstation-scale audit
 * trail, not a guarantee against power loss.
 *
 * Permissions: the directory is created/tightened to `0o700` and each file
 * to `0o600`. Both are best-effort and are skipped on Windows (`win32`),
 * which does not support POSIX file modes.
 */
export class AuditLog<T extends object = Record<string, unknown>> {
  readonly dir: string;
  readonly stream: string;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;

  constructor(opts: AuditLogOptions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.stream)) {
      throw new Error(`Invalid audit stream "${opts.stream}"`);
    }
    this.stream = opts.stream;
    this.dir = opts.dir ?? join(homedir(), ".raven", "audit");
    this.clock = opts.clock ?? (() => new Date());
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  /** `${dir}/${stream}.${YYYY-MM}.jsonl` for the given date (UTC month). */
  fileFor(date: Date): string {
    const month = date.toISOString().slice(0, 7);
    return join(this.dir, `${this.stream}.${month}.jsonl`);
  }

  /**
   * Append one record. Adds ts/id when absent, chains prevHash/hash, writes a
   * single line with O_APPEND under a lock, and fsyncs. Rejects on any
   * failure — callers must treat a rejected append as "not audited".
   *
   * `hash` and `prevHash` are log-owned: any caller-supplied `hash` or
   * `prevHash` on `record` is discarded before chaining. Without this, a
   * poisoned `hash`/`prevHash` field would be hashed into the record and
   * then overwritten in the persisted line, leaving a line that can never
   * re-verify against its own hash.
   *
   * `ts` is captured before the lock is acquired, so under contention two
   * writers' `ts` values can be out of order relative to where their
   * records land in the chain. Chain order (`prevHash`/`hash`, i.e. file
   * position) is authoritative — do not rely on `ts` for true sequence.
   */
  async append(record: T & { id?: string; ts?: string }): Promise<AuditRecord<T>> {
    const now = this.clock();
    const file = this.fileFor(now);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (statSync(this.dir).mode & 0o077) !== 0) {
      chmodSync(this.dir, 0o700);
    }
    return withFileLock(file, this.lockTimeoutMs, () => {
      const prevHash = readLastHash(file) ?? GENESIS_HASH;
      const { id, ts, hash: _hash, prevHash: _prevHash, ...rest } = record as Record<string, unknown>;
      const base = {
        ts: (ts as string | undefined) ?? now.toISOString(),
        id: (id as string | undefined) ?? newAuditId(() => now),
        ...rest,
        prevHash,
      };
      const hash = hashRecord(prevHash, base);
      const full = { ...base, hash } as AuditRecord<T>;
      const buf = Buffer.from(JSON.stringify(full) + "\n");
      const fd = openSync(file, "a", 0o600);
      try {
        if (process.platform !== "win32" && (fstatSync(fd).mode & 0o077) !== 0) {
          fchmodSync(fd, 0o600);
        }
        const n = writeSync(fd, buf);
        if (n !== buf.length) {
          throw new Error(`Audit log short write: ${n} of ${buf.length} bytes to ${file}`);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return full;
    });
  }

  /** Verify one file, or every file of this stream (ascending by month). */
  async verify(file?: string): Promise<AuditVerifyResult[]> {
    const files = file ? [file] : listAuditFiles(this.dir, this.stream);
    return files.map(verifyAuditFile);
  }

  /**
   * Most recent records, newest first. Reads newest monthly file backwards
   * until `limit` is met.
   *
   * `chainOk`/`breaks` cover only the files this call actually reads — it
   * stops as soon as `limit` records are collected, so a break in an older,
   * unread file is not reported. When `chainOk` is false, treat `records`
   * as unverified: a tampered-but-still-parsable line is returned like any
   * other record, so check `chainOk`/`breaks` before trusting its content.
   */
  async tail(opts: { limit?: number; filter?: (r: AuditRecord<T>) => boolean } = {}): Promise<AuditTailResult<T>> {
    const limit = Math.max(1, opts.limit ?? 20);
    const filter = opts.filter ?? (() => true);
    const files = listAuditFiles(this.dir, this.stream).reverse();
    const records: AuditRecord<T>[] = [];
    const breaks: { file: string; line: number }[] = [];
    for (const file of files) {
      const v = verifyAuditFile(file);
      if (!v.ok && v.firstBreak !== undefined) breaks.push({ file, line: v.firstBreak });
      const lines = readAuditLines(file);
      for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
        let rec: AuditRecord<T>;
        try {
          rec = JSON.parse(lines[i]!) as AuditRecord<T>;
        } catch {
          continue; // reported via breaks
        }
        if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
          continue; // reported via breaks
        }
        if (filter(rec)) records.push(rec);
      }
      if (records.length >= limit) break;
    }
    return { records, chainOk: breaks.length === 0, breaks };
  }
}
