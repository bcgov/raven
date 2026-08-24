import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
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
const LOCK_STALE_MS = 5_000;
const TAIL_READ_BYTES = 64 * 1024;

/** Audit files for a stream, ascending by month. [] when the dir is missing. */
export function listAuditFiles(dir: string, stream: string): string[] {
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${stream.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{4}-\\d{2}\\.jsonl$`);
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => join(dir, f));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exclusive lock via atomic create of `<file>.lock`. A lock older than
 * LOCK_STALE_MS is treated as abandoned (crashed process) and removed.
 */
async function withFileLock<R>(file: string, fn: () => R): Promise<R> {
  const lock = file + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      closeSync(fd);
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
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** Hash of the last record in `file`, or null for a missing/empty file. Throws on a corrupt tail. */
function readLastHash(file: string): string | null {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  if (size === 0) return null;
  const fd = openSync(file, "r");
  try {
    const start = Math.max(0, size - TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1];
    if (last === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(last);
    } catch {
      throw new Error(`Audit log ${file} has a corrupt last line; refusing to append (chain broken).`);
    }
    const hash = (parsed as { hash?: unknown }).hash;
    if (typeof hash !== "string" || hash.length !== 64) {
      throw new Error(`Audit log ${file} last record has no valid hash; refusing to append.`);
    }
    return hash;
  } finally {
    closeSync(fd);
  }
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
   */
  async append(record: T & { id?: string; ts?: string }): Promise<AuditRecord<T>> {
    const now = this.clock();
    const file = this.fileFor(now);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return withFileLock(file, () => {
      const prevHash = readLastHash(file) ?? GENESIS_HASH;
      const { id, ts, ...rest } = record;
      const base = {
        ts: ts ?? now.toISOString(),
        id: id ?? newAuditId(this.clock),
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
}
