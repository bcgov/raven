import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// processed-errors store (processed-errors.ts)
// Scheduled fresh runs must not re-triage (and re-comment on) the same error
// every interval: dedupe keys are persisted across runs with a cooldown.
// Each server/app/component target gets its OWN store file — per-target
// LaunchAgents run concurrently (launchd only serializes same-label jobs),
// and a shared file's read-modify-write would let one target's save drop
// another's fresh entry.
// ---------------------------------------------------------------------------

import {
  loadProcessedErrors,
  saveProcessedErrors,
  markProcessed,
  isInCooldown,
  filterByCooldown,
  storePathFor,
  DEFAULT_COOLDOWN_HOURS,
  MAX_COOLDOWN_HOURS,
} from "../src/processed-errors.js";

const HOUR = 3600_000;

// The CLI caps --cooldown-hours at MAX_COOLDOWN_HOURS because save() prunes
// entries after 30 days — a longer cooldown would be silently shortened.
describe("cooldown bounds", () => {
  it("keeps the default cooldown within the prune window", () => {
    expect(DEFAULT_COOLDOWN_HOURS).toBeLessThanOrEqual(MAX_COOLDOWN_HOURS);
    expect(MAX_COOLDOWN_HOURS).toBe(720);
  });
});

describe("processed-errors store", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "raven-processed-"));
    path = join(dir, "test01__DMS__dms-document-api.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives each server/app/component target its own store file", () => {
    const a = storePathFor("test01", "DMS", "dms-document-api", dir);
    const b = storePathFor("prod01", "DMS", "dms-document-api", dir);
    const c = storePathFor("test01", "SOS", "cwm-sos-api", dir);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const p of [a, b, c]) expect(p.startsWith(dir)).toBe(true);
  });

  it("sanitizes unexpected characters out of store filenames", () => {
    const p = storePathFor("srv", "APP", "comp/../oops", dir);
    expect(p.startsWith(dir)).toBe(true);
    expect(p).not.toContain("..");
  });

  it("round-trips mark and load with ticket key", () => {
    markProcessed("E::frame", "DMS-364", path);
    const store = loadProcessedErrors(path);
    expect(store["E::frame"]?.ticketKey).toBe("DMS-364");
    expect(Date.parse(store["E::frame"]!.lastSeen)).toBeGreaterThan(0);
  });

  it("returns an empty store for a missing or corrupt file", () => {
    expect(loadProcessedErrors(path)).toEqual({});
    writeFileSync(path, "not json{");
    expect(loadProcessedErrors(path)).toEqual({});
  });

  it("writes atomically — no partial temp files left behind", () => {
    markProcessed("k1", undefined, path);
    markProcessed("k2", "DMS-1", path);
    const files = readdirSync(dir);
    expect(files).toEqual(["test01__DMS__dms-document-api.json"]);
    const store = loadProcessedErrors(path);
    expect(Object.keys(store).sort()).toEqual(["k1", "k2"]);
  });

  it("is in cooldown within the window and out of it after", () => {
    const now = Date.now();
    const store = { k1: { lastSeen: new Date(now - 2 * HOUR).toISOString() } };
    expect(isInCooldown(store, "k1", 24, now)).toBe(true);
    expect(isInCooldown(store, "k1", 1, now)).toBe(false);
    expect(isInCooldown(store, "missing", 24, now)).toBe(false);
  });

  it("cooldown of 0 disables suppression entirely", () => {
    const store = { k1: { lastSeen: new Date().toISOString() } };
    expect(isInCooldown(store, "k1", 0)).toBe(false);
  });

  it("prunes entries older than 30 days on save", () => {
    const now = Date.now();
    mkdirSync(dir, { recursive: true });
    saveProcessedErrors(
      {
        old: { lastSeen: new Date(now - 40 * 24 * HOUR).toISOString() },
        fresh: { lastSeen: new Date(now - HOUR).toISOString() },
      },
      path,
    );
    const store = loadProcessedErrors(path);
    expect(store["old"]).toBeUndefined();
    expect(store["fresh"]).toBeDefined();
  });

  it("filterByCooldown splits kept and skipped for the target's own store", () => {
    const now = Date.now();
    const target = { server: "test01", app: "DMS", component: "dms-document-api" };
    markProcessed("seen::frame", "DMS-364", storePathFor(target.server, target.app, target.component, dir));
    const errors = [
      { dedupeKey: "seen::frame", message: "known" },
      { dedupeKey: "new::frame", message: "new" },
    ];
    const { kept, skipped } = filterByCooldown(errors, {
      ...target,
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
      baseDir: dir,
      now,
    });
    expect(kept.map((e) => e.message)).toEqual(["new"]);
    expect(skipped.map((e) => e.message)).toEqual(["known"]);
  });

  it("marks in one target never suppress the same signature in another target", () => {
    const now = Date.now();
    markProcessed("seen::frame", "DMS-364", storePathFor("test01", "DMS", "dms-document-api", dir));
    const { kept } = filterByCooldown([{ dedupeKey: "seen::frame" }], {
      server: "prod01",
      app: "DMS",
      component: "dms-document-api",
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
      baseDir: dir,
      now,
    });
    expect(kept).toHaveLength(1);
  });
});
