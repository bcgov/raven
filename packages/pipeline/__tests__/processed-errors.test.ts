import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// processed-errors store (processed-errors.ts)
// Scheduled fresh runs must not re-triage (and re-comment on) the same error
// every interval: dedupe keys are persisted across runs with a cooldown.
// Keys are scoped by server/app/component so a cooldown in one environment
// never hides the same error surfacing in another.
// ---------------------------------------------------------------------------

import {
  loadProcessedErrors,
  saveProcessedErrors,
  markProcessed,
  isInCooldown,
  filterByCooldown,
  scopedKey,
  DEFAULT_COOLDOWN_HOURS,
  MAX_COOLDOWN_HOURS,
} from "../src/processed-errors.js";

// The CLI caps --cooldown-hours at MAX_COOLDOWN_HOURS because save() prunes
// entries after 30 days — a longer cooldown would be silently shortened.
describe("cooldown bounds", () => {
  it("keeps the default cooldown within the prune window", () => {
    expect(DEFAULT_COOLDOWN_HOURS).toBeLessThanOrEqual(MAX_COOLDOWN_HOURS);
    expect(MAX_COOLDOWN_HOURS).toBe(720);
  });
});

const HOUR = 3600_000;

describe("processed-errors store", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "raven-processed-"));
    path = join(dir, "processed-errors.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scopes keys by server, app, and component", () => {
    expect(scopedKey("test01", "DMS", "dms-document-api", "E::frame")).not.toBe(
      scopedKey("prod01", "DMS", "dms-document-api", "E::frame"),
    );
  });

  it("round-trips mark and load with ticket key", () => {
    markProcessed("k1", "DMS-364", path);
    const store = loadProcessedErrors(path);
    expect(store["k1"]?.ticketKey).toBe("DMS-364");
    expect(Date.parse(store["k1"]!.lastSeen)).toBeGreaterThan(0);
  });

  it("returns an empty store for a missing or corrupt file", () => {
    expect(loadProcessedErrors(path)).toEqual({});
    writeFileSync(path, "not json{");
    expect(loadProcessedErrors(path)).toEqual({});
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

  it("filterByCooldown splits kept and skipped by scoped key", () => {
    const now = Date.now();
    const target = { server: "test01", app: "DMS", component: "dms-document-api" };
    const store = {
      [scopedKey(target.server, target.app, target.component, "seen::frame")]: {
        lastSeen: new Date(now - HOUR).toISOString(),
      },
    };
    const errors = [
      { dedupeKey: "seen::frame", message: "known" },
      { dedupeKey: "new::frame", message: "new" },
    ];
    const { kept, skipped } = filterByCooldown(errors, {
      ...target,
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
      store,
      now,
    });
    expect(kept.map((e) => e.message)).toEqual(["new"]);
    expect(skipped.map((e) => e.message)).toEqual(["known"]);
  });

  it("filterByCooldown keeps everything when the same error is from another target", () => {
    const now = Date.now();
    const store = {
      [scopedKey("test01", "DMS", "dms-document-api", "seen::frame")]: {
        lastSeen: new Date(now - HOUR).toISOString(),
      },
    };
    const { kept } = filterByCooldown([{ dedupeKey: "seen::frame" }], {
      server: "prod01",
      app: "DMS",
      component: "dms-document-api",
      cooldownHours: DEFAULT_COOLDOWN_HOURS,
      store,
      now,
    });
    expect(kept).toHaveLength(1);
  });
});
