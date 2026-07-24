import { describe, expect, it, vi } from "vitest";

import {
  GoogleCalendarAdapter,
  type GoogleCalendarTokenProvider,
} from "./calendar.js";

const range = {
  endAt: "2026-08-03T12:00:00+08:00",
  startAt: "2026-08-01T08:00:00+08:00",
} as const;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function controlled(
  fetchResults: Response[],
  tokenProvider: GoogleCalendarTokenProvider = {
    async getToken() {
      return { accessToken: "server-only-token-sentinel", status: "ok" };
    },
  },
) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const next = fetchResults.shift();
    if (!next) {
      throw new Error("Unexpected Calendar request");
    }
    return next;
  });
  return {
    adapter: new GoogleCalendarAdapter({
      fetch,
      now: () => new Date("2026-08-01T00:00:05.000Z"),
      tokenProvider,
    }),
    calls,
    fetch,
  };
}

describe("GoogleCalendarAdapter", () => {
  it("requests only primary FreeBusy and an allowed bounded event projection", async () => {
    const test = controlled([
      response({
        calendars: {
          primary: {
            busy: [
              {
                end: "2026-08-01T11:00:00+08:00",
                start: "2026-08-01T10:00:00+08:00",
              },
            ],
          },
        },
      }),
      response({
        items: [
          {
            attendees: [{ email: "discarded@example.test" }],
            description: "discarded-description-sentinel",
            end: {
              dateTime: "2026-08-01T11:00:00+08:00",
              timeZone: "Asia/Singapore",
            },
            id: "event-1",
            location: "discarded-location-sentinel",
            organizer: { email: "discarded-organizer@example.test" },
            recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
            start: {
              dateTime: "2026-08-01T10:00:00+08:00",
              timeZone: "Asia/Singapore",
            },
            status: "confirmed",
            summary: "Allowed title",
            transparency: "opaque",
          },
        ],
      }),
    ]);

    const result = await test.adapter.read({ calendarId: "primary", range });
    expect(result).toEqual({
      busyIntervals: [
        {
          endAt: "2026-08-01T03:00:00.000Z",
          startAt: "2026-08-01T02:00:00.000Z",
        },
      ],
      checkedAt: "2026-08-01T00:00:05.000Z",
      eventSummaries: [
        {
          busyStatus: "busy",
          end: {
            dateTime: "2026-08-01T03:00:00.000Z",
            kind: "date_time",
            timeZone: "Asia/Singapore",
          },
          id: "event-1",
          recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
          start: {
            dateTime: "2026-08-01T02:00:00.000Z",
            kind: "date_time",
            timeZone: "Asia/Singapore",
          },
          status: "confirmed",
          title: "Allowed title",
        },
      ],
      status: "ok",
    });

    expect(test.calls).toHaveLength(2);
    const freeBusyCall = test.calls[0]!;
    expect(String(freeBusyCall.input)).toBe(
      "https://www.googleapis.com/calendar/v3/freeBusy",
    );
    expect(freeBusyCall.init?.method).toBe("POST");
    expect(JSON.parse(String(freeBusyCall.init?.body))).toEqual({
      items: [{ id: "primary" }],
      timeMax: "2026-08-03T04:00:00.000Z",
      timeMin: "2026-08-01T00:00:00.000Z",
      timeZone: "Asia/Singapore",
    });

    const eventsUrl = new URL(String(test.calls[1]!.input));
    expect(eventsUrl.pathname).toBe(
      "/calendar/v3/calendars/primary/events",
    );
    expect(Object.fromEntries(eventsUrl.searchParams)).toEqual({
      fields: "items(id,summary,start,end,transparency,recurrence,status)",
      maxResults: "50",
      orderBy: "startTime",
      showDeleted: "true",
      singleEvents: "true",
      timeMax: "2026-08-03T04:00:00.000Z",
      timeMin: "2026-08-01T00:00:00.000Z",
      timeZone: "Asia/Singapore",
    });
    expect(JSON.stringify(result)).not.toContain(
      "discarded-description-sentinel",
    );
    expect(JSON.stringify(result)).not.toContain(
      "discarded-location-sentinel",
    );
    expect(JSON.stringify(result)).not.toContain(
      "discarded-organizer@example.test",
    );
  });

  it("keeps transparent and cancelled summaries separate from FreeBusy authority", async () => {
    const test = controlled([
      response({
        calendars: {
          primary: {
            busy: [
              {
                end: "2026-08-02T00:00:00+08:00",
                start: "2026-08-01T00:00:00+08:00",
              },
            ],
          },
        },
      }),
      response({
        items: [
          {
            end: { date: "2026-08-02" },
            id: "transparent-event",
            start: { date: "2026-08-01" },
            status: "confirmed",
            summary: "Free summary",
            transparency: "transparent",
          },
          {
            end: { date: "2026-08-03" },
            id: "cancelled-event",
            start: { date: "2026-08-02" },
            status: "cancelled",
            summary: "Cancelled summary",
          },
        ],
      }),
    ]);

    const result = await test.adapter.read({ calendarId: "primary", range });
    expect(result).toMatchObject({
      busyIntervals: [
        {
          endAt: "2026-08-01T16:00:00.000Z",
          startAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      eventSummaries: [
        { busyStatus: "free", id: "transparent-event" },
        {
          busyStatus: "busy",
          id: "cancelled-event",
          status: "cancelled",
        },
      ],
      status: "ok",
    });
  });

  it("normalizes offsets, clips the checked range, and merges only overlaps", async () => {
    const test = controlled([
      response({
        calendars: {
          primary: {
            busy: [
              {
                end: "2026-08-01T02:30:00Z",
                start: "2026-08-01T01:30:00Z",
              },
              {
                end: "2026-08-01T11:00:00+08:00",
                start: "2026-08-01T10:00:00+08:00",
              },
              {
                end: "2026-08-01T11:30:00+08:00",
                start: "2026-08-01T10:30:00+08:00",
              },
              {
                end: "2026-08-01T12:00:00+08:00",
                start: "2026-08-01T11:30:00+08:00",
              },
            ],
          },
        },
      }),
      response({}),
    ]);

    const result = await test.adapter.read({ calendarId: "primary", range });
    expect(result).toMatchObject({
      busyIntervals: [
        {
          endAt: "2026-08-01T03:30:00.000Z",
          startAt: "2026-08-01T01:30:00.000Z",
        },
        {
          endAt: "2026-08-01T04:00:00.000Z",
          startAt: "2026-08-01T03:30:00.000Z",
        },
      ],
      status: "ok",
    });
  });

  it.each([
    {
      expected: "authorization_expired",
      freeBusyStatus: 401,
      name: "expired FreeBusy authorization",
    },
    {
      expected: "authorization_expired",
      eventsStatus: 403,
      name: "expired event-list authorization",
    },
    {
      expected: "unavailable",
      freeBusyStatus: 503,
      name: "unavailable FreeBusy",
    },
    {
      eventsStatus: 503,
      expected: "unavailable",
      name: "unavailable event list",
    },
  ])("returns $expected for $name", async (fixture) => {
    const test = controlled([
      response(
        fixture.freeBusyStatus
          ? {}
          : { calendars: { primary: { busy: [] } } },
        fixture.freeBusyStatus ?? 200,
      ),
      ...(fixture.freeBusyStatus
        ? []
        : [response({ items: [] }, fixture.eventsStatus)]),
    ]);
    await expect(
      test.adapter.read({ calendarId: "primary", range }),
    ).resolves.toEqual({ status: fixture.expected });
  });

  it.each([
    { status: "authorization_expired" as const },
    { status: "unavailable" as const },
  ])("propagates token-provider $status without an HTTP request", async (token) => {
    const test = controlled([], {
      async getToken() {
        return token;
      },
    });
    await expect(
      test.adapter.read({ calendarId: "primary", range }),
    ).resolves.toEqual(token);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("fails closed before credentials for a non-primary or unbounded range", async () => {
    const provider = { getToken: vi.fn() };
    const test = controlled([], provider as GoogleCalendarTokenProvider);

    await expect(
      test.adapter.read({
        calendarId: "secondary" as "primary",
        range,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      test.adapter.read({
        calendarId: "primary",
        range: {
          endAt: "2026-08-20T08:00:00+08:00",
          startAt: "2026-08-01T08:00:00+08:00",
        },
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(provider.getToken).not.toHaveBeenCalled();
  });

  it("returns unavailable for malformed provider objects without exposing them", async () => {
    const test = controlled([
      response({
        calendars: {
          primary: {
            busy: [{ end: "not-a-date", start: "private-sentinel" }],
          },
        },
      }),
    ]);
    await expect(
      test.adapter.read({ calendarId: "primary", range }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
