import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  GENESIS_HASH,
  canonicalJson,
  hashRecord,
  newAuditId,
  AuditLog,
  listAuditFiles,
  releaseLock,
  verifyAuditFile,
} from "../audit-log.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    const out = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    expect(out).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("drops undefined properties like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: "x" })).toBe('{"b":"x"}');
  });

  it("honours toJSON() on Date and Buffer", () => {
    const result = canonicalJson({
      t: new Date("2026-08-24T00:00:00Z"),
      b: Buffer.from("hi"),
    });
    // Buffer.toJSON() produces {type: "Buffer", data: [...]}, sorted keys give data, then type
    expect(result).toBe(
      '{"b":{"data":[104,105],"type":"Buffer"},"t":"2026-08-24T00:00:00.000Z"}'
    );
  });

  it("canonicalises an own __proto__ key as data instead of reassigning the prototype", () => {
    const out = canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":1}'));
    expect(out).toBe('{"__proto__":{"x":1},"a":1}');
  });

  it("sorts integer-like keys as strings, not numerically", () => {
    // JSON.stringify would emit {"2":2,"10":1} for this object whatever the
    // insertion order; the documented (and hashed) form is string order.
    expect(canonicalJson({ "10": 1, "2": 2 })).toBe('{"10":1,"2":2}');
    expect(canonicalJson({ a: { "3": [], "10": 0, "-1": 1 } })).toBe('{"a":{"-1":1,"10":0,"3":[]}}');
  });

  it("passes the property key / array index / root key to toJSON like JSON.stringify", () => {
    const keyed = { toJSON: (k: string) => `key=${k}` };
    const value = { p: keyed, arr: [keyed, keyed] };
    expect(canonicalJson(value)).toBe(JSON.stringify(value, Object.keys(value).sort()));
    expect(canonicalJson(value)).toBe('{"arr":["key=0","key=1"],"p":"key=p"}');
    expect(canonicalJson(keyed)).toBe('"key="');
  });

  it("throws on a circular reference and on BigInt, like JSON.stringify", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop["self"] = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
    expect(() => canonicalJson({ n: 1n })).toThrow(/BigInt/);
  });

  it("unwraps primitive wrapper objects and drops functions like JSON.stringify", () => {
    expect(canonicalJson({ n: new Number(3), s: new String("x"), f: () => 1, b: new Boolean(false) })).toBe(
      '{"b":false,"n":3,"s":"x"}'
    );
  });

  it("throws for undefined", () => {
    expect(() => canonicalJson(undefined)).toThrow(
      "canonicalJson: cannot canonicalise undefined"
    );
  });
});

describe("hashRecord", () => {
  it("is sha256(prevHash + newline + canonical json)", () => {
    const rec = { z: 1, a: "two" };
    const expected = createHash("sha256")
      .update(GENESIS_HASH + "\n" + '{"a":"two","z":1}')
      .digest("hex");
    expect(hashRecord(GENESIS_HASH, rec)).toBe(expected);
  });

  it("ignores key order", () => {
    expect(hashRecord("x", { a: 1, b: 2 })).toBe(hashRecord("x", { b: 2, a: 1 }));
  });

  it("changes when prevHash changes", () => {
    expect(hashRecord("a", { k: 1 })).not.toBe(hashRecord("b", { k: 1 }));
  });
});

describe("newAuditId", () => {
  it("is base36 milliseconds, a dash, and 8 hex characters", () => {
    const clock = () => new Date(1_700_000_000_000);
    const id = newAuditId(clock);
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
    expect(id.split("-")[0]).toBe((1_700_000_000_000).toString(36));
  });

  it("is unique across calls with the same clock", () => {
    const clock = () => new Date(1_700_000_000_000);
    expect(newAuditId(clock)).not.toBe(newAuditId(clock));
  });

  it("sorts by time", () => {
    const a = newAuditId(() => new Date(1_700_000_000_000));
    const b = newAuditId(() => new Date(1_700_000_000_001));
    expect(a < b).toBe(true);
  });
});

let tmp: string | undefined;
function tmpDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "raven-audit-"));
  return tmp;
}
afterEach(() => {
  if (tmp) {
    try { chmodSync(tmp, 0o700); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});
const AUG = () => new Date("2026-08-24T18:02:11.412Z");
const SEP = () => new Date("2026-09-01T00:00:00.000Z");

function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("AuditLog constructor", () => {
  it.each(["../x", "", "-a", "A", "a b"])("rejects an invalid stream name %j", (stream) => {
    expect(() => new AuditLog({ stream, dir: tmpDir() })).toThrow();
  });

  it("accepts a valid stream name", () => {
    expect(() => new AuditLog({ stream: "db-mcp", dir: tmpDir() })).not.toThrow();
  });
});

describe("AuditLog.append", () => {
  it("writes one JSON line with ts, id, prevHash and hash", async () => {
    const dir = join(tmpDir(), "audit");
    const log = new AuditLog<{ tool: string }>({ stream: "db-mcp", dir, clock: AUG });
    const rec = await log.append({ tool: "db_query" });
    expect(rec.ts).toBe("2026-08-24T18:02:11.412Z");
    expect(rec.id).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(rec.hash).toBe(hashRecord(GENESIS_HASH, { ts: rec.ts, id: rec.id, tool: "db_query", prevHash: GENESIS_HASH }));
    const file = log.fileFor(AUG());
    expect(file.endsWith("db-mcp.2026-08.jsonl")).toBe(true);
    expect(readLines(file)).toEqual([rec]);
  });

  it("chains the second record to the first", async () => {
    const log = new AuditLog({ stream: "s", dir: tmpDir(), clock: AUG });
    const a = await log.append({ n: 1 });
    const b = await log.append({ n: 2 });
    expect(b.prevHash).toBe(a.hash);
  });

  it("keeps a caller-supplied id and ts (two-phase records)", async () => {
    const log = new AuditLog({ stream: "s", dir: tmpDir(), clock: AUG });
    const a = await log.append({ id: "fixed-id", phase: "intent" });
    const b = await log.append({ id: "fixed-id", phase: "outcome" });
    expect(a.id).toBe("fixed-id");
    expect(b.id).toBe("fixed-id");
  });

  it("continues the chain from the file when a new instance opens it", async () => {
    const dir = tmpDir();
    const first = await new AuditLog({ stream: "s", dir, clock: AUG }).append({ n: 1 });
    const second = await new AuditLog({ stream: "s", dir, clock: AUG }).append({ n: 2 });
    expect(second.prevHash).toBe(first.hash);
  });

  it("starts a new chain in a new monthly file", async () => {
    const dir = tmpDir();
    await new AuditLog({ stream: "s", dir, clock: AUG }).append({ n: 1 });
    const sep = await new AuditLog({ stream: "s", dir, clock: SEP }).append({ n: 2 });
    expect(sep.prevHash).toBe(GENESIS_HASH);
    expect(listAuditFiles(dir, "s").map((f) => basename(f))).toEqual([
      "s.2026-08.jsonl",
      "s.2026-09.jsonl",
    ]);
  });

  it.skipIf(process.platform === "win32")("creates dir 0700 and file 0600", async () => {
    const dir = join(tmpDir(), "audit");
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(log.fileFor(AUG())).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects when the directory is not writable", async () => {
    const dir = tmpDir();
    chmodSync(dir, 0o500);
    const log = new AuditLog({ stream: "s", dir: join(dir, "audit"), clock: AUG });
    await expect(log.append({ n: 1 })).rejects.toThrow();
  });

  it("rejects when the last line of the file is corrupt", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(log.fileFor(AUG()), "{not json\n");
    await expect(log.append({ n: 2 })).rejects.toThrow(/corrupt|parse/i);
  });

  it("leaves no lock file behind", async () => {
    const log = new AuditLog({ stream: "s", dir: tmpDir(), clock: AUG });
    await log.append({ n: 1 });
    expect(existsSync(log.fileFor(AUG()) + ".lock")).toBe(false);
  });

  it("leaves no lock file behind after a failing append (corrupt last line)", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(log.fileFor(AUG()), "{not json\n");
    await expect(log.append({ n: 2 })).rejects.toThrow();
    expect(existsSync(log.fileFor(AUG()) + ".lock")).toBe(false);
  });

  it("ignores caller-supplied hash and prevHash fields", async () => {
    const log = new AuditLog({ stream: "s", dir: tmpDir(), clock: AUG });
    const rec = await log.append({ n: 1, hash: "bogus", prevHash: "bogus" });
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(rec.hash).toBe(
      hashRecord(GENESIS_HASH, { ts: rec.ts, id: rec.id, n: 1, prevHash: GENESIS_HASH })
    );
  });

  it("does not misdetect a large last record as corrupt", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const big = "x".repeat(100_000);
    const first = await log.append({ payload: big });
    const second = await log.append({ n: 2 });
    expect(second.prevHash).toBe(first.hash);
  });

  it("does not restart the chain when the tail window is entirely blank", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const first = await log.append({ n: 1 });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(log.fileFor(AUG()), "\n".repeat(70_000));
    const second = await log.append({ n: 2 });
    expect(second.prevHash).toBe(first.hash);
  });

  it("rejects a torn write and leaves the break visible to verify", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    const { appendFileSync } = await import("node:fs");
    const file = log.fileFor(AUG());
    appendFileSync(file, '{"half":');
    await expect(log.append({ n: 2 })).rejects.toThrow(/partial last line/);
    expect(verifyAuditFile(file)).toMatchObject({ records: 2, ok: false, firstBreak: 2 });
  });

  it("verifies a record whose nested toJSON depends on its key", async () => {
    // The hash is computed from the live object (toJSON(key) called by
    // canonicalJson) and the line is written by JSON.stringify (toJSON(key)
    // called by V8); both must agree or the record can never re-verify.
    const dir = tmpDir();
    const log = new AuditLog<{ payload: unknown }>({ stream: "s", dir, clock: AUG });
    await log.append({ payload: { inner: { toJSON: (k: string) => `seen:${k}` } } });
    const file = log.fileFor(AUG());
    expect(readLines(file)[0]).toMatchObject({ payload: { inner: "seen:inner" } });
    expect(verifyAuditFile(file)).toMatchObject({ records: 1, ok: true });
  });

  it("rejects a complete last record that lacks its trailing newline", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    const file = log.fileFor(AUG());
    const text = readFileSync(file, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    writeFileSync(file, text.slice(0, -1)); // torn write: JSON intact, newline lost
    await expect(log.append({ n: 2 })).rejects.toThrow(/unterminated last line/);
    expect(readFileSync(file, "utf-8")).toBe(text.slice(0, -1)); // nothing glued on
    expect(verifyAuditFile(file)).toMatchObject({ records: 1, ok: true });
  });

  it("still appends after whitespace that follows a terminated last line", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    const file = log.fileFor(AUG());
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, "  \n\r\n");
    const rec = await log.append({ n: 2 });
    expect(rec.prevHash).not.toBe(GENESIS_HASH);
    expect(verifyAuditFile(file)).toMatchObject({ records: 2, ok: true });
  });
});

describe("AuditLog lock reclamation", () => {
  /** A pid that certainly belonged to a process which has already exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ["-e", "0"]);
    expect(child.status).toBe(0);
    return child.pid!;
  }

  it("reclaims a lock whose owner process is dead, however fresh the file", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, `${deadPid()}-0123456789abcdef`);
    const rec = await log.append({ n: 1 });
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(lockPath + ".reclaim")).toBe(false);
  });

  it("reclaims a lock with no valid token once it is older than 30s", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, ""); // holder crashed between create and token write
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    const rec = await log.append({ n: 1 });
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(dir).some((f) => f.includes(".stale-") || f.endsWith(".reclaim"))).toBe(false);
  });

  it("never reclaims a lock whose owner is alive, and names the pid on timeout", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG, lockTimeoutMs: 100 });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, `${process.pid}-0123456789abcdef`); // a live process, but not this call
    const past = new Date(Date.now() - 600_000);
    utimesSync(lockPath, past, past); // ten minutes old — age alone must not make it stale
    await expect(log.append({ n: 1 })).rejects.toThrow(new RegExp(`held by pid ${process.pid}`));
    expect(existsSync(lockPath)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
  });

  it("waits while another live waiter holds the reclaim guard", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG, lockTimeoutMs: 100 });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, `${deadPid()}-0123456789abcdef`);
    writeFileSync(lockPath + ".reclaim", `${process.pid}-fedcba9876543210`); // live reclaimer mid-flight
    await expect(log.append({ n: 1 })).rejects.toThrow(/lock timeout/);
    expect(existsSync(lockPath)).toBe(true); // not touched without the guard
    expect(existsSync(lockPath + ".reclaim")).toBe(true);
  });

  it("clears a reclaim guard left behind by a dead reclaimer and proceeds", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, `${deadPid()}-0123456789abcdef`);
    writeFileSync(lockPath + ".reclaim", `${deadPid()}-fedcba9876543210`);
    const rec = await log.append({ n: 1 });
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(lockPath + ".reclaim")).toBe(false);
  });
});

describe("listAuditFiles", () => {
  it("returns [] when the directory does not exist", () => {
    expect(listAuditFiles(join(tmpDir(), "nope"), "s")).toEqual([]);
  });
});

describe("releaseLock", () => {
  it("does not unlink a lock whose content differs from the token", () => {
    const dir = tmpDir();
    const lock = join(dir, "example.lock");
    writeFileSync(lock, "foreign-token");
    releaseLock(lock, "my-token");
    expect(existsSync(lock)).toBe(true);
  });
});

describe("AuditLog.verify", () => {
  async function threeRecords() {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    for (const n of [1, 2, 3]) await log.append({ n });
    return { dir, log, file: log.fileFor(AUG()) };
  }

  it("reports the head hash of a verified non-empty file", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    await log.append({ n: 1 });
    const last = await log.append({ n: 2 });
    const [result] = await log.verify();
    expect(result).toMatchObject({ records: 2, ok: true, headHash: last.hash });
    const empty = join(dir, "s.2026-07.jsonl");
    writeFileSync(empty, "");
    expect(verifyAuditFile(empty)).toEqual({ file: empty, records: 0, ok: true });
  });

  it("reports ok for an untouched file", async () => {
    const { log } = await threeRecords();
    expect(await log.verify()).toMatchObject([{ file: log.fileFor(AUG()), records: 3, ok: true }]);
  });

  it("detects an edited line (1-based)", async () => {
    const { file } = await threeRecords();
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    lines[1] = lines[1].replace('"n":2', '"n":99');
    writeFileSync(file, lines.join("\n") + "\n");
    expect(verifyAuditFile(file)).toEqual({ file, records: 3, ok: false, firstBreak: 2 });
  });

  it("detects a deleted line", async () => {
    const { file } = await threeRecords();
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    lines.splice(1, 1);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(verifyAuditFile(file).firstBreak).toBe(2);
  });

  it("detects reordered lines", async () => {
    const { file } = await threeRecords();
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    [lines[1], lines[2]] = [lines[2], lines[1]];
    writeFileSync(file, lines.join("\n") + "\n");
    expect(verifyAuditFile(file).firstBreak).toBe(2);
  });

  it("detects a forged first record", async () => {
    const { file } = await threeRecords();
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const first = JSON.parse(lines[0]);
    first.prevHash = "1".repeat(64);
    first.hash = hashRecord(first.prevHash, { ...first, hash: undefined });
    lines[0] = JSON.stringify(first);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(verifyAuditFile(file).firstBreak).toBe(1);
  });

  it("treats an unparsable line as a break", async () => {
    const { file } = await threeRecords();
    writeFileSync(file, readFileSync(file, "utf-8") + "{oops\n");
    expect(verifyAuditFile(file)).toEqual({ file, records: 4, ok: false, firstBreak: 4 });
  });

  it("verifies every monthly file when no file is given", async () => {
    const dir = tmpDir();
    await new AuditLog({ stream: "s", dir, clock: AUG }).append({ n: 1 });
    await new AuditLog({ stream: "s", dir, clock: SEP }).append({ n: 2 });
    const results = await new AuditLog({ stream: "s", dir }).verify();
    expect(results.map((r) => [basename(r.file), r.ok])).toEqual([
      ["s.2026-08.jsonl", true],
      ["s.2026-09.jsonl", true],
    ]);
  });

  it("treats a null JSON line as a break", async () => {
    const { file } = await threeRecords();
    writeFileSync(file, readFileSync(file, "utf-8") + "null\n");
    expect(verifyAuditFile(file)).toEqual({ file, records: 4, ok: false, firstBreak: 4 });
  });

  it("treats an array JSON line as a break", async () => {
    const { file } = await threeRecords();
    writeFileSync(file, readFileSync(file, "utf-8") + "[1,2]\n");
    expect(verifyAuditFile(file)).toEqual({ file, records: 4, ok: false, firstBreak: 4 });
  });
});

describe("AuditLog.tail", () => {
  it("returns newest first, honours limit, and reports chainOk", async () => {
    const log = new AuditLog<{ n: number }>({ stream: "s", dir: tmpDir(), clock: AUG });
    for (const n of [1, 2, 3, 4, 5]) await log.append({ n });
    const out = await log.tail({ limit: 3 });
    expect(out.records.map((r) => r.n)).toEqual([5, 4, 3]);
    expect(out.chainOk).toBe(true);
    expect(out.breaks).toEqual([]);
  });

  it("applies the filter before the limit", async () => {
    const log = new AuditLog<{ n: number; tool: string }>({ stream: "s", dir: tmpDir(), clock: AUG });
    for (const n of [1, 2, 3, 4]) await log.append({ n, tool: n % 2 ? "a" : "b" });
    const out = await log.tail({ limit: 5, filter: (r) => r.tool === "a" });
    expect(out.records.map((r) => r.n)).toEqual([3, 1]);
  });

  it("spans monthly files, newest month first", async () => {
    const dir = tmpDir();
    await new AuditLog<{ n: number }>({ stream: "s", dir, clock: AUG }).append({ n: 1 });
    await new AuditLog<{ n: number }>({ stream: "s", dir, clock: SEP }).append({ n: 2 });
    const out = await new AuditLog<{ n: number }>({ stream: "s", dir }).tail({ limit: 10 });
    expect(out.records.map((r) => r.n)).toEqual([2, 1]);
  });

  it("flags a broken chain but still returns the readable records", async () => {
    const log = new AuditLog<{ n: number }>({ stream: "s", dir: tmpDir(), clock: AUG });
    for (const n of [1, 2, 3]) await log.append({ n });
    const file = log.fileFor(AUG());
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    lines[1] = lines[1].replace('"n":2', '"n":99');
    writeFileSync(file, lines.join("\n") + "\n");
    const out = await log.tail();
    expect(out.chainOk).toBe(false);
    expect(out.breaks).toEqual([{ file, line: 2 }]);
    expect(out.records.map((r) => r.n)).toEqual([3, 99, 1]);
  });

  it("returns an empty result when nothing was logged", async () => {
    const out = await new AuditLog({ stream: "s", dir: join(tmpDir(), "none") }).tail();
    expect(out).toEqual({ records: [], chainOk: true, breaks: [] });
  });
});

describe("AuditLog concurrency", () => {
  // `append` has no `await` before `withFileLock`, and its `fn` is
  // synchronous, so under Node's single-threaded event loop the first
  // `openSync(lock, "wx")` in a batch always wins — these 50 appends run
  // strictly sequentially and never touch the EEXIST branch. That is a
  // real, useful guarantee (two `AuditLog` instances in the same process
  // never race), just not lock contention — hence the name.
  it("sequential appends from two instances produce one valid chain", async () => {
    const dir = tmpDir();
    const a = new AuditLog<{ who: string; n: number }>({ stream: "s", dir, clock: AUG });
    const b = new AuditLog<{ who: string; n: number }>({ stream: "s", dir, clock: AUG });
    await Promise.all([
      ...Array.from({ length: 25 }, (_, n) => a.append({ who: "a", n })),
      ...Array.from({ length: 25 }, (_, n) => b.append({ who: "b", n })),
    ]);
    const [result] = await a.verify();
    expect(result).toMatchObject({ records: 50, ok: true });
  });

  it("waits for a foreign lock to be released rather than reclaiming it", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, "foreign-token"); // fresh mtime — not stale, must be waited out
    setTimeout(() => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }, 50);
    const rec = await log.append({ n: 1 });
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(existsSync(lockPath)).toBe(false);
  });

  describe("across real processes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Built by `npm run build` (tsc); CI always builds before testing
    // (.github/workflows/ci.yml), so this only skips a local run of the
    // focused test file without a prior build.
    const distAuditLog = resolve(here, "../../dist/audit-log.js");
    const workerPath = resolve(here, "helpers/audit-worker.mjs");

    function runWorker(dir: string, who: string, n: number): Promise<void> {
      return new Promise((res, reject) => {
        const child = fork(workerPath, [dir, who, String(n)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("exit", (code) => {
          if (code === 0) res();
          else reject(new Error(`audit-worker ${who} exited ${code}: ${stderr}`));
        });
        child.on("error", reject);
      });
    }

    it.skipIf(!existsSync(distAuditLog))(
      "three concurrent processes appending produce one valid chain (run `npm run build` first if this is skipped)",
      async () => {
        const dir = tmpDir();
        await Promise.all([
          runWorker(dir, "a", 40),
          runWorker(dir, "b", 40),
          runWorker(dir, "c", 40),
        ]);
        const log = new AuditLog({ stream: "s", dir });
        const [result] = await log.verify();
        expect(result).toMatchObject({ records: 120, ok: true });
      },
      30_000
    );
  });
});
