/**
 * Deployment calendar slot parsing/formatting.
 *
 * The deployment calendar plugin (rest/deploymentcalendar/1.0/api) stores
 * slots as issues whose description embeds JSON metadata ({bookedBy,
 * timestamp, duration}) and reports reservations via `reservedBy`. These
 * helpers normalize that into something an agent can read.
 */

/** Raw slot entry as returned by GET /rest/deploymentcalendar/1.0/api/slots. */
export interface RawDeploySlot {
  key: string;
  description?: string | null;
  /** e.g. "2026-07-21 11:00:00.0" */
  timestampField?: string;
  /** Issue key holding the reservation, or null when the slot is free. */
  reservedBy?: string | null;
}

export interface DeploySlot {
  key: string;
  /** "YYYY-MM-DD HH:mm" */
  time: string;
  durationMinutes?: number;
  reservedBy?: string;
}

export function parseSlot(raw: RawDeploySlot): DeploySlot {
  let durationMinutes: number | undefined;
  if (raw.description) {
    try {
      const meta = JSON.parse(raw.description) as { duration?: unknown };
      if (typeof meta.duration === "number") durationMinutes = meta.duration;
    } catch {
      // Slot descriptions are free text edited by humans; ignore bad JSON.
    }
  }
  return {
    key: raw.key,
    time: (raw.timestampField ?? "").replace(/:\d{2}\.\d+$/, ""),
    durationMinutes,
    reservedBy: raw.reservedBy ?? undefined,
  };
}

export function formatSlots(slots: DeploySlot[]): string {
  if (slots.length === 0) {
    return "No deployment slots found in this window.";
  }

  const byTime = (a: DeploySlot, b: DeploySlot) => a.time.localeCompare(b.time);
  const available = slots.filter((s) => !s.reservedBy).sort(byTime);
  const reserved = slots.filter((s) => s.reservedBy).sort(byTime);

  const fmt = (s: DeploySlot) => {
    const duration = s.durationMinutes !== undefined ? ` (${s.durationMinutes} min)` : "";
    const holder = s.reservedBy ? ` — reserved by ${s.reservedBy}` : "";
    return `- ${s.time}${duration} — \`${s.key}\`${holder}`;
  };

  const lines = [`**${available.length} available / ${reserved.length} reserved**`];
  if (available.length > 0) {
    lines.push("", "**Available:**", ...available.map(fmt));
  }
  if (reserved.length > 0) {
    lines.push("", "**Reserved:**", ...reserved.map(fmt));
  }
  return lines.join("\n");
}

const localDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Resolve the slot-listing window. Defaults use the caller's LOCAL calendar
 * date (UTC would skip "today" every evening in Pacific time) and the default
 * end is start + 14 days via calendar arithmetic, which is DST-safe.
 */
export function resolveSlotWindow(
  now: Date,
  startDate?: string,
  endDate?: string
): { start: string; end: string } {
  const start = startDate ?? localDateStr(now);
  let end = endDate;
  if (!end) {
    const [y, m, d] = start.split("-").map(Number);
    end = localDateStr(new Date(y, m - 1, d + 14));
  }
  return { start, end };
}

/**
 * Confirmation message after reserving a slot. The post-reserve read-back can
 * legitimately 404 (plugin lag), so a null booking is reported as
 * unverified rather than echoing formatReservation's contradictory
 * "No deployment booking found" text after a successful reserve.
 */
export function formatReserveConfirmation(
  issueKey: string,
  slotKey: string,
  booking: Record<string, unknown> | null
): string {
  const header = `Reserved ${slotKey} for ${issueKey}.`;
  if (!booking) {
    return (
      `${header}\n\nThe reservation was accepted but could not be verified by read-back yet — ` +
      `check get_deployment_booking or the calendar UI before relying on it.`
    );
  }
  return `${header}\n\n${formatReservation(issueKey, booking)}`;
}

export function formatReservation(
  issueKey: string,
  reservation: Record<string, unknown> | null
): string {
  if (!reservation) {
    return `No deployment booking found for ${issueKey}.`;
  }
  const lines = [`**Deployment booking for ${issueKey}:**`];
  for (const [k, v] of Object.entries(reservation)) {
    if (v !== null && v !== undefined && typeof v !== "object") {
      lines.push(`- ${k}: ${String(v)}`);
    }
  }
  return lines.join("\n");
}
