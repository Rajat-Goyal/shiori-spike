import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { SupabaseDashboardRepository } from "../src/dashboard.js";
import { supabaseHeaders } from "../src/supabase.js";
import {
  dashboardFixtureDefinitions,
  seedDashboardQaFixture,
} from "./support/dashboard-fixture.js";

type Config = ReturnType<typeof readServerConfig>;

function localConfig(): Config {
  const config = readServerConfig();
  const url = new URL(config.supabaseUrl);
  const expectedPort =
    process.env.SHIORI_TEST_SUPABASE_PORT ?? "54321";

  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== expectedPort
  ) {
    throw new Error(
      `test:db is restricted to the Docker-generated local Supabase API on port ${expectedPort}`,
    );
  }
  return config;
}

async function rows(
  config: Config,
  table: string,
  query: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/${table}?select=*${query}`,
    { headers: supabaseHeaders(config.supabaseSecretKey) },
  );
  expect(response.ok).toBe(true);
  const value: unknown = await response.json();
  expect(Array.isArray(value)).toBe(true);
  return value as Array<Record<string, unknown>>;
}

describe("local Supabase dashboard read", () => {
  it("returns a factual summary from the migrated local database", async () => {
    const config = localConfig();
    const repository = new SupabaseDashboardRepository({
      ownerId: config.telegramOwnerUserId,
      ownerTimeZone: config.ownerTimeZone,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const summary = await repository.readSummary();

    expect(summary.counts.active).toBe(summary.commitments.length);
    expect(summary.counts.dueToday).toBeLessThanOrEqual(
      summary.counts.active,
    );
    expect(summary.counts.overdue).toBeLessThanOrEqual(
      summary.counts.active,
    );
    expect(summary.terminalCommitments.length).toBeLessThanOrEqual(10);
    expect(summary.events.length).toBeLessThanOrEqual(20);
    expect(
      summary.sessionHistory.every(
        ({ sessions }) => sessions.length <= 5,
      ),
    ).toBe(true);
    expect(Number.isNaN(Date.parse(summary.updatedAt))).toBe(false);
  });

  it("reads persisted simple, work-session, terminal, and event state without leaking another owner", async () => {
    const config = localConfig();
    const existingCommitments = await rows(
      config,
      "commitments",
      `&owner_id=eq.${config.telegramOwnerUserId}`,
    );
    if (existingCommitments.length > 0) {
      const repository = new SupabaseDashboardRepository({
        ownerId: config.telegramOwnerUserId,
        ownerTimeZone: config.ownerTimeZone,
        supabaseSecretKey: config.supabaseSecretKey,
        supabaseUrl: config.supabaseUrl,
      });
      const summary = await repository.readSummary();
      const expectedActiveIds = existingCommitments
        .filter(({ status }) => status === "active")
        .sort(
          (left, right) =>
            Date.parse(String(left.target_at)) -
              Date.parse(String(right.target_at)) ||
            String(left.id).localeCompare(String(right.id)),
        )
        .map(({ id }) => String(id));

      expect(summary.commitments.map(({ id }) => id)).toEqual(
        expectedActiveIds,
      );
      expect(summary.counts.active).toBe(expectedActiveIds.length);
      expect(summary.terminalCommitments.length).toBeLessThanOrEqual(10);
      expect(summary.events.length).toBeLessThanOrEqual(20);
      expect(
        summary.sessionHistory.every(
          ({ sessions }) => sessions.length <= 5,
        ),
      ).toBe(true);

      const anotherOwner = new SupabaseDashboardRepository({
        ownerId: config.telegramOwnerUserId + 1,
        ownerTimeZone: config.ownerTimeZone,
        supabaseSecretKey: config.supabaseSecretKey,
        supabaseUrl: config.supabaseUrl,
      });
      await expect(anotherOwner.readSummary()).resolves.toMatchObject({
        commitments: [],
        counts: { active: 0, dueToday: 0, overdue: 0 },
        events: [],
        sessionHistory: [],
        terminalCommitments: [],
      });
      return;
    }

    const { summary } = await seedDashboardQaFixture(config, {
      baseUpdateId: 1_911_000_000,
    });
    const simpleId = summary.commitments[0].id;
    const workId = summary.commitments[1].id;
    const doneId = summary.terminalCommitments[0].id;

    expect(summary.counts.active).toBe(2);
    expect(summary.commitments.map(({ id }) => id)).toEqual([
      simpleId,
      workId,
    ]);
    expect(summary.commitments[0]).toMatchObject({
      calendar: {
        attemptedAt: null,
        checkedAt: null,
        kind: "not_needed",
        label: "Calendar check not needed",
      },
      definitionOfDone: dashboardFixtureDefinitions.simple,
      expectedDurationMinutes: null,
      next: {
        kind: "simple_reminder",
        label: "Simple reminder",
      },
    });
    expect(summary.commitments[1]).toMatchObject({
      calendar: {
        checkedAt: null,
        kind: "unverified",
        label: "Saved without a Calendar check",
      },
      definitionOfDone: dashboardFixtureDefinitions.work,
      expectedDurationMinutes: 60,
      next: {
        at: null,
        kind: "continuation_duration",
        label: "Remaining duration needed",
      },
    });
    expect(summary.sessionHistory).toEqual([
      expect.objectContaining({
        commitmentId: workId,
        sessions: [
          expect.objectContaining({
            label: "More work needed",
            status: "more_work_needed",
          }),
        ],
        truncated: false,
      }),
    ]);
    expect(summary.terminalCommitments).toContainEqual(
      expect.objectContaining({
        definitionOfDone: dashboardFixtureDefinitions.done,
        id: doneId,
        label: "Completed",
        status: "done",
      }),
    );
    expect(summary.terminalCommitments.length).toBeLessThanOrEqual(10);
    expect(summary.events.length).toBeLessThanOrEqual(20);
    expect(summary.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commitmentId: workId,
          eventType: "work_session.more_work_needed",
          label: "More work needed recorded",
        }),
        expect.objectContaining({
          commitmentId: doneId,
          eventType: "commitment.done",
          label: "Promise completed",
        }),
      ]),
    );

    const anotherOwner = new SupabaseDashboardRepository({
      ownerId: config.telegramOwnerUserId + 1,
      ownerTimeZone: config.ownerTimeZone,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    await expect(anotherOwner.readSummary()).resolves.toMatchObject({
      commitments: [],
      counts: { active: 0, dueToday: 0, overdue: 0 },
      events: [],
      sessionHistory: [],
      terminalCommitments: [],
    });
  });
});
