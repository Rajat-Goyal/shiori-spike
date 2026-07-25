import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SupabaseSimpleCommitmentActionRepository,
} from "../src/commitments/simple-action.js";
import {
  SupabaseConfirmationRepository,
} from "../src/confirmation.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import { readServerConfig } from "../src/config.js";
import { SupabaseDashboardRepository } from "../src/dashboard.js";
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";
import { SupabaseWorkSessionCommitter } from "../src/work-sessions/confirm.js";
import { SupabaseWorkSessionFlowRepository } from "../src/work-sessions/flow-repository.js";
import { SupabaseWorkSessionOutcomeRepository } from "../src/work-sessions/outcomes.js";

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

function singaporeInstant(millis: number): string {
  return `${new Date(millis + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

function nextHalfHour(millis: number): number {
  const halfHour = 30 * 60_000;
  return Math.ceil(millis / halfHour) * halfHour;
}

function audit(fields: DecisionContextFields): DecisionAudit {
  return {
    inputClass: "explicit_commitment",
    modelId: "dashboard-db-test-model",
    payload: {
      ...fields,
      missingFields: [],
      nextAction: "ready",
      turnRelation: "new_request",
    },
    promptVersion: "dashboard-db-test-v1",
  };
}

async function createDraft(
  config: Config,
  updateId: number,
  fields: DecisionContextFields,
) {
  const telegram = new SupabaseTelegramRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const conversation = new SupabaseConversationRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  await expect(
    telegram.claimUpdate(updateId, config.telegramOwnerUserId),
  ).resolves.toBe(true);
  const result = await conversation.applyTurn({
    action: "create_draft",
    audit: audit(fields),
    expected: { kind: "none" },
    fields,
    phase: "complete",
    processingResult: "conversation",
    updateId,
  });
  expect(result.draftReference).toBeDefined();
  return result.draftReference!;
}

async function commitmentForDraft(
  config: Config,
  draftId: string,
): Promise<string> {
  const commitments = await rows(
    config,
    "commitments",
    `&source_draft_id=eq.${draftId}`,
  );
  expect(commitments).toHaveLength(1);
  return String(commitments[0].id);
}

async function createSimpleCommitment(
  config: Config,
  updateId: number,
  definitionOfDone: string,
  targetAt: string,
): Promise<string> {
  const fields: DecisionContextFields = {
    definitionOfDone,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: false,
    simpleAction: true,
    targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
  const draft = await createDraft(config, updateId, fields);
  const confirmation = new SupabaseConfirmationRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  await expect(
    confirmation.resolve({
      action: "confirm",
      chatId: config.telegramOwnerUserId,
      draftId: draft.id,
      updateId: updateId + 1,
      version: draft.version,
    }),
  ).resolves.toMatchObject({ kind: "confirmed" });
  return commitmentForDraft(config, draft.id);
}

async function createUnverifiedWorkCommitment(
  config: Config,
  updateId: number,
  definitionOfDone: string,
  targetAt: string,
  startAt: string,
) {
  const fields: DecisionContextFields = {
    definitionOfDone,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: true,
    simpleAction: false,
    targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
  const draft = await createDraft(config, updateId, fields);
  const startMillis = Date.parse(startAt);
  const selectedWindow = {
    endAt: singaporeInstant(startMillis + 60 * 60_000),
    startAt,
  };
  const attemptedAt = new Date().toISOString();
  const flow = new SupabaseWorkSessionFlowRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const transition = await flow.transition({
    calendarAttemptedAt: attemptedAt,
    calendarCheckedAt: null,
    chatId: config.telegramOwnerUserId,
    conflictConsent: false,
    durationMinutes: 60,
    expectedStage: "offer_help",
    finalObservation: "unavailable",
    nextStage: "unverified_confirming",
    options: [],
    reference: draft,
    selectedWindow,
    timingConstraints: "default",
    updateId: updateId + 1,
  });
  expect(transition.kind).toBe("applied");
  if (transition.kind !== "applied") {
    throw new Error("work-session draft did not transition");
  }

  const committer = new SupabaseWorkSessionCommitter({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  await expect(
    committer.commit({
      action: "save_unverified",
      calendar: {
        attemptedAt,
        checkedAt: null,
        conflictConsent: false,
        finalObservation: "unavailable",
        status: "unverified",
      },
      chatId: config.telegramOwnerUserId,
      definitionOfDone,
      draft: {
        id: transition.snapshot.id,
        version: transition.snapshot.version,
      },
      durationMinutes: 60,
      expectedStage: "unverified_confirming",
      selectedWindow,
      targetAt,
      timingConstraints: "default",
      updateId: updateId + 2,
    }),
  ).resolves.toEqual({ kind: "applied" });

  const commitmentId = await commitmentForDraft(config, draft.id);
  const sessions = await rows(
    config,
    "work_sessions",
    `&commitment_id=eq.${commitmentId}`,
  );
  expect(sessions).toHaveLength(1);
  return {
    commitmentId,
    sessionId: String(sessions[0].id),
  };
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

    const base = 9_900_000_000 + randomInt(10_000_000);
    const now = Date.now();
    const simpleDefinition = `Dashboard simple ${base}`;
    const workDefinition = `Dashboard work ${base}`;
    const doneDefinition = `Dashboard done ${base}`;
    const simpleTarget = singaporeInstant(now + 24 * 60 * 60_000);
    const workTarget = singaporeInstant(now + 72 * 60 * 60_000);

    const simpleId = await createSimpleCommitment(
      config,
      base,
      simpleDefinition,
      simpleTarget,
    );
    const doneId = await createSimpleCommitment(
      config,
      base + 10,
      doneDefinition,
      singaporeInstant(now + 48 * 60 * 60_000),
    );
    const done = new SupabaseSimpleCommitmentActionRepository({
      ownerId: config.telegramOwnerUserId,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    await expect(
      done.resolve({
        action: "done",
        chatId: config.telegramOwnerUserId,
        commitmentId: doneId,
        updateId: base + 12,
        version: 1,
      }),
    ).resolves.toMatchObject({ kind: "done" });

    const work = await createUnverifiedWorkCommitment(
      config,
      base + 20,
      workDefinition,
      workTarget,
      singaporeInstant(nextHalfHour(now + 6 * 60 * 60_000)),
    );
    const outcome = new SupabaseWorkSessionOutcomeRepository({
      ownerId: config.telegramOwnerUserId,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    await expect(
      outcome.resolve({
        action: "more",
        chatId: config.telegramOwnerUserId,
        sessionId: work.sessionId,
        updateId: base + 23,
        version: 1,
      }),
    ).resolves.toMatchObject({ kind: "more" });

    const repository = new SupabaseDashboardRepository({
      ownerId: config.telegramOwnerUserId,
      ownerTimeZone: config.ownerTimeZone,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const summary = await repository.readSummary();

    expect(summary.counts.active).toBe(2);
    expect(summary.commitments.map(({ id }) => id)).toEqual([
      simpleId,
      work.commitmentId,
    ]);
    expect(summary.commitments[0]).toMatchObject({
      calendar: {
        attemptedAt: null,
        checkedAt: null,
        kind: "not_needed",
        label: "Calendar check not needed",
      },
      definitionOfDone: simpleDefinition,
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
      definitionOfDone: workDefinition,
      expectedDurationMinutes: 60,
      next: {
        at: null,
        kind: "continuation_duration",
        label: "Remaining duration needed",
      },
    });
    expect(summary.sessionHistory).toEqual([
      expect.objectContaining({
        commitmentId: work.commitmentId,
        sessions: [
          expect.objectContaining({
            id: work.sessionId,
            label: "More work needed",
            status: "more_work_needed",
          }),
        ],
        truncated: false,
      }),
    ]);
    expect(summary.terminalCommitments).toContainEqual(
      expect.objectContaining({
        definitionOfDone: doneDefinition,
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
          commitmentId: work.commitmentId,
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
