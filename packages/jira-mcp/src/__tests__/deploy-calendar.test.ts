import { describe, it, expect } from "vitest";
import {
  parseSlot,
  formatSlots,
  formatReservation,
  formatReserveConfirmation,
  resolveSlotWindow,
  type RawDeploySlot,
} from "../deploy-calendar.js";

describe("parseSlot", () => {
  it("extracts time, duration, and reservation from a raw slot", () => {
    const raw: RawDeploySlot = {
      key: "IMBADSLOT-15788",
      description: '{"bookedBy":"SOMEUSER","timestamp":1784656800000,"duration":60}',
      timestampField: "2026-07-21 11:00:00.0",
      reservedBy: "OTHERAPP-4239",
    };
    expect(parseSlot(raw)).toEqual({
      key: "IMBADSLOT-15788",
      time: "2026-07-21 11:00",
      durationMinutes: 60,
      reservedBy: "OTHERAPP-4239",
    });
  });

  it("treats a null reservedBy as free and tolerates malformed description JSON", () => {
    const raw: RawDeploySlot = {
      key: "IMBADSLOT-15607",
      description: "not json at all",
      timestampField: "2026-07-30 11:30:00.0",
      reservedBy: null,
    };
    expect(parseSlot(raw)).toEqual({
      key: "IMBADSLOT-15607",
      time: "2026-07-30 11:30",
      durationMinutes: undefined,
      reservedBy: undefined,
    });
  });
});

describe("formatSlots", () => {
  const slots = [
    {
      key: "IMBADSLOT-2",
      time: "2026-07-29 11:30",
      durationMinutes: 90,
      reservedBy: undefined,
    },
    {
      key: "IMBADSLOT-1",
      time: "2026-07-21 11:00",
      durationMinutes: 60,
      reservedBy: "OTHERAPP-4239",
    },
    {
      key: "IMBADSLOT-3",
      time: "2026-07-22 08:00",
      durationMinutes: undefined,
      reservedBy: undefined,
    },
  ];

  it("lists available slots first, sorted by time, then reserved ones", () => {
    const text = formatSlots(slots);
    expect(text).toContain("2 available");
    expect(text).toContain("1 reserved");
    const lines = text.split("\n");
    const i3 = lines.findIndex((l) => l.includes("IMBADSLOT-3"));
    const i2 = lines.findIndex((l) => l.includes("IMBADSLOT-2"));
    const i1 = lines.findIndex((l) => l.includes("IMBADSLOT-1"));
    // Available (3 then 2, by time) before reserved (1).
    expect(i3).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i3);
    expect(i1).toBeGreaterThan(i2);
    expect(lines[i2]).toContain("90 min");
    expect(lines[i1]).toContain("reserved by OTHERAPP-4239");
  });

  it("reports when no slots exist in the window", () => {
    expect(formatSlots([])).toContain("No deployment slots");
  });
});

describe("resolveSlotWindow", () => {
  it("defaults start to the LOCAL date, not the UTC date", () => {
    // 11:30pm local on July 17 — UTC may already be July 18.
    const now = new Date(2026, 6, 17, 23, 30);
    expect(resolveSlotWindow(now)).toEqual({ start: "2026-07-17", end: "2026-07-31" });
  });

  it("computes the default end with calendar arithmetic (DST-safe)", () => {
    // Oct 25 + 14 days crosses the Nov 1 DST fall-back in Pacific time.
    const now = new Date(2026, 9, 25, 12, 0);
    expect(resolveSlotWindow(now).end).toBe("2026-11-08");
  });

  it("respects explicit start and end dates", () => {
    expect(resolveSlotWindow(new Date(2026, 0, 1), "2026-07-20", "2026-07-22")).toEqual({
      start: "2026-07-20",
      end: "2026-07-22",
    });
  });

  it("defaults the end relative to an explicit start", () => {
    expect(resolveSlotWindow(new Date(2026, 0, 1), "2026-07-20")).toEqual({
      start: "2026-07-20",
      end: "2026-08-03",
    });
  });
});

describe("formatReservation", () => {
  it("formats an existing booking", () => {
    const text = formatReservation("MYAPP-977", {
      bookedDate: "2026-07-21T11:00:00.000-0700",
      created: "2026-07-16T09:00:00.000-0700",
    });
    expect(text).toContain("MYAPP-977");
    expect(text).toContain("2026-07-21");
  });

  it("states clearly when there is no booking", () => {
    const text = formatReservation("MYAPP-977", null);
    expect(text).toContain("No deployment booking");
    expect(text).toContain("MYAPP-977");
  });
});

describe("formatReserveConfirmation", () => {
  it("includes the booking details when the read-back succeeds", () => {
    const text = formatReserveConfirmation("MYAPP-977", "IMBADSLOT-42", {
      bookedDate: "2026-07-21T11:00:00.000-0700",
    });
    expect(text).toContain("Reserved IMBADSLOT-42 for MYAPP-977");
    expect(text).toContain("2026-07-21");
  });

  it("flags an unverified reservation when the read-back returns null", () => {
    const text = formatReserveConfirmation("MYAPP-977", "IMBADSLOT-42", null);
    expect(text).toContain("Reserved IMBADSLOT-42 for MYAPP-977");
    expect(text).toContain("could not be verified");
    expect(text).toContain("get_deployment_booking");
    expect(text).not.toContain("No deployment booking");
  });
});
