import { describe, expect, it, vi } from "vitest";
import { SupabaseDashboardRepository } from "./dashboard.js";

const commitmentRows = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    status: "active",
    target_at: "2026-07-23T15:59:59.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    status: "active",
    target_at: "2026-07-24T10:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000003",
    status: "active",
    target_at: "2026-07-24T15:00:00.000Z",
  },
  {
    id: "10000000-0000-4000-8000-000000000004",
    status: "active",
    target_at: "2026-07-25T00:00:00.000Z",
  },
] as const;

describe("SupabaseDashboardRepository", () => {
  it("derives overlapping due-today and exact-instant overdue facts after the DB read", async () => {
    const events: string[] = [];
    const fetchFromSupabase = vi.fn(async () => {
      events.push("database-read");
      return Response.json(commitmentRows);
    });
    const repository = new SupabaseDashboardRepository({
      fetch: fetchFromSupabase as typeof fetch,
      now: () => {
        events.push("timestamp");
        return new Date("2026-07-24T12:34:56.000Z");
      },
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "sb_secret_opaque-server-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    const summary = await repository.readSummary();

    expect(events).toEqual(["database-read", "timestamp"]);
    expect(summary).toEqual({
      commitments: commitmentRows.map((commitment) => ({
        id: commitment.id,
        status: commitment.status,
        targetAt: commitment.target_at,
      })),
      counts: {
        active: 4,
        dueToday: 2,
        overdue: 2,
      },
      updatedAt: "2026-07-24T12:34:56.000Z",
    });
    expect(summary.counts.active).toBe(summary.commitments.length);
    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/commitments?select=id,status,target_at&status=eq.active&order=target_at.asc",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          apikey: "sb_secret_opaque-server-key",
        },
      }),
    );
  });

  it("adds Bearer authorization only for a JWT-shaped service credential", async () => {
    const jwtCredential = "header.payload.signature";
    const fetchFromSupabase = vi.fn(async () => Response.json([]));
    const repository = new SupabaseDashboardRepository({
      fetch: fetchFromSupabase as typeof fetch,
      now: () => new Date("2026-07-24T12:34:56.000Z"),
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
          apikey: jwtCredential,
          Authorization: `Bearer ${jwtCredential}`,
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
        return Response.json([]);
      }) as typeof fetch,
      now: () => {
        events.push("timestamp");
        const value = timestamps.shift();
        if (!value) {
          throw new Error("Unexpected clock read");
        }
        return value;
      },
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
      fetch: (async () => Response.json([{ status: "active" }])) as typeof fetch,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "server-only-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(repository.readSummary()).rejects.toThrow(
      "Supabase dashboard read returned an invalid response",
    );
  });
});
