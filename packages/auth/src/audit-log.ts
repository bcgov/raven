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
  renameSync,
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
 * original order, undefined properties dropped, and toJSON() honoured
 * (JSON.stringify semantics).
 *
 * Key order is `Object.keys(value).sort()` — plain string / UTF-16 code-point
 * order. This is NOT the order JavaScript itself uses for integer-like own
 * keys (which it iterates numerically first); a re-implementation in another
 * language must sort keys as strings, not as numbers, to reproduce the same
 * output and therefore the same hash.
 *
 * Throws on `undefined` (the return type is `string`, and
 * `JSON.stringify(undefined)` is not one). Also throws on a circular
 * reference or a `BigInt` anywhere in `value`, same as `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("canonicalJson: cannot canonicalise undefined");
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value && typeof value === "object" && typeof (value as any).toJSON === "function") {
    // Call toJSON() first, like JSON.stringify does — this must be checked
    // before Array.isArray so an array subclass with its own toJSON() is
    // canonicalised the same way JSON.stringify would serialise it.
    return sortKeys((value as any).toJSON());
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    // Object.create(null): an own "__proto__" key on `value` must be
    // canonicalised as ordinary data, not reinterpreted as a prototype
    // assignment on `out`.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
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
 * Release a lock file iff its content still equals `token`. If it does not
 * (a waiter reclaimed it as stale and holds it now), the lock is left
 * alone — unlinking it here would delete someone else's live lock.
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

/**
 * Exclusive lock via atomic create of `<file>.lock`, tagged with a random
 * token so only the current holder can release it. A lock older than
 * LOCK_STALE_MS is treated as abandoned (crashed process) and reclaimed by
 * a waiter; the original holder's eventual release then finds a token that
 * is no longer its own and leaves the reclaimed lock alone (see
 * releaseLock). This still allows two writers to overlap if one single
 * append takes longer than LOCK_STALE_MS to complete — a `verify()` pass
 * over the chain detects the resulting break.
 *
 * Stale reclaim uses rename-then-unlink rather than a plain unlink:
 * `renameSync` is atomic, so of several waiters that all see the same stale
 * lock, only one's rename can succeed — the rest get ENOENT (the source is
 * already gone) and simply retry. A plain stat-then-unlink would let two
 * waiters both decide the lock is stale, and the second unlink would then
 * delete the fresh lock the first waiter had just created.
 */
async function withFileLock<R>(file: string, fn: () => R): Promise<R> {
  const lock = file + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const reclaimed = `${lock}.stale-${token}`;
          try {
            renameSync(lock, reclaimed);
            unlinkSync(reclaimed);
          } catch {
            /* another waiter reclaimed it first, or it is already gone */
          }
        }
      } catch {
        /* lock vanished before the stat — loop and retry */
      }
      if (Date.now() > deadline) throw new Error(`Audit log lock timeout: ${lock}`);
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
      const lines = splitAuditLines(buf.toString("utf-8"));
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
  return { file, records: lines.length, ok: true };
}

/**
 * Append-only, hash-chained audit log. One JSONL file per calendar month
 * (`${dir}/${stream}.${YYYY-MM}.jsonl`); each line's `hash` binds it to the
 * previous line's `hash`, so an edit, deletion, reorder, or truncation is
 * detectable by {@link verifyAuditFile} / {@link AuditLog.verify}.
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

  constructor(opts: AuditLogOptions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.stream)) {
      throw new Error(`Invalid audit stream "${opts.stream}"`);
    }
    this.stream = opts.stream;
    this.dir = opts.dir ?? join(homedir(), ".raven", "audit");
    this.clock = opts.clock ?? (() => new Date());
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
    return withFileLock(file, () => {
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
