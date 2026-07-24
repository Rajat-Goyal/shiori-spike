import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { SupabaseDashboardRepository } from "../src/dashboard.js";

describe("local Supabase dashboard read", () => {
  it("returns a factual empty summary from the migrated local database", async () => {
    const config = readServerConfig();
    const url = new URL(config.supabaseUrl);

    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.port !== "54321"
    ) {
      throw new Error(
        "test:db is restricted to the Docker-generated local Supabase API on port 54321",
      );
    }

    const repository = new SupabaseDashboardRepository({
      ownerTimeZone: config.ownerTimeZone,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const summary = await repository.readSummary();

    expect(summary.counts).toEqual({
      active: 0,
      dueToday: 0,
      overdue: 0,
    });
    expect(summary.commitments).toEqual([]);
    expect(Number.isNaN(Date.parse(summary.updatedAt))).toBe(false);
  });
});
