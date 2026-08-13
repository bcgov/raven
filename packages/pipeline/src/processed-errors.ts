import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Persistent record of errors the pipeline has already triaged, so that
 * scheduled fresh runs don't re-analyze (and re-comment on) the same error
 * every interval. Watch mode's in-memory dedupe set only lives for one
 * process; this store carries the same knowledge across runs.
 *
 * Each server/app/component target gets its OWN store file: per-target
 * LaunchAgents can fire at the same times and launchd only serializes
 * same-label jobs, so a shared file's read-modify-write would let one
 * target's save silently drop another target's fresh entry. Same-target
 * runs are serialized by launchd; writes are atomic (temp + rename) so a
 * reader never sees a partial file.
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

export function defaultStoreDir(): string {
  return join(homedir(), ".raven", "processed-errors");
}

/** Per-target store file. Sanitized so target names can't escape the dir. */
export function storePathFor(
  server: string,
  app: string,
  component: string,
  baseDir = defaultStoreDir(),
): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(baseDir, `${safe(server)}__${safe(app)}__${safe(component)}.json`);
}

export function loadProcessedErrors(path: string): ProcessedErrorStore {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProcessedErrorStore;
  } catch {
    // Missing or corrupt file — start fresh rather than blocking the run.
    return {};
  }
}

export function saveProcessedErrors(store: ProcessedErrorStore, path: string): void {
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 24 * 3600_000;
  const pruned: ProcessedErrorStore = {};
  for (const [key, entry] of Object.entries(store)) {
    const ts = Date.parse(entry.lastSeen);
    if (Number.isFinite(ts) && ts >= cutoff) pruned[key] = entry;
  }
  mkdirSync(dirname(path), { recursive: true });
  // Atomic replace: a concurrent reader sees either the old or the new
  // store, never a partial write.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pruned, null, 2));
  renameSync(tmp, path);
}

/** Record a triage action for a dedupe key in the given target store. */
export function markProcessed(
  dedupeKey: string,
  ticketKey: string | undefined,
  path: string,
): void {
  const store = loadProcessedErrors(path);
  store[dedupeKey] = { lastSeen: new Date().toISOString(), ticketKey };
  saveProcessedErrors(store, path);
}

export function isInCooldown(
  store: ProcessedErrorStore,
  dedupeKey: string,
  cooldownHours: number,
  now = Date.now(),
): boolean {
  if (cooldownHours <= 0) return false;
  const entry = store[dedupeKey];
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
    baseDir?: string;
    now?: number;
  },
): { kept: T[]; skipped: T[] } {
  const store = loadProcessedErrors(
    storePathFor(opts.server, opts.app, opts.component, opts.baseDir),
  );
  const kept: T[] = [];
  const skipped: T[] = [];
  for (const err of errors) {
    if (isInCooldown(store, err.dedupeKey, opts.cooldownHours, opts.now)) {
      skipped.push(err);
    } else {
      kept.push(err);
    }
  }
  return { kept, skipped };
}
