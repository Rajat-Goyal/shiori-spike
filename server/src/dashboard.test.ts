import { describe, expect, it, vi } from "vitest";
import { SupabaseDashboardRepository } from "./dashboard.js";

describe("SupabaseDashboardRepository", () => {
  it("derives factual counts and an API timestamp from the Supabase response", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json([
        {
          id: "10000000-0000-4000-8000-000000000001",
          status: "active",
          target_at: "2026-07-23T15:59:59.000Z",
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          status: "active",
          target_at: "2026-07-23T16:00:00.000Z",
        },
        {
          id: "10000000-0000-4000-8000-000000000003",
          status: "active",
          target_at: "2026-07-25T00:00:00.000Z",
        },
      ]),
    );
    const repository = new SupabaseDashboardRepository({
      fetch: fetchFromSupabase as typeof fetch,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "server-only-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    const now = new Date("2026-07-24T12:34:56.000Z");

    const summary = await repository.readSummary(now);

    expect(summary).toEqual({
      commitments: [],
      counts: {
        active: 3,
        dueToday: 1,
        overdue: 1,
      },
      updatedAt: "2026-07-24T12:34:56.000Z",
    });
    expect(fetchFromSupabase).toHaveBeenCalledOnce();
    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/commitments?select=id,status,target_at&status=eq.active&order=target_at.asc",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          apikey: "server-only-test-key",
          Authorization: "Bearer server-only-test-key",
        },
      }),
    );
  });

  it("rejects malformed persistence responses instead of inventing dashboard data", async () => {
    const repository = new SupabaseDashboardRepository({
      fetch: (async () => Response.json([{ status: "active" }])) as typeof fetch,
      ownerTimeZone: "Asia/Singapore",
      supabaseSecretKey: "server-only-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(repository.readSummary(new Date())).rejects.toThrow(
      "Supabase dashboard read returned an invalid response",
    );
  });
});
