import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SupabaseCommitmentChangeRepository,
} from "../src/commitments/approved-change.js";
import {
  SimpleCommitmentActionService,
  SupabaseSimpleCommitmentActionRepository,
} from "../src/commitments/simple-action.js";
import { readServerConfig } from "../src/config.js";
import { SupabaseConfirmationRepository } from "../src/confirmation.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";
import { SupabaseWorkSessionCommitter } from "../src/work-sessions/confirm.js";
import { SupabaseWorkSessionFlowRepository } from "../src/work-sessions/flow-repository.js";

function localConfig() {
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
  supabaseUrl: string,
  secretKey: string,
  table: string,
  query = "",
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${table}?select=*${query}`,
    { headers: supabaseHeaders(secretKey) },
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

function nextBoundary(millis: number): number {
  const halfHour = 30 * 60_000;
  return Math.ceil(millis / halfHour) * halfHour;
}

function audit(fields: DecisionContextFields): DecisionAudit {
  return {
    inputClass: "explicit_commitment",
    modelId: "db-test-model",
    payload: {
      ...fields,
      missingFields: [],
      nextAction: "ready",
      turnRelation: "new_request",
    },
    promptVersion: "db-test-prompt-v1",
  };
}

async function createDraft(
  baseUpdateId: number,
  fields: DecisionContextFields,
) {
  const config = localConfig();
  const telegram = new SupabaseTelegramRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const conversation = new SupabaseConversationRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  await expect(
    telegram.claimUpdate(baseUpdateId, config.telegramOwnerUserId),
  ).resolves.toBe(true);
  const result = await conversation.applyTurn({
    action: "create_draft",
    audit: audit(fields),
    expected: { kind: "none" },
    fields,
    phase: "complete",
    processingResult: "conversation",
    updateId: baseUpdateId,
  });
  expect(result.draftReference).toBeDefined();
  return { config, reference: result.draftReference! };
}

async function createSimple(
  baseUpdateId: number,
  definitionOfDone: string,
  targetAt: string,
) {
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
  const created = await createDraft(baseUpdateId, fields);
  const confirmation = new SupabaseConfirmationRepository({
    ownerId: created.config.telegramOwnerUserId,
    supabaseSecretKey: created.config.supabaseSecretKey,
    supabaseUrl: created.config.supabaseUrl,
  });
  await expect(
    confirmation.resolve({
      action: "confirm",
      chatId: created.config.telegramOwnerUserId,
      draftId: created.reference.id,
      updateId: baseUpdateId + 1,
      version: created.reference.version,
    }),
  ).resolves.toMatchObject({ kind: "confirmed" });
  const commitments = await rows(
    created.config.supabaseUrl,
    created.config.supabaseSecretKey,
    "commitments",
    `&source_draft_id=eq.${created.reference.id}`,
  );
  expect(commitments).toHaveLength(1);
  return {
    ...created,
    commitmentId: String(commitments[0]!.id),
  };
}

async function createWork(
  baseUpdateId: number,
  targetAt: string,
  startAt: string,
) {
  const fields: DecisionContextFields = {
    definitionOfDone: `Finish editable work ${baseUpdateId}`,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: true,
    simpleAction: false,
    targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
  const created = await createDraft(baseUpdateId, fields);
  const flow = new SupabaseWorkSessionFlowRepository({
    ownerId: created.config.telegramOwnerUserId,
    supabaseSecretKey: created.config.supabaseSecretKey,
    supabaseUrl: created.config.supabaseUrl,
  });
  const endAt = singaporeInstant(Date.parse(startAt) + 60 * 60_000);
  const attemptedAt = new Date().toISOString();
  const checkedAt = new Date(Date.now() + 1_000).toISOString();
  const transitioned = await flow.transition({
    calendarAttemptedAt: attemptedAt,
    calendarCheckedAt: checkedAt,
    chatId: created.config.telegramOwnerUserId,
    conflictConsent: false,
    durationMinutes: 60,
    expectedStage: "offer_help",
    finalObservation: "free",
    nextStage: "confirming",
    options: [],
    reference: created.reference,
    selectedWindow: { endAt, startAt },
    timingConstraints: "default",
    updateId: baseUpdateId + 1,
  });
  expect(transitioned.kind).toBe("applied");
  if (transitioned.kind !== "applied") {
    throw new Error("work draft did not transition");
  }
  const committer = new SupabaseWorkSessionCommitter({
    ownerId: created.config.telegramOwnerUserId,
    supabaseSecretKey: created.config.supabaseSecretKey,
    supabaseUrl: created.config.supabaseUrl,
  });
  await expect(
    committer.commit({
      action: "confirm",
      calendar: {
        attemptedAt,
        checkedAt,
        conflictConsent: false,
        finalObservation: "free",
        status: "free",
      },
      chatId: created.config.telegramOwnerUserId,
      definitionOfDone: fields.definitionOfDone!,
      draft: {
        id: transitioned.snapshot.id,
        version: transitioned.snapshot.version,
      },
      durationMinutes: 60,
      expectedStage: "confirming",
      selectedWindow: { endAt, startAt },
      targetAt,
      timingConstraints: "default",
      updateId: baseUpdateId + 2,
    }),
  ).resolves.toEqual({ kind: "applied" });
  const commitments = await rows(
    created.config.supabaseUrl,
    created.config.supabaseSecretKey,
    "commitments",
    `&source_draft_id=eq.${created.reference.id}`,
  );
  expect(commitments).toHaveLength(1);
  return {
    ...created,
    commitmentId: String(commitments[0]!.id),
    definitionOfDone: fields.definitionOfDone!,
  };
}

describe("atomic approved commitment changes on local Supabase", () => {
  it("updates a simple promise once and rejects stale or terminal changes", async () => {
    const base = 9_950_000_000 + randomInt(20_000_000);
    const now = Date.now();
    const initialTarget = singaporeInstant(
      now + 2 * 24 * 60 * 60_000,
    );
    const changedTarget = singaporeInstant(
      now + 3 * 24 * 60 * 60_000,
    );
    const created = await createSimple(
      base,
      `Submit editable simple ${base}`,
      initialTarget,
    );
    const repository = new SupabaseCommitmentChangeRepository({
      ownerId: created.config.telegramOwnerUserId,
      supabaseSecretKey: created.config.supabaseSecretKey,
      supabaseUrl: created.config.supabaseUrl,
    });
    const command = {
      authority: {
        chatId: created.config.telegramOwnerUserId,
        commitmentId: created.commitmentId,
        expectedVersion: 1,
        updateId: base + 2,
      },
      calendar: {
        attemptedAt: null,
        checkedAt: null,
        conflictConsent: false,
        finalObservation: null,
        status: "not_applicable",
      },
      proposal: {
        calendarPolicy: {
          conflict: "reject",
          unavailable: "reject",
        },
        commitmentId: created.commitmentId,
        definitionOfDone: `Submit revised simple ${base}`,
        expectedVersion: 1,
        preparation: {
          nextWorkSession: null,
          required: false,
        },
        targetAt: changedTarget,
      },
    } as const;

    await expect(repository.apply(command)).resolves.toEqual({
      kind: "applied",
      version: 2,
    });
    await expect(repository.apply(command)).resolves.toEqual({
      kind: "replay",
    });
    await expect(
      repository.apply({
        ...command,
        authority: {
          ...command.authority,
          updateId: base + 3,
        },
      }),
    ).resolves.toEqual({ kind: "stale" });

    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "commitments",
        `&id=eq.${created.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        definition_of_done: `Submit revised simple ${base}`,
        preparation_needed: false,
        status: "active",
        version: 2,
      }),
    ]);
    const schedules = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "scheduled_messages",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(schedules).toHaveLength(2);
    expect(
      schedules.map((schedule) => ({
        actionVersion: schedule.action_version,
        dueAt: new Date(String(schedule.due_at)).toISOString(),
        state: schedule.state,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          actionVersion: 1,
          dueAt: new Date(initialTarget).toISOString(),
          state: "cancelled",
        },
        {
          actionVersion: 2,
          dueAt: new Date(changedTarget).toISOString(),
          state: "pending",
        },
      ]),
    );
    const changeEvents = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "commitment_events",
      `&commitment_id=eq.${created.commitmentId}&event_type=eq.commitment.changed`,
    );
    expect(changeEvents).toEqual([
      expect.objectContaining({
        metadata: {
          changedFields: ["definition", "target"],
          previousVersion: 1,
          version: 2,
        },
      }),
    ]);
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "approved_commitment_change_receipts",
        `&commitment_id=eq.${created.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        applied_version: 2,
        expected_version: 1,
        update_id: base + 2,
      }),
    ]);

    const actions = new SimpleCommitmentActionService({
      repository: new SupabaseSimpleCommitmentActionRepository({
        ownerId: created.config.telegramOwnerUserId,
        supabaseSecretKey: created.config.supabaseSecretKey,
        supabaseUrl: created.config.supabaseUrl,
      }),
    });
    await expect(
      actions.handle(
        base + 4,
        created.config.telegramOwnerUserId,
        `p:${created.commitmentId}:2:done`,
      ),
    ).resolves.toEqual({ text: "Promise completed." });
    await expect(
      repository.apply({
        ...command,
        authority: {
          ...command.authority,
          expectedVersion: 2,
          updateId: base + 5,
        },
        proposal: {
          ...command.proposal,
          expectedVersion: 2,
        },
      }),
    ).resolves.toEqual({ kind: "terminal" });
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "commitments",
        `&id=eq.${created.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        status: "done",
        version: 2,
      }),
    ]);
  });

  it("replaces the planned work graph in one versioned transaction", async () => {
    const base = 9_975_000_000 + randomInt(20_000_000);
    const now = Date.now();
    const initialStart = singaporeInstant(
      nextBoundary(now + 4 * 60 * 60_000),
    );
    const targetAt = singaporeInstant(
      now + 3 * 24 * 60 * 60_000,
    );
    const created = await createWork(base, targetAt, initialStart);
    const beforeSessions = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(beforeSessions).toHaveLength(1);
    const previousSessionId = String(beforeSessions[0]!.id);
    const changedStart = singaporeInstant(
      nextBoundary(now + 8 * 60 * 60_000),
    );
    const changedEnd = singaporeInstant(
      Date.parse(changedStart) + 90 * 60_000,
    );
    const attemptedAt = new Date(now + 2_000).toISOString();
    const checkedAt = new Date(now + 3_000).toISOString();
    const repository = new SupabaseCommitmentChangeRepository({
      ownerId: created.config.telegramOwnerUserId,
      supabaseSecretKey: created.config.supabaseSecretKey,
      supabaseUrl: created.config.supabaseUrl,
    });

    await expect(
      repository.apply({
        authority: {
          chatId: created.config.telegramOwnerUserId,
          commitmentId: created.commitmentId,
          expectedVersion: 1,
          updateId: base + 3,
        },
        calendar: {
          attemptedAt,
          checkedAt,
          conflictConsent: false,
          finalObservation: "free",
          status: "free",
        },
        proposal: {
          calendarPolicy: {
            conflict: "reject",
            unavailable: "reject",
          },
          commitmentId: created.commitmentId,
          definitionOfDone: created.definitionOfDone,
          expectedVersion: 1,
          preparation: {
            nextWorkSession: {
              durationMinutes: 90,
              endAt: changedEnd,
              startAt: changedStart,
              timingConstraints: "Owner-approved revised window",
            },
            required: true,
          },
          targetAt,
        },
      }),
    ).resolves.toEqual({ kind: "applied", version: 2 });

    const sessions = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: previousSessionId,
          status: "cancelled",
        }),
        expect.objectContaining({
          calendar_status: "free",
          duration_minutes: 90,
          sequence_number: 2,
          status: "planned",
          timing_constraints: "Owner-approved revised window",
        }),
      ]),
    );
    const newSession = sessions.find(
      (session) => session.status === "planned",
    );
    expect(newSession).toBeDefined();
    expect(new Date(String(newSession!.start_at)).toISOString()).toBe(
      new Date(changedStart).toISOString(),
    );
    expect(new Date(String(newSession!.end_at)).toISOString()).toBe(
      new Date(changedEnd).toISOString(),
    );

    const schedules = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "scheduled_messages",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(
      schedules.filter(
        (schedule) =>
          schedule.work_session_id === previousSessionId,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work_session_start",
          state: "cancelled",
        }),
        expect.objectContaining({
          kind: "work_session_end",
          state: "cancelled",
        }),
      ]),
    );
    expect(
      schedules.filter(
        (schedule) => schedule.work_session_id === newSession!.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "work_session_start",
          state: "pending",
        }),
        expect.objectContaining({
          kind: "work_session_end",
          state: "pending",
        }),
      ]),
    );
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "commitment_events",
        `&commitment_id=eq.${created.commitmentId}&event_type=eq.commitment.changed`,
      ),
    ).toEqual([
      expect.objectContaining({
        metadata: {
          changedFields: ["next_work_session"],
          previousVersion: 1,
          version: 2,
        },
      }),
    ]);
  });
});
