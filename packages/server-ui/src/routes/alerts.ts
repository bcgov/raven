/**
 * Alert rules CRUD, history, test email, and SSE stream.
 *
 * GET    /api/alerts/rules      — list all rules
 * POST   /api/alerts/rules      — create a rule
 * PUT    /api/alerts/rules/:id  — update a rule
 * DELETE /api/alerts/rules/:id  — delete a rule
 * GET    /api/alerts/history    — recent alert events
 * POST   /api/alerts/test-email — send a test email to verify SMTP
 * GET    /api/alerts/stream     — SSE for real-time alert delivery
 */
import { Router } from "express";
import {
  getAlertRules,
  addAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getAlertHistory,
} from "../lib/store.js";
import {
  addAlertSubscriber,
  removeAlertSubscriber,
  sendTestEmail,
} from "../lib/collector.js";
import { validateServer, validateAppName } from "../lib/validate.js";

export const alertsRouter = Router();

/** Basic email validation. */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validate a webhook URL is safe (HTTPS only, no SSRF targets).
 * Blocks localhost, link-local, RFC 1918, and cloud metadata addresses.
 */
function isAllowedWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    // Block localhost variants
    if (host === "localhost" || host === "[::1]") return false;
    // Block IP-based SSRF targets
    const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 127) return false;                  // 127.0.0.0/8
      if (a === 10) return false;                    // 10.0.0.0/8
      if (a === 172 && b! >= 16 && b! <= 31) return false; // 172.16.0.0/12
      if (a === 192 && b === 168) return false;      // 192.168.0.0/16
      if (a === 169 && b === 254) return false;      // 169.254.0.0/16 (link-local / metadata)
      if (a === 0) return false;                     // 0.0.0.0/8
    }
    return true;
  } catch {
    return false;
  }
}

/** List all alert rules. */
alertsRouter.get("/rules", (_req, res) => {
  res.json(getAlertRules());
});

/** Create a new alert rule. */
alertsRouter.post("/rules", (req, res) => {
  const {
    type,
    app,
    component,
    server,
    threshold,
    window,
    webhookUrl,
    notifyEmail,
    enabled,
  } = req.body;

  // Validation
  if (!type || !["heap", "errors"].includes(type)) {
    res.status(400).json({ error: "type must be 'heap' or 'errors'" });
    return;
  }
  if (!app || !validateAppName(app)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }
  if (!component || !validateAppName(component)) {
    res.status(400).json({ error: "Invalid component name" });
    return;
  }
  if (!validateServer(server)) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }
  if (typeof threshold !== "number" || threshold <= 0) {
    res.status(400).json({ error: "threshold must be a positive number" });
    return;
  }
  if (type === "errors" && window && !["1h", "6h", "24h"].includes(window)) {
    res.status(400).json({ error: "window must be '1h', '6h', or '24h'" });
    return;
  }
  if (webhookUrl && !isAllowedWebhookUrl(webhookUrl)) {
    res
      .status(400)
      .json({ error: "webhookUrl must be HTTPS and not target internal/private addresses" });
    return;
  }
  if (notifyEmail && !isValidEmail(notifyEmail)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  const rule = addAlertRule({
    type,
    app,
    component,
    server,
    threshold,
    window: type === "errors" ? window || "1h" : undefined,
    webhookUrl: webhookUrl || undefined,
    notifyEmail: notifyEmail || undefined,
    enabled: enabled !== false,
  });
  res.status(201).json(rule);
});

/** Update an existing alert rule. */
alertsRouter.put("/rules/:id", (req, res) => {
  const {
    type,
    app,
    component,
    server,
    threshold,
    window,
    webhookUrl,
    notifyEmail,
    enabled,
  } = req.body;

  // Validate only provided fields
  if (type && !["heap", "errors"].includes(type)) {
    res.status(400).json({ error: "type must be 'heap' or 'errors'" });
    return;
  }
  if (app && !validateAppName(app)) {
    res.status(400).json({ error: "Invalid app name" });
    return;
  }
  if (component && !validateAppName(component)) {
    res.status(400).json({ error: "Invalid component name" });
    return;
  }
  if (server && !validateServer(server)) {
    res.status(400).json({ error: "Invalid server name" });
    return;
  }
  if (threshold !== undefined && (typeof threshold !== "number" || threshold <= 0)) {
    res.status(400).json({ error: "threshold must be a positive number" });
    return;
  }
  if (window && !["1h", "6h", "24h"].includes(window)) {
    res.status(400).json({ error: "window must be '1h', '6h', or '24h'" });
    return;
  }
  if (webhookUrl && !isAllowedWebhookUrl(webhookUrl)) {
    res
      .status(400)
      .json({ error: "webhookUrl must be HTTPS and not target internal/private addresses" });
    return;
  }
  if (notifyEmail && !isValidEmail(notifyEmail)) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (type !== undefined) updates.type = type;
  if (app !== undefined) updates.app = app;
  if (component !== undefined) updates.component = component;
  if (server !== undefined) updates.server = server;
  if (threshold !== undefined) updates.threshold = threshold;
  if (window !== undefined) updates.window = window;
  if (webhookUrl !== undefined) updates.webhookUrl = webhookUrl || undefined;
  if (notifyEmail !== undefined) updates.notifyEmail = notifyEmail || undefined;
  if (enabled !== undefined) updates.enabled = enabled;

  const updated = updateAlertRule(req.params.id, updates);
  if (!updated) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json(updated);
});

/** Delete an alert rule. */
alertsRouter.delete("/rules/:id", (req, res) => {
  const ok = deleteAlertRule(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json({ deleted: true });
});

/** Recent alert history. */
alertsRouter.get("/history", (req, res) => {
  const limit = Math.min(
    200,
    Math.max(1, parseInt((req.query.limit as string) || "50", 10))
  );
  res.json(getAlertHistory(limit));
});

/** Send a test email to verify SMTP configuration. */
alertsRouter.post("/test-email", async (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email)) {
    res.status(400).json({ error: "Valid email address required" });
    return;
  }
  const result = await sendTestEmail(email);
  if (result.ok) {
    res.json({ ok: true, message: `Test email sent to ${email}` });
  } else {
    res.status(502).json({ ok: false, error: result.error });
  }
});

/** SSE stream for real-time alert events. */
alertsRouter.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Initial keepalive
  res.write(":ok\n\n");
  addAlertSubscriber(res);
  req.on("close", () => removeAlertSubscriber(res));
});
