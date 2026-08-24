import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GENESIS_HASH, canonicalJson, hashRecord, newAuditId } from "../audit-log.js";

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
