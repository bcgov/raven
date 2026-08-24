import { createHash, randomBytes } from "node:crypto";

/** prevHash of the first record in every audit file. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Deterministic JSON: object keys sorted recursively, arrays in order,
 * undefined properties dropped (JSON.stringify semantics).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
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
