/**
 * Background data collector for historical metrics.
 *
 * Runs every 30 minutes (and once immediately on startup):
 *   1. Calls server-dashboard for each server to collect error counts and versions
 *   2. Records error snapshots and version changes to the store
 *   3. Evaluates alert rules and fires alerts when thresholds are breached
 *
 * Also manages SSE subscribers for real-time alert delivery.
 */
import type { Response } from "express";
import { createTransport, type Transporter } from "nodemailer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runDashboard, getJvmHeap } from "@nrs/server-mcp/client";
import { getServerConfig } from "./server-config.js";
import {
  addErrorSnapshots,
  addVersionSnapshot,
  updateServerStatus,
  setCollectorLastRun,
  getAlertRules,
  getAlertHistory,
  addAlertEvent,
  getErrorTrends,
  loadStore,
  type ErrorSnapshot,
  type AlertEvent,
} from "./store.js";
import { logger } from "./logger.js";

// ── State ──────────────────────────────────────────────────────────

const INTERVAL_MS = 30 * 60_000; // 30 minutes
const ALERT_COOLDOWN_MS = 30 * 60_000; // 30 minutes between re-fires

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastRun: string | null = null;
let nextRun: string | null = null;
let isFirstRun = true;

/** Active SSE connections for real-time alert delivery. */
const alertSubscribers = new Set<Response>();

// ── Public API ─────────────────────────────────────────────────────

/** Start the background collector. Called once from createApp(). */
export function startCollector(): void {
  if (running) return;
  running = true;
  logger.info("Collector started", { intervalMs: INTERVAL_MS });

  // Run immediately, then on interval
  collectOnce().catch((err) =>
    logger.error("Initial collection failed", { error: String(err) })
  );

  intervalId = setInterval(() => {
    collectOnce().catch((err) =>
      logger.error("Collection pass failed", { error: String(err) })
    );
  }, INTERVAL_MS);
}

/** Stop the background collector. */
export function stopCollector(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  running = false;
  logger.info("Collector stopped");
}

/** Get collector status for the health endpoint. */
export function getCollectorStatus(): {
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
} {
  return { running, lastRun, nextRun };
}

/** Register an SSE subscriber for real-time alerts. */
export function addAlertSubscriber(res: Response): void {
  alertSubscribers.add(res);
}

/** Remove an SSE subscriber. */
export function removeAlertSubscriber(res: Response): void {
  alertSubscribers.delete(res);
}

// ── Collection logic ───────────────────────────────────────────────

async function collectOnce(): Promise<void> {
  const startTime = Date.now();
  const entries = getServerConfig();
  logger.info("Collection pass starting", { servers: entries.map((e) => e.name) });

  // Fan out per-server: one ssh2 session each, key-aware via SSH_KEY_HOSTS.
  // Promise.allSettled so a single auth/timeout failure doesn't poison the rest.
  const now = new Date().toISOString();
  const settled = await Promise.allSettled(
    entries.map(async (entry) => ({ name: entry.name, data: await runDashboard(entry) })),
  );

  const errorSnapshots: ErrorSnapshot[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const entry = entries[i];
    if (!entry) continue;
    if (r.status !== "fulfilled") {
      updateServerStatus(entry.name, false);
      logger.warn("dashboard collection failed", {
        server: entry.name,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
      continue;
    }
    updateServerStatus(entry.name, true);

    for (const [key, count] of r.value.data.errors) {
      const [app, component] = key.split("|", 2);
      if (!app || !component) continue;
      errorSnapshots.push({ ts: now, server: entry.name, app, component, count });
    }
    for (const [key, version] of r.value.data.versions) {
      const [app, component] = key.split("|", 2);
      if (!app || !component || !version || version === "—") continue;
      addVersionSnapshot({ ts: now, server: entry.name, app, component, version }, isFirstRun);
    }
  }
  if (errorSnapshots.length > 0) addErrorSnapshots(errorSnapshots);

  // Evaluate alert rules after collection
  await evaluateAlerts();

  isFirstRun = false;
  lastRun = now;
  nextRun = new Date(Date.now() + INTERVAL_MS).toISOString();
  setCollectorLastRun(now);

  const duration = Date.now() - startTime;
  logger.info("Collection pass complete", { durationMs: duration });
}

// ── Alert evaluation ───────────────────────────────────────────────

async function evaluateAlerts(): Promise<void> {
  const rules = getAlertRules().filter((r) => r.enabled);
  if (rules.length === 0) return;

  const recentHistory = getAlertHistory(200);

  for (const rule of rules) {
    // Cooldown check — skip if this rule fired recently
    const lastFiring = recentHistory.find((e) => e.ruleId === rule.id);
    if (lastFiring) {
      const elapsed = Date.now() - new Date(lastFiring.ts).getTime();
      if (elapsed < ALERT_COOLDOWN_MS) continue;
    }

    try {
      if (rule.type === "heap") {
        await evaluateHeapAlert(rule);
      } else if (rule.type === "errors") {
        evaluateErrorAlert(rule);
      }
    } catch (err) {
      logger.error(`Alert evaluation failed for rule ${rule.id}`, {
        error: String(err),
      });
    }
  }
}

async function evaluateHeapAlert(
  rule: ReturnType<typeof getAlertRules>[0]
): Promise<void> {
  const entry = getServerConfig().find((s) => s.name === rule.server);
  if (!entry) return;
  const result = await getJvmHeap(entry, rule.app, rule.component);
  if (!result.ok) return;
  if (result.metrics.heapPct >= rule.threshold) {
    fireAlert(rule, result.metrics.heapPct);
  }
}

function evaluateErrorAlert(
  rule: ReturnType<typeof getAlertRules>[0]
): void {
  // Determine time window in days (fractional)
  let windowMs: number;
  switch (rule.window) {
    case "1h":
      windowMs = 3_600_000;
      break;
    case "6h":
      windowMs = 21_600_000;
      break;
    case "24h":
      windowMs = 86_400_000;
      break;
    default:
      windowMs = 3_600_000;
  }

  const cutoff = Date.now() - windowMs;
  const store = loadStore();
  const relevant = store.errorSnapshots.filter(
    (s) =>
      s.server === rule.server &&
      s.app === rule.app &&
      s.component === rule.component &&
      new Date(s.ts).getTime() > cutoff
  );

  const totalCount = relevant.reduce((sum, s) => sum + s.count, 0);
  if (totalCount >= rule.threshold) {
    fireAlert(rule, totalCount);
  }
}

function fireAlert(
  rule: ReturnType<typeof getAlertRules>[0],
  value: number
): void {
  const unit = rule.type === "heap" ? "%" : " errors";
  const windowLabel = rule.type === "errors" && rule.window ? ` in ${rule.window}` : "";
  const message = `${rule.type === "heap" ? "Heap" : "Errors"} at ${value}${unit} for ${rule.app}/${rule.component} on ${rule.server} (threshold: ${rule.threshold}${unit}${windowLabel})`;

  const event: AlertEvent = {
    ts: new Date().toISOString(),
    ruleId: rule.id,
    type: rule.type,
    app: rule.app,
    component: rule.component,
    server: rule.server,
    value,
    threshold: rule.threshold,
    message,
  };

  addAlertEvent(event);
  logger.warn("Alert fired", { ruleId: rule.id, message });

  // Push to SSE subscribers
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const subscriber of alertSubscribers) {
    try {
      subscriber.write(payload);
    } catch {
      alertSubscribers.delete(subscriber);
    }
  }

  // Webhook delivery (fire and forget)
  if (rule.webhookUrl) {
    deliverWebhook(rule.webhookUrl, event).catch((err) =>
      logger.error("Webhook delivery failed", {
        url: rule.webhookUrl,
        error: String(err),
      })
    );
  }

  // Email delivery (fire and forget)
  if (rule.notifyEmail) {
    deliverEmail(rule.notifyEmail, event).catch((err) =>
      logger.error("Email delivery failed", {
        email: rule.notifyEmail,
        error: String(err),
      })
    );
  }
}

// ── SMTP email delivery ───────────────────────────────────────────

/** Load a named variable from env or ~/.raven/.env. */
function loadEnvVar(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const content = readFileSync(join(homedir(), ".raven", ".env"), "utf-8");
    const re = new RegExp(`^${name}=(.+)$`, "m");
    const match = content.match(re);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/** Lazy-initialized SMTP transporter. */
let smtpTransport: Transporter | null = null;

/** Get or create the nodemailer SMTP transporter. */
function getSmtpTransport(): Transporter | null {
  if (smtpTransport) return smtpTransport;

  const host = loadEnvVar("SMTP_HOST");
  if (!host) {
    logger.warn("SMTP_HOST not configured — email alerts disabled");
    return null;
  }

  const port = parseInt(loadEnvVar("SMTP_PORT") ?? "25", 10);
  const user = loadEnvVar("SMTP_USER");
  const pass = loadEnvVar("SMTP_PASSWORD");

  smtpTransport = createTransport({
    host,
    port,
    secure: port === 465,
    // Only use auth if credentials are provided
    ...(user && pass ? { auth: { user, pass } } : {}),
    // Internal gov relay — skip TLS certificate validation
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  logger.info("SMTP transport initialized", { host, port, auth: !!user });
  return smtpTransport;
}

/** Get the configured "from" address for alert emails. */
function getSmtpFrom(): string {
  return loadEnvVar("SMTP_FROM") ?? "raven-alerts@example.gov.bc.ca";
}

/**
 * Send an email alert via SMTP (nodemailer).
 * Used by the alert system and the test-email endpoint.
 */
export async function deliverEmail(
  email: string,
  event: AlertEvent
): Promise<void> {
  const transport = getSmtpTransport();
  if (!transport) {
    logger.warn("Email not sent — SMTP not configured", { email });
    return;
  }

  const subject = `[Server Monitor] ${event.type === "heap" ? "Heap" : "Error"} threshold breached — ${event.app}/${event.component}`;
  const body = [
    `Alert: ${event.message}`,
    ``,
    `Type: ${event.type}`,
    `Server: ${event.server}`,
    `App: ${event.app}`,
    `Component: ${event.component}`,
    `Value: ${event.value}${event.type === "heap" ? "%" : " errors"}`,
    `Threshold: ${event.threshold}${event.type === "heap" ? "%" : ""}`,
    `Time: ${event.ts}`,
    ``,
    `— Server Monitor (RAVEN)`,
  ].join("\n");

  try {
    await transport.sendMail({
      from: getSmtpFrom(),
      to: email,
      subject,
      text: body,
    });
    logger.info("Email alert sent", { email, ruleId: event.ruleId });
  } catch (err) {
    logger.error("SMTP email delivery failed", {
      email,
      error: String(err),
    });
    throw err;
  }
}

/**
 * Send a test email to verify SMTP configuration.
 * Returns a result object indicating success or failure.
 */
export async function sendTestEmail(
  email: string
): Promise<{ ok: boolean; error?: string }> {
  const transport = getSmtpTransport();
  if (!transport) {
    return { ok: false, error: "SMTP not configured. Add SMTP_HOST to ~/.raven/.env." };
  }

  try {
    await transport.sendMail({
      from: getSmtpFrom(),
      to: email,
      subject: "[Server Monitor] Test email — SMTP is working",
      text: [
        "This is a test email from RAVEN Server Monitor.",
        "",
        "If you received this, your SMTP configuration is working correctly.",
        "",
        `SMTP Host: ${loadEnvVar("SMTP_HOST")}`,
        `From: ${getSmtpFrom()}`,
        `Time: ${new Date().toISOString()}`,
        "",
        "— Server Monitor (RAVEN)",
      ].join("\n"),
    });
    logger.info("Test email sent", { email });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Test email failed", { email, error: msg });
    return { ok: false, error: msg };
  }
}

async function deliverWebhook(
  url: string,
  event: AlertEvent
): Promise<void> {
  const body = {
    text: `[Server Monitor] ${event.message}`,
    app: event.app,
    component: event.component,
    server: event.server,
    value: event.value,
    threshold: event.threshold,
    type: event.type,
    ts: event.ts,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    logger.warn("Webhook returned non-OK status", {
      url,
      status: response.status,
    });
  }
}
