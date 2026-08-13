import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Persistent record of errors the pipeline has already triaged, so that
 * scheduled fresh runs don't re-analyze (and re-comment on) the same error
 * every interval. Watch mode's in-memory dedupe set only lives for one
 * process; this store carries the same knowledge across runs.
 *
 * Keys are scoped by server/app/component (see scopedKey) — a cooldown for
 * an error seen in one environment must never suppress the same signature
 * surfacing in another.
 */

export interface ProcessedEntry {
  /** ISO timestamp of the last triage action (ticket created or seen-again comment). */
  lastSeen: string;
  ticketKey?: string;
}

export type ProcessedErrorStore = Record<string, ProcessedEntry>;

/** Don't re-triage the same error signature within this window. */
export const DEFAULT_COOLDOWN_HOURS = 168;

/** Entries older than this are dropped on save to keep the store small. */
const PRUNE_AFTER_DAYS = 30;

/**
 * Upper bound for --cooldown-hours, enforced at the CLI: cooldowns beyond
 * the prune window would be silently shortened as soon as any later save
 * dropped their entries.
 */
export const MAX_COOLDOWN_HOURS = PRUNE_AFTER_DAYS * 24;

export function defaultStorePath(): string {
  return join(homedir(), ".raven", "processed-errors.json");
}

export function scopedKey(
  server: string,
  app: string,
  component: string,
  dedupeKey: string,
): string {
  return `${server}/${app}/${component}::${dedupeKey}`;
}

export function loadProcessedErrors(path = defaultStorePath()): ProcessedErrorStore {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProcessedErrorStore;
  } catch {
    // Missing or corrupt file — start fresh rather than blocking the run.
    return {};
  }
}

export function saveProcessedErrors(
  store: ProcessedErrorStore,
  path = defaultStorePath(),
): void {
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 3600_000;
  const pruned: ProcessedErrorStore = {};
  for (const [key, entry] of Object.entries(store)) {
    const ts = Date.parse(entry.lastSeen);
    if (Number.isFinite(ts) && ts >= cutoff) pruned[key] = entry;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pruned, null, 2));
}

/** Record a triage action for a (already scoped) store key. */
export function markProcessed(
  key: string,
  ticketKey?: string,
  path = defaultStorePath(),
): void {
  const store = loadProcessedErrors(path);
  store[key] = { lastSeen: new Date().toISOString(), ticketKey };
  saveProcessedErrors(store, path);
}

export function isInCooldown(
  store: ProcessedErrorStore,
  key: string,
  cooldownHours: number,
  now = Date.now(),
): boolean {
  if (cooldownHours <= 0) return false;
  const entry = store[key];
  if (!entry) return false;
  const ts = Date.parse(entry.lastSeen);
  if (!Number.isFinite(ts)) return false;
  return now - ts < cooldownHours * 3600_000;
}

/** Split detected errors into those to process and those still in cooldown. */
export function filterByCooldown<T extends { dedupeKey: string }>(
  errors: T[],
  opts: {
    server: string;
    app: string;
    component: string;
    cooldownHours: number;
    store?: ProcessedErrorStore;
    now?: number;
  },
): { kept: T[]; skipped: T[] } {
  const store = opts.store ?? loadProcessedErrors();
  const kept: T[] = [];
  const skipped: T[] = [];
  for (const err of errors) {
    const key = scopedKey(opts.server, opts.app, opts.component, err.dedupeKey);
    if (isInCooldown(store, key, opts.cooldownHours, opts.now)) {
      skipped.push(err);
    } else {
      kept.push(err);
    }
  }
  return { kept, skipped };
}
