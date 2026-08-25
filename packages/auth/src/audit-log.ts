import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
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
 * Deterministic JSON: object keys sorted recursively, arrays in order,
 * undefined properties dropped, and toJSON() honoured (JSON.stringify semantics).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    // Call toJSON() if it exists, like JSON.stringify does
    if (typeof (value as any).toJSON === "function") {
      return sortKeys((value as any).toJSON());
    }
    const out: Record<string, unknown> = {};
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

/**
 * Release a lock file iff its content still equals `token`. If it does not
 * (a waiter reclaimed it as stale and holds it now), the lock is left
 * alone — unlinking it here would delete someone else's live lock.
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
 */
async function withFileLock<R>(file: string, fn: () => R): Promise<R> {
  const lock = file + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        /* lock vanished between stat and unlink — loop and retry */
      }
      if (Date.now() > deadline) throw new Error(`Audit log lock timeout: ${lock}`);
      await sleep(10);
    }
  }
  try {
    return fn();
  } finally {
    releaseLock(lock, token);
  }
}

/**
 * Hash of the last record in `file`, or null for a missing/empty file.
 * Throws on a corrupt tail (fail closed — a broken chain must not silently
 * restart from GENESIS_HASH).
 *
 * Reads backwards in growing windows (starting at TAIL_READ_BYTES, doubling
 * each retry) until the window contains a `\n` before the start of the last
 * non-empty line — proof the line is bounded by a real newline in the file,
 * not truncated at the window's edge — or the window reaches the start of
 * the file. This keeps a single large record (e.g. a big payload) from
 * being misread as a corrupt fragment.
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
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim() !== "");
      const last = lines[lines.length - 1];
      if (last === undefined) return null;
      const capturedFullLastLine = lines.length > 1 || start === 0;
      if (!capturedFullLastLine) {
        windowBytes *= 2;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(last);
      } catch {
        throw new Error(`Audit log ${file} has a corrupt last line; refusing to append (chain broken).`);
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

/** Recompute the chain of one file. Pure; safe to call on a live file. */
export function verifyAuditFile(file: string): AuditVerifyResult {
  const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() !== "");
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
   */
  async append(record: T & { id?: string; ts?: string }): Promise<AuditRecord<T>> {
    const now = this.clock();
    const file = this.fileFor(now);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(file, () => {
      const prevHash = readLastHash(file) ?? GENESIS_HASH;
      const { id, ts, hash: _hash, prevHash: _prevHash, ...rest } = record as Record<string, unknown>;
      const base = {
        ts: (ts as string | undefined) ?? now.toISOString(),
        id: (id as string | undefined) ?? newAuditId(this.clock),
        ...rest,
        prevHash,
      };
      const hash = hashRecord(prevHash, base);
      const full = { ...base, hash } as AuditRecord<T>;
      const fd = openSync(file, "a", 0o600);
      try {
        writeSync(fd, JSON.stringify(full) + "\n");
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
}
