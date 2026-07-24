import { describe, expect, it, vi } from "vitest";
import type {
  GoogleCalendarAdapter,
  GoogleCalendarResult,
} from "../google/calendar.js";
import {
  checkCalendarAvailability,
  normalizeTimingConstraints,
  TIMING_CONSTRAINT_FORMAT_HELP,
} from "./availability-integration.js";

type CalendarBoundary = Pick<GoogleCalendarAdapter, "read">;

function calendarReturning(result: GoogleCalendarResult) {
  const read = vi.fn<CalendarBoundary["read"]>(async () => result);
  return {
    calendar: { read } satisfies CalendarBoundary,
    read,
  };
}

describe("normalizeTimingConstraints", () => {
  it("expands default Singapore hours deterministically", () => {
    expect(
      normalizeTimingConstraints("  DEFAULT  ", [
        "2026-07-27",
        "2026-07-28",
      ]),
    ).toEqual({
      canonical: "default",
      effectiveDays: [
        {
          date: "2026-07-27",
          windows: [{ endTime: "20:00", startTime: "08:00" }],
        },
        {
          date: "2026-07-28",
          windows: [{ endTime: "20:00", startTime: "08:00" }],
        },
      ],
      status: "ok",
    });
  });

  it("normalizes up to four strict rules, merges adjacent windows, and closes unmatched days", () => {
    expect(
      normalizeTimingConstraints(
        " MON, wed 08:00 - 10:00\nmon 10:00-11:30\nfri 23:00-24:00 ",
        [
          "2026-07-27",
          "2026-07-28",
          "2026-07-29",
          "2026-07-31",
        ],
      ),
    ).toEqual({
      canonical:
        "mon 08:00-11:30\nwed 08:00-10:00\nfri 23:00-24:00",
      effectiveDays: [
        {
          date: "2026-07-27",
          windows: [{ endTime: "11:30", startTime: "08:00" }],
        },
        { date: "2026-07-28", windows: [] },
        {
          date: "2026-07-29",
          windows: [{ endTime: "10:00", startTime: "08:00" }],
        },
        {
          date: "2026-07-31",
          windows: [{ endTime: "24:00", startTime: "23:00" }],
        },
      ],
      status: "ok",
    });
  });

  it.each([
    "weekday mornings",
    "weekdays 08:00-10:00",
    "mon-fri 08:00-10:00",
    "tomorrow 08:00-10:00",
    "mon 08:15-10:00",
    "mon 10:00-08:00",
    "mon 23:30-00:30",
    "mon 24:00-24:00",
    "mon 08:00-10:00\n\nwed 08:00-10:00",
    "mon 08:00-09:00\ntue 08:00-09:00\nwed 08:00-09:00\nthu 08:00-09:00\nfri 08:00-09:00",
  ])("rejects unsupported input with format help: %s", (input) => {
    expect(
      normalizeTimingConstraints(input, ["2026-07-27"]),
    ).toEqual({
      formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
      status: "invalid",
    });
  });
});

describe("checkCalendarAvailability", () => {
  const request = {
    durationMinutes: 60,
    kind: "generated" as const,
    now: "2026-07-27T07:00:00+08:00",
    targetAt: "2026-07-28T12:00:00+08:00",
    timingConstraints: "mon 08:00-10:00",
  };

  it("uses only the primary boundary, returns available windows, and discards event detail", async () => {
    const provider = calendarReturning({
      busyIntervals: [
        {
          endAt: "2026-07-27T08:30:00+08:00",
          startAt: "2026-07-27T08:00:00+08:00",
        },
      ],
      checkedAt: "2026-07-26T23:00:00.000Z",
      eventSummaries: [
        {
          busyStatus: "busy",
          end: {
            dateTime: "2026-07-27T00:30:00.000Z",
            kind: "date_time",
            timeZone: "Asia/Singapore",
          },
          id: "private-event-id",
          recurrence: [],
          start: {
            dateTime: "2026-07-27T00:00:00.000Z",
            kind: "date_time",
            timeZone: "Asia/Singapore",
          },
          status: "confirmed",
          title: "Private meeting title",
        },
      ],
      status: "ok",
    });

    const result = await checkCalendarAvailability(
      request,
      provider.calendar,
    );

    expect(result).toEqual({
      alternatives: [
        {
          endAt: "2026-07-27T09:30:00+08:00",
          startAt: "2026-07-27T08:30:00+08:00",
        },
        {
          endAt: "2026-07-27T10:00:00+08:00",
          startAt: "2026-07-27T09:00:00+08:00",
        },
      ],
      checkedAt: "2026-07-26T23:00:00.000Z",
      proposed: null,
      status: "available",
    });
    expect(provider.read).toHaveBeenCalledOnce();
    expect(provider.read.mock.calls[0]?.[0]).toMatchObject({
      calendarId: "primary",
    });
    expect(JSON.stringify(result)).not.toContain("Private meeting title");
    expect(JSON.stringify(result)).not.toContain("private-event-id");
  });

  it.each([
    "unavailable",
    "authorization_expired",
    "provider_failure",
  ] as const)("preserves the typed %s boundary failure", async (status) => {
    const provider = calendarReturning({ status });
    await expect(
      checkCalendarAvailability(request, provider.calendar),
    ).resolves.toEqual({ status });
  });

  it("rejects timing prose before reading Calendar", async () => {
    const provider = calendarReturning({
      busyIntervals: [],
      checkedAt: "2026-07-26T23:00:00.000Z",
      eventSummaries: [],
      status: "ok",
    });

    await expect(
      checkCalendarAvailability(
        { ...request, timingConstraints: "weekday mornings" },
        provider.calendar,
      ),
    ).resolves.toEqual({
      formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
      status: "invalid_timing_constraints",
    });
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("is deterministic across repeated reads and has no write capability", async () => {
    const first = calendarReturning({
      busyIntervals: [],
      checkedAt: "2026-07-26T23:00:00.000Z",
      eventSummaries: [],
      status: "ok",
    });
    const second = calendarReturning({
      busyIntervals: [],
      checkedAt: "2026-07-26T23:00:00.000Z",
      eventSummaries: [],
      status: "ok",
    });

    const firstResult = await checkCalendarAvailability(
      request,
      first.calendar,
    );
    const secondResult = await checkCalendarAvailability(
      request,
      second.calendar,
    );
    expect(secondResult).toEqual(firstResult);
    expect(Object.keys(first.calendar)).toEqual(["read"]);
    expect(Object.keys(second.calendar)).toEqual(["read"]);
  });
});
