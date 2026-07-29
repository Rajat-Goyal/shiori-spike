import { describe, expect, it, vi } from "vitest";
import { SupabaseDashboardRepository } from "./dashboard.js";

const ids = {
  commitment1: "10000000-0000-4000-8000-000000000001",
  commitment2: "10000000-0000-4000-8000-000000000002",
  commitment3: "10000000-0000-4000-8000-000000000003",
  event1: "30000000-0000-4000-8000-000000000001",
  message1: "40000000-0000-4000-8000-000000000001",
  session1: "50000000-0000-4000-8000-000000000001",
  session2: "50000000-0000-4000-8000-000000000002",
} as const;

function emptyReadModel() {
  return {
    activeCommitments: [],
    events: [],
    sessionHistoryRows: [],
    terminalCommitments: [],
  };
}

describe("SupabaseDashboardRepository", () => {
  it("derives owner-time-zone counts and stable live-state labels from one bounded RPC read", async () => {
    const events: string[] = [];
    const fetchFromSupabase = vi.fn(async () => {
      events.push("database-read");
      return Response.json({
        activeCommitments: [
          {
            continuation: null,
            currentSession: {
              calendarAttemptedAt: "2026-07-24T07:00:00.000Z",
              calendarCheckedAt: null,
              calendarStatus: "unverified",
              conflictConsent: false,
              durationMinutes: 60,
              endAt: "2026-07-24T10:00:00.000Z",
              finalCalendarObservation: "unavailable",
              id: ids.session1,
              isRecovery: false,
              outcomeAt: null,
              sequenceNumber: 1,
              startAt: "2026-07-24T09:00:00.000Z",
              status: "started",
            },
            definitionOfDone: "Finish the live-state read model",
            deliveries: [
              {
                dueAt: "2026-07-24T10:00:00.000Z",
                id: ids.message1,
                kind: "work_session_end",
                state: "pending",
              },
            ],
            id: ids.commitment2,
            targetAt: "2026-07-24T10:00:00.000Z",
          },
          {
            continuation: null,
            currentSession: null,
            definitionOfDone: "Send the proposal",
            deliveries: [
              {
                dueAt: "2026-07-23T15:59:59.000Z",
                id: ids.message1,
                kind: "simple_reminder",
                state: "delivery_unknown",
              },
            ],
            id: ids.commitment1,
            targetAt: "2026-07-23T15:59:59.000Z",
          },
          {
            continuation: null,
            currentSession: null,
            definitionOfDone: "Prepare tomorrow",
            deliveries: [],
            id: ids.commitment3,
            targetAt: "2026-07-25T00:00:00.000Z",
          },
        ],
        events: [],
        sessionHistoryRows: [],
        terminalCommitments: [],
      });
    });
    const repository = new SupabaseDashboardRepository({
      fetch: fetchFromSupabase as typeof fetch,
      now: () => {
        events.push("timestamp");
        return new Date("2026-07-24T12:34:56.000Z");
      },
      ownerId: 998877,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "sb_secret_opaque-server-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    const summary = await repository.readSummary();

    expect(events).toEqual(["database-read", "timestamp"]);
    expect(summary.counts).toEqual({
      active: 3,
      dueToday: 1,
      overdue: 2,
    });
    expect(summary.commitments.map(({ id }) => id)).toEqual([
      ids.commitment1,
      ids.commitment2,
      ids.commitment3,
    ]);
    expect(summary.commitments[0]).toMatchObject({
      calendar: {
        attemptedAt: null,
        checkedAt: null,
        kind: "not_needed",
        label: "Calendar check not needed",
      },
      deliveries: [
        {
          label: "Delivery uncertain",
          state: "delivery_unknown",
        },
      ],
      expectedDurationMinutes: null,
      next: {
        at: null,
        kind: "none",
        label: "No next action scheduled",
      },
    });
    expect(summary.commitments[1]).toMatchObject({
      calendar: {
        checkedAt: null,
        kind: "unverified",
        label: "Saved without a Calendar check",
      },
      expectedDurationMinutes: 60,
      next: {
        at: "2026-07-24T10:00:00.000Z",
        kind: "session_end",
        label: "Work session ends",
      },
    });
    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/read_dashboard_summary",
      expect.objectContaining({
        body: JSON.stringify({ p_owner_id: "998877" }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          apikey: "sb_secret_opaque-server-key",
        },
        method: "POST",
      }),
    );
  });

  it("maps bounded history and event facts without reconstructing product state", async () => {
    const repository = new SupabaseDashboardRepository({
      fetch: (async () =>
        Response.json({
          activeCommitments: [],
          events: [
            {
              actor: "owner",
              commitmentId: ids.commitment1,
              definitionOfDone: "Send the proposal",
              eventType: "commitment.done",
              id: ids.event1,
              occurredAt: "2026-07-24T11:00:00.000Z",
            },
          ],
          sessionHistoryRows: [
            {
              commitmentId: ids.commitment2,
              definitionOfDone: "Finish the live-state read model",
              durationMinutes: 60,
              endAt: "2026-07-24T10:00:00.000Z",
              id: ids.session2,
              isRecovery: true,
              outcomeAt: "2026-07-24T10:05:00.000Z",
              sequenceNumber: 6,
              startAt: "2026-07-24T09:00:00.000Z",
              status: "done",
              totalForCommitment: 6,
            },
          ],
          terminalCommitments: [
            {
              definitionOfDone: "Send the proposal",
              id: ids.commitment1,
              status: "done",
              targetAt: "2026-07-24T10:00:00.000Z",
              terminalAt: "2026-07-24T11:00:00.000Z",
            },
          ],
        })) as typeof fetch,
      now: () => new Date("2026-07-24T12:34:56.000Z"),
      ownerId: 998877,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "server-only-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    const summary = await repository.readSummary();

    expect(summary.sessionHistory).toEqual([
      {
        commitmentId: ids.commitment2,
        definitionOfDone: "Finish the live-state read model",
        sessions: [
          expect.objectContaining({
            id: ids.session2,
            isRecovery: true,
            label: "Done",
            sequenceNumber: 6,
            status: "done",
          }),
        ],
        truncated: true,
      },
    ]);
    expect(summary.terminalCommitments).toEqual([
      expect.objectContaining({
        id: ids.commitment1,
        label: "Completed",
        status: "done",
      }),
    ]);
    expect(summary.events).toEqual([
      expect.objectContaining({
        actor: "owner",
        eventType: "commitment.done",
        label: "Promise completed",
      }),
    ]);
  });

  it("adds Bearer authorization only for a JWT-shaped service credential", async () => {
    const jwtCredential = "header.payload.signature";
    const fetchFromSupabase = vi.fn(async () =>
      Response.json(emptyReadModel()),
    );
    const repository = new SupabaseDashboardRepository({
      fetch: fetchFromSupabase as typeof fetch,
      now: () => new Date("2026-07-24T12:34:56.000Z"),
      ownerId: 998877,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: jwtCredential,
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await repository.readSummary();

    expect(fetchFromSupabase).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${jwtCredential}`,
          "Content-Type": "application/json",
          apikey: jwtCredential,
        },
      }),
    );
  });

  it("timestamps every successful refresh after its corresponding database read", async () => {
    const events: string[] = [];
    const timestamps = [
      new Date("2026-07-24T12:34:56.000Z"),
      new Date("2026-07-24T12:34:57.000Z"),
    ];
    const repository = new SupabaseDashboardRepository({
      fetch: (async () => {
        events.push("database-read");
        return Response.json(emptyReadModel());
      }) as typeof fetch,
      now: () => {
        events.push("timestamp");
        const value = timestamps.shift();
        if (!value) {
          throw new Error("Unexpected clock read");
        }
        return value;
      },
      ownerId: 998877,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "sb_secret_opaque-server-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    const initial = await repository.readSummary();
    const refreshed = await repository.readSummary();

    expect(events).toEqual([
      "database-read",
      "timestamp",
      "database-read",
      "timestamp",
    ]);
    expect(refreshed.updatedAt).not.toBe(initial.updatedAt);
  });

  it("rejects malformed persistence responses instead of inventing dashboard data", async () => {
    const repository = new SupabaseDashboardRepository({
      fetch: (async () =>
        Response.json([{ status: "active" }])) as typeof fetch,
      ownerId: 998877,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "server-only-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(repository.readSummary()).rejects.toThrow(
      "Supabase dashboard read returned an invalid response",
    );
  });

  it.each([
    { durationMinutes: 0, endAt: "2026-07-24T09:00:00.000Z" },
    { durationMinutes: 1_441, endAt: "2026-07-25T09:01:00.000Z" },
    { durationMinutes: 45.5, endAt: "2026-07-24T09:45:30.000Z" },
    { durationMinutes: 45, endAt: "2026-07-24T09:46:00.000Z" },
  ])(
    "rejects dashboard session duration/window mismatch %#",
    async ({ durationMinutes, endAt }) => {
      const repository = new SupabaseDashboardRepository({
        fetch: (async () =>
          Response.json({
            activeCommitments: [{
              continuation: null,
              currentSession: {
                calendarAttemptedAt: "2026-07-24T08:00:00.000Z",
                calendarCheckedAt: "2026-07-24T08:00:00.000Z",
                calendarStatus: "free",
                conflictConsent: false,
                durationMinutes,
                endAt,
                finalCalendarObservation: "free",
                id: ids.session1,
                isRecovery: false,
                outcomeAt: null,
                sequenceNumber: 1,
                startAt: "2026-07-24T09:00:00.000Z",
                status: "planned",
              },
              definitionOfDone: "Reject malformed session data",
              deliveries: [],
              id: ids.commitment1,
              targetAt: "2026-07-26T10:00:00.000Z",
            }],
            events: [],
            sessionHistoryRows: [],
            terminalCommitments: [],
          })) as typeof fetch,
        ownerId: 998877,
        ownerTimeZone: "Asia/Singapore",
        supabaseSecretKey: "server-only-test-key",
        supabaseUrl: "http://127.0.0.1:54321",
      });

      await expect(repository.readSummary()).rejects.toThrow(
        "Dashboard work-session data is invalid",
      );
    },
  );

  it.each([
    {
      durationMinutes: 0,
      endAt: "2026-07-24T09:00:00.000Z",
      startAt: "2026-07-24T09:00:00.000Z",
    },
    {
      durationMinutes: 1_441,
      endAt: "2026-07-25T09:01:00.000Z",
      startAt: "2026-07-24T09:00:00.000Z",
    },
    {
      durationMinutes: 45.5,
      endAt: "2026-07-24T09:45:30.000Z",
      startAt: "2026-07-24T09:00:00.000Z",
    },
    {
      durationMinutes: 45,
      endAt: "2026-07-24T09:46:00.000Z",
      startAt: "2026-07-24T09:00:00.000Z",
    },
    {
      durationMinutes: 45,
      endAt: "2026-07-24T10:00:00.000Z",
      startAt: "2026-07-24T09:15:00.000Z",
    },
  ])(
    "rejects malformed dashboard history interval %#",
    async ({ durationMinutes, endAt, startAt }) => {
      const repository = new SupabaseDashboardRepository({
        fetch: (async () =>
          Response.json({
            ...emptyReadModel(),
            sessionHistoryRows: [{
              commitmentId: ids.commitment1,
              definitionOfDone: "Reject malformed session history",
              durationMinutes,
              endAt,
              id: ids.session1,
              isRecovery: false,
              outcomeAt: "2026-07-25T10:00:00.000Z",
              sequenceNumber: 1,
              startAt,
              status: "done",
              totalForCommitment: 1,
            }],
          })) as typeof fetch,
        ownerId: 998877,
        ownerTimeZone: "Asia/Singapore",
        supabaseSecretKey: "server-only-test-key",
        supabaseUrl: "http://127.0.0.1:54321",
      });

      await expect(repository.readSummary()).rejects.toThrow(
        "Dashboard session history data is invalid",
      );
    },
  );

  it.each([
    {
      durationMinutes: 45,
      endAt: "2026-07-24T09:45:00.000Z",
      startAt: "2026-07-24T09:00:00.000Z",
    },
    {
      durationMinutes: 1_440,
      endAt: "2026-07-25T16:00:00.000Z",
      startAt: "2026-07-24T16:00:00.000Z",
    },
  ])(
    "accepts exact bounded dashboard history interval %#",
    async ({ durationMinutes, endAt, startAt }) => {
      const repository = new SupabaseDashboardRepository({
        fetch: (async () =>
          Response.json({
            ...emptyReadModel(),
            sessionHistoryRows: [{
              commitmentId: ids.commitment1,
              definitionOfDone: "Accept exact session history",
              durationMinutes,
              endAt,
              id: ids.session1,
              isRecovery: false,
              outcomeAt: "2026-07-26T10:00:00.000Z",
              sequenceNumber: 1,
              startAt,
              status: "done",
              totalForCommitment: 1,
            }],
          })) as typeof fetch,
        ownerId: 998877,
        ownerTimeZone: "Asia/Singapore",
        supabaseSecretKey: "server-only-test-key",
        supabaseUrl: "http://127.0.0.1:54321",
      });

      await expect(repository.readSummary()).resolves.toMatchObject({
        sessionHistory: [{
          sessions: [
            expect.objectContaining({
              durationMinutes,
              endAt,
              startAt,
            }),
          ],
        }],
      });
    },
  );
});
