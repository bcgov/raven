/**
 * JSON file store for historical data.
 *
 * Persists error snapshots, version snapshots, alert rules/history,
 * and server reachability status to ~/.raven/server-ui-data.json.
 *
 * Uses atomic writes (write .tmp then rename) to prevent corruption.
 * Retention trimming runs on every save:
 *   - errorSnapshots: 90 days
 *   - versionSnapshots: 180 days
 *   - alertHistory: 500 entries max
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────

/** A point-in-time error count for one app/component on one server. */
export interface ErrorSnapshot {
  ts: string;
  server: string;
  app: string;
  component: string;
  count: number;
}

/** A point-in-time version record, stored only when version changes. */
export interface VersionSnapshot {
  ts: string;
  server: string;
  app: string;
  component: string;
  version: string;
  previousVersion?: string;
  /** True if this was the first observation (baseline), not an actual deployment. */
  initial?: boolean;
}

/** An alert rule configured by the user. */
export interface AlertRule {
  id: string;
  type: "heap" | "errors";
  app: string;
  component: string;
  server: string;
  threshold: number;
  window?: string;
  webhookUrl?: string;
  /** Email address for alert notifications. */
  notifyEmail?: string;
  enabled: boolean;
  createdAt: string;
}

/** A record of a fired alert. */
export interface AlertEvent {
  ts: string;
  ruleId: string;
  type: "heap" | "errors";
  app: string;
  component: string;
  server: string;
  value: number;
  threshold: number;
  message: string;
}

/** Server reachability tracked by the collector. */
export interface ServerStatus {
  reachable: boolean;
  lastCheck: string;
}

/** Top-level store shape. */
export interface StoreData {
  errorSnapshots: ErrorSnapshot[];
  versionSnapshots: VersionSnapshot[];
  alertRules: AlertRule[];
  alertHistory: AlertEvent[];
  serverStatus: Record<string, ServerStatus>;
  collectorLastRun?: string;
}

// ── File paths ─────────────────────────────────────────────────────

const RAVEN_DIR = join(homedir(), ".raven");
const STORE_FILE = join(RAVEN_DIR, "server-ui-data.json");
const STORE_TMP = STORE_FILE + ".tmp";

// ── Retention limits ───────────────────────────────────────────────

const ERROR_RETENTION_DAYS = 90;
const VERSION_RETENTION_DAYS = 180;
const ALERT_HISTORY_MAX = 500;

// ── Core I/O ───────────────────────────────────────────────────────

function emptyStore(): StoreData {
  return {
    errorSnapshots: [],
    versionSnapshots: [],
    alertRules: [],
    alertHistory: [],
    serverStatus: {},
  };
}

/** Read the store from disk. Returns empty defaults if file is missing. */
export function loadStore(): StoreData {
  if (!existsSync(STORE_FILE)) return emptyStore();

  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const data = JSON.parse(raw) as Partial<StoreData>;
    return {
      errorSnapshots: data.errorSnapshots ?? [],
      versionSnapshots: data.versionSnapshots ?? [],
      alertRules: data.alertRules ?? [],
      alertHistory: data.alertHistory ?? [],
      serverStatus: data.serverStatus ?? {},
      collectorLastRun: data.collectorLastRun,
    };
  } catch (err) {
    logger.error("Failed to read store", { error: String(err) });
    return emptyStore();
  }
}

/** Write the store to disk with atomic rename and retention trimming. */
export function saveStore(data: StoreData): void {
  mkdirSync(RAVEN_DIR, { recursive: true });

  // Retention trimming
  const now = Date.now();
  const errorCutoff = now - ERROR_RETENTION_DAYS * 86_400_000;
  const versionCutoff = now - VERSION_RETENTION_DAYS * 86_400_000;

  data.errorSnapshots = data.errorSnapshots.filter(
    (s) => new Date(s.ts).getTime() > errorCutoff
  );
  data.versionSnapshots = data.versionSnapshots.filter(
    (s) => new Date(s.ts).getTime() > versionCutoff
  );
  if (data.alertHistory.length > ALERT_HISTORY_MAX) {
    data.alertHistory = data.alertHistory.slice(-ALERT_HISTORY_MAX);
  }

  try {
    writeFileSync(STORE_TMP, JSON.stringify(data, null, 2), "utf-8");
    renameSync(STORE_TMP, STORE_FILE);
  } catch (err) {
    logger.error("Failed to write store", { error: String(err) });
  }
}

// ── Error snapshots ────────────────────────────────────────────────

/** Append error snapshots and persist. */
export function addErrorSnapshots(snapshots: ErrorSnapshot[]): void {
  if (snapshots.length === 0) return;
  const store = loadStore();
  store.errorSnapshots.push(...snapshots);
  saveStore(store);
}

/** Query error snapshots with optional filters. */
export function getErrorTrends(filters: {
  app?: string;
  component?: string;
  server?: string;
  days?: number;
}): ErrorSnapshot[] {
  const store = loadStore();
  const days = filters.days ?? 30;
  const cutoff = Date.now() - days * 86_400_000;

  return store.errorSnapshots.filter((s) => {
    if (new Date(s.ts).getTime() < cutoff) return false;
    if (filters.app && s.app !== filters.app) return false;
    if (filters.component && s.component !== filters.component) return false;
    if (filters.server && s.server !== filters.server) return false;
    return true;
  });
}

// ── Version snapshots ──────────────────────────────────────────────

/** Get the last known version for a server/app/component. */
export function getLastKnownVersion(
  server: string,
  app: string,
  component: string
): string | null {
  const store = loadStore();
  for (let i = store.versionSnapshots.length - 1; i >= 0; i--) {
    const s = store.versionSnapshots[i];
    if (s.server === server && s.app === app && s.component === component) {
      return s.version;
    }
  }
  return null;
}

/**
 * Record a version snapshot only if the version changed.
 * If `isInitial` is true, the version is recorded as a baseline and won't
 * appear as a "deployment" in the timeline.
 */
export function addVersionSnapshot(
  snap: VersionSnapshot,
  isInitial = false
): void {
  const lastKnown = getLastKnownVersion(snap.server, snap.app, snap.component);
  if (lastKnown === snap.version) return; // No change

  const store = loadStore();
  store.versionSnapshots.push({
    ...snap,
    previousVersion: lastKnown ?? undefined,
    ...(isInitial ? { initial: true } : {}),
  } as VersionSnapshot);
  saveStore(store);
}

/** Query version history with optional filters. */
export function getVersionHistory(filters: {
  app?: string;
  component?: string;
  days?: number;
}): VersionSnapshot[] {
  const store = loadStore();
  const days = filters.days ?? 90;
  const cutoff = Date.now() - days * 86_400_000;

  return store.versionSnapshots.filter((s) => {
    if (new Date(s.ts).getTime() < cutoff) return false;
    if (filters.app && s.app !== filters.app) return false;
    if (filters.component && s.component !== filters.component) return false;
    return true;
  });
}

// ── Alert rules CRUD ───────────────────────────────────────────────

/** List all alert rules. */
export function getAlertRules(): AlertRule[] {
  return loadStore().alertRules;
}

/** Get a single alert rule by ID. */
export function getAlertRule(id: string): AlertRule | undefined {
  return loadStore().alertRules.find((r) => r.id === id);
}

/** Create a new alert rule. */
export function addAlertRule(
  rule: Omit<AlertRule, "id" | "createdAt">
): AlertRule {
  const store = loadStore();
  const newRule: AlertRule = {
    ...rule,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  store.alertRules.push(newRule);
  saveStore(store);
  return newRule;
}

/** Update an existing alert rule. Returns the updated rule or null. */
export function updateAlertRule(
  id: string,
  updates: Partial<Omit<AlertRule, "id" | "createdAt">>
): AlertRule | null {
  const store = loadStore();
  const idx = store.alertRules.findIndex((r) => r.id === id);
  if (idx === -1) return null;

  store.alertRules[idx] = { ...store.alertRules[idx], ...updates };
  saveStore(store);
  return store.alertRules[idx];
}

/** Delete an alert rule. Returns true if found and deleted. */
export function deleteAlertRule(id: string): boolean {
  const store = loadStore();
  const before = store.alertRules.length;
  store.alertRules = store.alertRules.filter((r) => r.id !== id);
  if (store.alertRules.length === before) return false;
  saveStore(store);
  return true;
}

// ── Alert history ──────────────────────────────────────────────────

/** Record a fired alert event. */
export function addAlertEvent(event: AlertEvent): void {
  const store = loadStore();
  store.alertHistory.push(event);
  saveStore(store);
}

/** Get recent alert history, newest first. */
export function getAlertHistory(limit: number = 50): AlertEvent[] {
  const store = loadStore();
  return store.alertHistory.slice(-limit).reverse();
}

// ── Server status ──────────────────────────────────────────────────

/** Update reachability status for a server. */
export function updateServerStatus(
  server: string,
  reachable: boolean
): void {
  const store = loadStore();
  store.serverStatus[server] = {
    reachable,
    lastCheck: new Date().toISOString(),
  };
  saveStore(store);
}

/** Get all server statuses. */
export function getServerStatuses(): Record<string, ServerStatus> {
  return loadStore().serverStatus;
}

// ── Collector metadata ─────────────────────────────────────────────

/** Record the last collector run time. */
export function setCollectorLastRun(ts: string): void {
  const store = loadStore();
  store.collectorLastRun = ts;
  saveStore(store);
}
