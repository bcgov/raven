import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  existsSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(listAuditFiles(dir, "s").map((f) => f.split("/").pop())).toEqual([
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

  it.skipIf(process.platform === "win32")("rejects when the directory is not writable", async () => {
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

  it("reclaims a lock older than 30s and leaves no lock file behind", async () => {
    const dir = tmpDir();
    const log = new AuditLog({ stream: "s", dir, clock: AUG });
    const lockPath = log.fileFor(AUG()) + ".lock";
    writeFileSync(lockPath, "foreign-token");
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    const rec = await log.append({ n: 1 });
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(existsSync(lockPath)).toBe(false);
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

  it("reports ok for an untouched file", async () => {
    const { log } = await threeRecords();
    expect(await log.verify()).toEqual([{ file: log.fileFor(AUG()), records: 3, ok: true }]);
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
    expect(results.map((r) => [r.file.split("/").pop(), r.ok])).toEqual([
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
