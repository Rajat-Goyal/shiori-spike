import { randomInt } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SupabaseAgentContextReader } from "../src/agent/context-reader.js";
import { readServerConfig } from "../src/config.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";
import { SupabaseWorkSessionCommitter } from "../src/work-sessions/confirm.js";
import type {
  WorkSessionCommitRequest,
  WorkSessionDraftSnapshot,
} from "../src/work-sessions/flow.js";
import { WorkSessionFlow } from "../src/work-sessions/flow.js";
import { SupabaseWorkSessionFlowRepository } from "../src/work-sessions/flow-repository.js";
import {
  SupabaseWorkSessionOutcomeRepository,
} from "../src/work-sessions/outcomes.js";
import {
  SupabaseWorkSessionContinuationRepository,
  WorkSessionContinuationService,
} from "../src/work-sessions/continuation.js";
import {
  SupabaseWorkSessionMessageRepository,
} from "../src/work-sessions/notifications.js";

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

function nextBoundary(afterMillis: number): number {
  const halfHour = 30 * 60_000;
  return Math.ceil(afterMillis / halfHour) * halfHour;
}

type ConfirmationOutcome =
  | "conflict_cleared"
  | "conflict_kept"
  | "free"
  | "unverified";

async function preparedDraft(
  outcome: ConfirmationOutcome,
  baseUpdateId: number,
  durationMinutes = 60,
): Promise<{
  config: ReturnType<typeof localConfig>;
  request: WorkSessionCommitRequest;
  snapshot: WorkSessionDraftSnapshot;
}> {
  const config = localConfig();
  const telegram = new SupabaseTelegramRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const conversation = new SupabaseConversationRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const flow = new SupabaseWorkSessionFlowRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const now = Date.now();
  const startMillis = nextBoundary(now + 4 * 60 * 60_000);
  const selectedWindow = {
    endAt: singaporeInstant(
      startMillis + durationMinutes * 60_000,
    ),
    startAt: singaporeInstant(startMillis),
  };
  const fields: DecisionContextFields = {
    definitionOfDone: `Finish atomic session ${baseUpdateId}`,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: true,
    simpleAction: false,
    targetAt: singaporeInstant(now + 3 * 24 * 60 * 60_000),
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
  const audit: DecisionAudit = {
    inputClass: "explicit_commitment",
    modelId: "db-test-model",
    payload: {
      ...fields,
      missingFields: [],
      nextAction: "offer_work_window",
      turnRelation: "new_request",
    },
    promptVersion: "db-test-prompt-v1",
  };

  await expect(
    telegram.claimUpdate(
      baseUpdateId,
      config.telegramOwnerUserId,
    ),
  ).resolves.toBe(true);
  const created = await conversation.applyTurn({
    action: "create_draft",
    audit,
    expected: { kind: "none" },
    fields,
    phase: "complete",
    processingResult: "conversation",
    updateId: baseUpdateId,
  });
  expect(created.draftReference).toBeDefined();
  const initial = created.draftReference!;
  const attemptedAt = new Date(now + 1_000).toISOString();
  const checkedAt =
    outcome === "unverified"
      ? null
      : new Date(now + 2_000).toISOString();
  const expectedStage =
    outcome === "free"
      ? "confirming"
      : outcome === "conflict_kept" || outcome === "conflict_cleared"
        ? "conflict_confirming"
        : "unverified_confirming";
  const transitioned = await flow.transition({
    calendarAttemptedAt: attemptedAt,
    calendarCheckedAt: checkedAt,
    chatId: config.telegramOwnerUserId,
    conflictConsent:
      outcome === "conflict_kept" || outcome === "conflict_cleared",
    durationMinutes,
    expectedStage: "offer_help",
    finalObservation:
      outcome === "unverified"
        ? "unavailable"
        : outcome === "conflict_kept" || outcome === "conflict_cleared"
          ? "conflict"
          : "free",
    nextStage: expectedStage,
    options: [],
    reference: initial,
    selectedWindow,
    timingConstraints: "default",
    updateId: baseUpdateId + 1,
  });
  expect(transitioned.kind).toBe("applied");
  if (transitioned.kind !== "applied") {
    throw new Error("work-session draft preparation failed");
  }
  const snapshot = transitioned.snapshot;
  const finalObservation =
    outcome === "unverified"
      ? "unavailable"
      : outcome === "conflict_kept"
        ? "conflict"
        : "free";
  const calendarStatus =
    outcome === "conflict_cleared" ? "free" : outcome;
  return {
    config,
    request: {
      action:
        outcome === "unverified" ? "save_unverified" : "confirm",
      calendar: {
        attemptedAt:
          outcome === "unverified"
            ? attemptedAt
            : new Date(now + 3_000).toISOString(),
        checkedAt:
          outcome === "unverified"
            ? null
            : new Date(now + 4_000).toISOString(),
        conflictConsent:
          outcome === "conflict_kept" || outcome === "conflict_cleared",
        finalObservation,
        status: calendarStatus,
      },
      chatId: config.telegramOwnerUserId,
      definitionOfDone: snapshot.definitionOfDone,
      draft: { id: snapshot.id, version: snapshot.version },
      durationMinutes,
      expectedStage,
      selectedWindow,
      targetAt: snapshot.targetAt,
      timingConstraints: "default",
      updateId: baseUpdateId + 2,
    },
    snapshot,
  };
}

function committer(
  prepared: Awaited<ReturnType<typeof preparedDraft>>,
) {
  return new SupabaseWorkSessionCommitter({
    ownerId: prepared.config.telegramOwnerUserId,
    supabaseSecretKey: prepared.config.supabaseSecretKey,
    supabaseUrl: prepared.config.supabaseUrl,
  });
}

describe("atomic work-session confirmation on local Supabase", () => {
  it("persists exactly one 45-minute next session and its two scheduler consequences", async () => {
    const baseUpdateId =
      9_550_000_000 + randomInt(40_000_000);
    const prepared = await preparedDraft(
      "free",
      baseUpdateId,
      45,
    );

    await expect(
      committer(prepared).commit(prepared.request),
    ).resolves.toEqual({ kind: "applied" });

    const commitments = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "commitments",
      `&definition_of_done=eq.${encodeURIComponent(prepared.request.definitionOfDone)}`,
    );
    expect(commitments).toHaveLength(1);
    const commitmentId = commitments[0]!.id;
    const sessions = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitmentId}`,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      duration_minutes: 45,
    });
    expect(Date.parse(String(sessions[0]!.start_at))).toBe(
      Date.parse(prepared.request.selectedWindow.startAt),
    );
    expect(Date.parse(String(sessions[0]!.end_at))).toBe(
      Date.parse(prepared.request.selectedWindow.endAt),
    );
    const messages = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "scheduled_messages",
      `&commitment_id=eq.${commitmentId}`,
    );
    expect(messages).toHaveLength(2);
    expect(messages.map((item) => item.kind).sort()).toEqual([
      "work_session_end",
      "work_session_start",
    ]);
  });

  it.each([
    "free",
    "conflict_cleared",
    "conflict_kept",
    "unverified",
  ] satisfies ConfirmationOutcome[])(
    "creates the exact scheduler graph once for %s",
    async (outcome) => {
      const baseUpdateId =
        9_600_000_000 + randomInt(50_000_000);
      const prepared = await preparedDraft(outcome, baseUpdateId);
      const googleBefore = await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "google_calendar_connection",
      );

      await expect(
        committer(prepared).commit(prepared.request),
      ).resolves.toEqual({ kind: "applied" });
      await expect(
        committer(prepared).commit(prepared.request),
      ).resolves.toEqual({ kind: "replay" });

      const commitments = await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitments",
        `&source_draft_id=eq.${prepared.snapshot.id}`,
      );
      expect(commitments).toHaveLength(1);
      expect(commitments[0]).toMatchObject({
        definition_of_done: prepared.snapshot.definitionOfDone,
        status: "active",
      });
      const commitmentId = String(commitments[0].id);
      const sessions = await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&commitment_id=eq.${commitmentId}`,
      );
      expect(sessions).toEqual([
        expect.objectContaining({
          calendar_status: prepared.request.calendar.status,
          commitment_id: commitmentId,
          conflict_consent:
            prepared.request.calendar.conflictConsent,
          duration_minutes: 60,
          final_calendar_observation:
            prepared.request.calendar.finalObservation,
          sequence_number: 1,
          status: "planned",
        }),
      ]);
      expect(
        new Date(String(sessions[0].calendar_attempted_at)).toISOString(),
      ).toBe(prepared.request.calendar.attemptedAt);
      expect(
        sessions[0].calendar_checked_at === null
          ? null
          : new Date(
              String(sessions[0].calendar_checked_at),
            ).toISOString(),
      ).toBe(prepared.request.calendar.checkedAt);
      const sessionId = String(sessions[0].id);
      const schedules = await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "scheduled_messages",
        `&work_session_id=eq.${sessionId}`,
      );
      expect(schedules).toHaveLength(2);
      expect(
        schedules
          .map((schedule) => ({
            attemptCount: schedule.attempt_count,
            commitmentId: schedule.commitment_id,
            deliveryStartedAt: schedule.delivery_started_at,
            dueAt: new Date(String(schedule.due_at)).toISOString(),
            kind: schedule.kind,
            lastErrorClass: schedule.last_error_class,
            leaseToken: schedule.lease_token,
            logicalKey: schedule.logical_key,
            nextAttemptAt: schedule.next_attempt_at,
            state: schedule.state,
            telegramMessageId: schedule.telegram_message_id,
            workSessionId: schedule.work_session_id,
          }))
          .sort((a, b) => String(a.kind).localeCompare(String(b.kind))),
      ).toEqual([
        {
          attemptCount: 0,
          commitmentId,
          deliveryStartedAt: null,
          dueAt: new Date(
            prepared.request.selectedWindow.endAt,
          ).toISOString(),
          kind: "work_session_end",
          lastErrorClass: null,
          leaseToken: null,
          logicalKey: `ws:${sessionId}:end`,
          nextAttemptAt: null,
          state: "pending",
          telegramMessageId: null,
          workSessionId: sessionId,
        },
        {
          attemptCount: 0,
          commitmentId,
          deliveryStartedAt: null,
          dueAt: new Date(
            prepared.request.selectedWindow.startAt,
          ).toISOString(),
          kind: "work_session_start",
          lastErrorClass: null,
          leaseToken: null,
          logicalKey: `ws:${sessionId}:start`,
          nextAttemptAt: null,
          state: "pending",
          telegramMessageId: null,
          workSessionId: sessionId,
        },
      ]);
      const events = await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitment_events",
        `&commitment_id=eq.${commitmentId}`,
      );
      expect(events).toHaveLength(4);
      expect(
        events.map((event) => event.event_type).sort(),
      ).toEqual([
        "commitment.created",
        "scheduled_message.created",
        "scheduled_message.created",
        "work_session.created",
      ]);
      expect(
        await rows(
          prepared.config.supabaseUrl,
          prepared.config.supabaseSecretKey,
          "telegram_updates",
          `&update_id=eq.${prepared.request.updateId}`,
        ),
      ).toEqual([
        expect.objectContaining({
          processing_result: "work_session_confirmed",
          processing_status: "processed",
          resolved_action_key:
            `w:${prepared.request.draft.id}:` +
            `${prepared.request.draft.version}:` +
            prepared.request.action,
        }),
      ]);
      expect(
        await rows(
          prepared.config.supabaseUrl,
          prepared.config.supabaseSecretKey,
          "google_calendar_connection",
        ),
      ).toEqual(googleBefore);
    },
  );

  it("serializes concurrent confirmation into applied and resolved", async () => {
    const baseUpdateId =
      9_660_000_000 + randomInt(20_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    const second = {
      ...prepared.request,
      updateId: prepared.request.updateId + 1,
    };

    const results = await Promise.all([
      committer(prepared).commit(prepared.request),
      committer(prepared).commit(second),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "applied",
      "resolved",
    ]);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitments",
        `&source_draft_id=eq.${prepared.snapshot.id}`,
      ),
    ).toHaveLength(1);
    const concurrentUpdates = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "telegram_updates",
      `&update_id=in.(${prepared.request.updateId},${second.updateId})`,
    );
    expect(
      concurrentUpdates.filter(
        (update) => update.resolved_action_key !== null,
      ),
    ).toHaveLength(1);
  });

  it("rolls back the claimed update and every consequence on failure", async () => {
    const baseUpdateId =
      9_680_000_000 + randomInt(10_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    const response = await fetch(
      `${prepared.config.supabaseUrl}/rest/v1/rpc/confirm_work_session`,
      {
        body: JSON.stringify({
          p_action: "confirm",
          p_calendar_attempted_at:
            prepared.request.calendar.attemptedAt,
          p_calendar_checked_at: null,
          p_calendar_status: "free",
          p_conflict_consent: false,
          p_draft_id: prepared.request.draft.id,
          p_expected_stage: "confirming",
          p_final_observation: "free",
          p_owner_chat_id: prepared.request.chatId,
          p_owner_id: String(prepared.request.chatId),
          p_update_id: prepared.request.updateId,
          p_version: prepared.request.draft.version,
        }),
        headers: supabaseHeaders(
          prepared.config.supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
      },
    );
    expect(response.ok).toBe(false);

    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitments",
        `&source_draft_id=eq.${prepared.snapshot.id}`,
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "telegram_updates",
        `&update_id=eq.${prepared.request.updateId}`,
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "conversation_drafts",
        `&id=eq.${prepared.snapshot.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        resolved_update_id: null,
        state: "active",
        work_session_stage: "confirming",
      }),
    ]);

    const cleanup = new SupabaseWorkSessionFlowRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    await expect(
      cleanup.cancel(
        prepared.request.updateId + 1,
        prepared.request.chatId,
        prepared.request.draft,
        "confirming",
      ),
    ).resolves.toMatchObject({ kind: "applied" });
  });
});

describe("atomic work-session outcome and continuation on local Supabase", () => {
  it("advances same-message preparation facts from the processed creation turn without replaying the update", async () => {
    const baseUpdateId =
      9_760_000_000 + randomInt(4_000_000);
    const config = localConfig();
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const flowRepository = new SupabaseWorkSessionFlowRepository({
      ownerId: config.telegramOwnerUserId,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const now = Date.now();
    const startMillis = nextBoundary(now + 8 * 60 * 60_000);
    const option = {
      endAt: singaporeInstant(startMillis + 45 * 60_000),
      startAt: singaporeInstant(startMillis),
    };
    const fields: DecisionContextFields = {
      definitionOfDone: `Same-message preparation ${baseUpdateId}`,
      durationMinutes: 45,
      offerWorkWindowHelp: false,
      possibleWorkSession: true,
      simpleAction: false,
      targetAt: singaporeInstant(now + 3 * 24 * 60 * 60_000),
      targetTimeZone: "Asia/Singapore",
      timingConstraints: ["mon 08:00-12:00"],
    };
    const audit: DecisionAudit = {
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

    await expect(
      telegram.claimUpdate(baseUpdateId, config.telegramOwnerUserId),
    ).resolves.toBe(true);
    const focus = await conversation.readTurn(baseUpdateId);
    if (focus.kind !== "none" && focus.kind !== "draft") {
      throw new Error("same-message test requires an available draft focus");
    }
    const created = await conversation.applyTurn({
      action:
        focus.kind === "none"
          ? "create_draft"
          : "create_separate_draft",
      audit,
      expected:
        focus.kind === "none"
          ? focus
          : {
              id: focus.id,
              kind: focus.kind,
              version: focus.version,
            },
      fields,
      phase: "complete",
      processingResult: "conversation",
      updateId: baseUpdateId,
    });
    expect(created).toMatchObject({
      draftCreated: true,
      status: "applied",
    });
    const flow = new WorkSessionFlow({
      availability: vi.fn(async () => ({
        alternatives: [option],
        checkedAt: new Date().toISOString(),
        proposed: null,
        status: "available" as const,
      })),
      committer: {
        commit: vi.fn(async () => ({ kind: "stale" as const })),
      },
      repository: flowRepository,
    });

    const reply = await flow.handleConversationInput(
      baseUpdateId,
      config.telegramOwnerUserId,
      {
        draftId: created.draftReference!.id,
        draftVersion: created.draftReference!.version,
        durationMinutes: 45,
        followUpQuestion: null,
        nextInput: null,
        preparationRequired: true,
        startAt: null,
        timingConstraints: "mon 08:00-12:00",
      },
    );
    expect(reply.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Choose option 1" }),
      ]),
    );
    await expect(
      telegram.claimUpdate(baseUpdateId, config.telegramOwnerUserId),
    ).resolves.toBe(false);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "telegram_updates",
        `&update_id=eq.${baseUpdateId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        processing_status: "processed",
        processing_result: "work_session_draft_resolved",
        resolved_action_key:
          `w:${created.draftReference!.id}:` +
          `${created.draftReference!.version}:apply`,
      }),
    ]);
    const current = await flowRepository.read({
      id: created.draftReference!.id,
      version: created.draftReference!.version + 1,
    });
    expect(current).toMatchObject({
      kind: "current",
      snapshot: {
        durationMinutes: 45,
        options: [option],
        stage: "choosing",
      },
    });
    if (current.kind !== "current") {
      throw new Error("same-message preparation was not persisted");
    }
    await flowRepository.cancel(
      baseUpdateId + 1,
      config.telegramOwnerUserId,
      {
        id: current.snapshot.id,
        version: current.snapshot.version,
      },
      current.snapshot.stage,
    );
  });

  it("persists exact 45- and 1440-minute windows and rejects a :15 start at the database boundary", async () => {
    for (const [index, durationMinutes] of [45, 1_440].entries()) {
      const baseUpdateId =
        9_740_000_000 + randomInt(4_000_000) + index * 10;
      const prepared = await preparedDraft(
        "free",
        baseUpdateId,
        durationMinutes,
      );
      await expect(
        committer(prepared).commit(prepared.request),
      ).resolves.toEqual({ kind: "applied" });
      const [session] = await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&duration_minutes=eq.${durationMinutes}` +
          `&start_at=eq.${encodeURIComponent(prepared.request.selectedWindow.startAt)}`,
      );
      expect(session).toMatchObject({
        duration_minutes: durationMinutes,
        status: "planned",
      });
      expect(
        Date.parse(String(session.end_at)) -
          Date.parse(String(session.start_at)),
      ).toBe(durationMinutes * 60_000);

      if (durationMinutes === 45) {
        const invalidStart = new Date(
          Date.parse(String(session.start_at)) + 15 * 60_000,
        ).toISOString();
        const invalidEnd = new Date(
          Date.parse(invalidStart) + 45 * 60_000,
        ).toISOString();
        const response = await fetch(
          `${prepared.config.supabaseUrl}/rest/v1/work_sessions?id=eq.${session.id}`,
          {
            body: JSON.stringify({
              end_at: invalidEnd,
              start_at: invalidStart,
            }),
            headers: supabaseHeaders(
              prepared.config.supabaseSecretKey,
              "application/json",
            ),
            method: "PATCH",
          },
        );
        expect(response.ok).toBe(false);
      }
    }
  });

  it("terminally finalizes unsupported and stale typed preparation updates exactly once", async () => {
    const baseUpdateId =
      9_750_000_000 + randomInt(4_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    const flowRepository = new SupabaseWorkSessionFlowRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    const flow = new WorkSessionFlow({
      availability: vi.fn(),
      committer: {
        commit: vi.fn(async () => ({ kind: "stale" as const })),
      },
      repository: flowRepository,
    });
    const typedInput = {
      draftId: prepared.snapshot.id,
      draftVersion: prepared.snapshot.version,
      durationMinutes: 45,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: true,
      startAt: null,
      timingConstraints: "mon 08:00-12:00",
    } as const;

    await expect(
      telegram.claimUpdate(
        baseUpdateId + 20,
        prepared.config.telegramOwnerUserId,
      ),
    ).resolves.toBe(true);
    await expect(
      flow.handleConversationInput(
        baseUpdateId + 20,
        prepared.config.telegramOwnerUserId,
        typedInput,
      ),
    ).resolves.toMatchObject({
      text: "That action is stale. I didn’t change anything.",
    });
    await expect(
      telegram.claimUpdate(
        baseUpdateId + 20,
        prepared.config.telegramOwnerUserId,
      ),
    ).resolves.toBe(false);

    await expect(
      telegram.claimUpdate(
        baseUpdateId + 21,
        prepared.config.telegramOwnerUserId,
      ),
    ).resolves.toBe(true);
    await flow.handleConversationInput(
      baseUpdateId + 21,
      prepared.config.telegramOwnerUserId,
      { ...typedInput, draftVersion: typedInput.draftVersion - 1 },
    );

    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "telegram_updates",
        `&update_id=in.(${baseUpdateId + 20},${baseUpdateId + 21})`,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          processing_result: "unsupported",
          processing_status: "processed",
          update_id: baseUpdateId + 20,
        }),
        expect.objectContaining({
          processing_result: "work_session_draft_stale",
          processing_status: "processed",
          update_id: baseUpdateId + 21,
        }),
      ]),
    );
    await expect(
      flowRepository.cancel(
        baseUpdateId + 22,
        prepared.config.telegramOwnerUserId,
        {
          id: prepared.snapshot.id,
          version: prepared.snapshot.version,
        },
        prepared.snapshot.stage,
      ),
    ).resolves.toMatchObject({ kind: "applied" });
  });

  it("claims each start message once and safely reclaims an unstarted expired lease", async () => {
    const baseUpdateId =
      9_690_000_000 + randomInt(10_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    await committer(prepared).commit(prepared.request);
    const repository = () =>
      new SupabaseWorkSessionMessageRepository({
        supabaseSecretKey: prepared.config.supabaseSecretKey,
        supabaseUrl: prepared.config.supabaseUrl,
      });
    const dueAt = new Date(
      prepared.request.selectedWindow.startAt,
    );
    const [commitment] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "commitments",
      `&source_draft_id=eq.${prepared.snapshot.id}`,
    );

    const concurrent = await Promise.all([
      repository().claimDue(dueAt, 20),
      repository().claimDue(dueAt, 20),
    ]);
    const ownClaims = concurrent
      .flat()
      .filter(
        (message) =>
          message.commitmentId === String(commitment.id) &&
          message.kind === "work_session_start",
      );
    expect(ownClaims).toHaveLength(1);
    const first = ownClaims[0];
    expect(first).toMatchObject({
      attemptCount: 1,
      kind: "work_session_start",
    });

    const reclaimed = await repository().claimDue(
      new Date(dueAt.getTime() + 31_000),
      20,
    );
    const ownReclaimed = reclaimed.find(
      (message) => message.id === first.id,
    );
    expect(ownReclaimed).toMatchObject({
      attemptCount: 1,
      id: first.id,
    });
    expect(ownReclaimed!.leaseToken).not.toBe(first.leaseToken);

    const current = repository();
    await current.beginDelivery(
      ownReclaimed!,
      new Date(dueAt.getTime() + 32_000),
    );
    await current.recordResult({
      attemptCount: ownReclaimed!.attemptCount,
      leaseToken: ownReclaimed!.leaseToken,
      messageId: ownReclaimed!.id,
      recordedAt: new Date(dueAt.getTime() + 33_000),
      result: "delivered",
      telegramMessageId: 991,
    });

    const [session] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitment.id}`,
    );
    expect(session.status).toBe("started");
  });

  it("Done before a planned session closes once and suppresses both unsent messages", async () => {
    const baseUpdateId =
      9_695_000_000 + randomInt(10_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    await committer(prepared).commit(prepared.request);
    const [commitment] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "commitments",
      `&source_draft_id=eq.${prepared.snapshot.id}`,
    );
    const [session] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitment.id}`,
    );
    const outcome = new SupabaseWorkSessionOutcomeRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });

    await expect(
      outcome.resolve({
        action: "done",
        chatId: prepared.config.telegramOwnerUserId,
        sessionId: String(session.id),
        updateId: baseUpdateId + 3,
        version: 1,
      }),
    ).resolves.toMatchObject({ kind: "done" });
    await expect(
      outcome.resolve({
        action: "done",
        chatId: prepared.config.telegramOwnerUserId,
        sessionId: String(session.id),
        updateId: baseUpdateId + 3,
        version: 1,
      }),
    ).resolves.toEqual({ kind: "replay" });

    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitments",
        `&id=eq.${commitment.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        completed_at: expect.any(String),
        status: "done",
      }),
    ]);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&id=eq.${session.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        outcome_at: expect.any(String),
        status: "cancelled",
      }),
    ]);
    expect(
      (
        await rows(
          prepared.config.supabaseUrl,
          prepared.config.supabaseSecretKey,
          "scheduled_messages",
          `&work_session_id=eq.${session.id}`,
        )
      ).map((message) => message.state),
    ).toEqual(["cancelled", "cancelled"]);
  });

  it("records a typed 45-minute continuation, then appends exactly one confirmed next session and two messages", async () => {
    const baseUpdateId =
      9_700_000_000 + randomInt(10_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    await expect(
      committer(prepared).commit(prepared.request),
    ).resolves.toEqual({ kind: "applied" });
    const [commitment] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "commitments",
      `&source_draft_id=eq.${prepared.snapshot.id}`,
    );
    const commitmentId = String(commitment.id);
    const originalTarget = String(commitment.target_at);
    const [sourceSession] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitmentId}`,
    );
    const outcome = new SupabaseWorkSessionOutcomeRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    const outcomeResult = await outcome.resolve({
      action: "more",
      chatId: prepared.config.telegramOwnerUserId,
      sessionId: String(sourceSession.id),
      updateId: baseUpdateId + 3,
      version: 1,
    });
    expect(outcomeResult).toMatchObject({ kind: "more" });
    if (outcomeResult.kind !== "more") {
      throw new Error("partial outcome was not persisted");
    }
    const productContext = await new SupabaseAgentContextReader({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    }).readProductContext({
      chatId: prepared.config.telegramOwnerUserId,
      focusedEntityId: null,
      query: null,
    });
    expect(productContext.continuations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: outcomeResult.continuationId,
          stage: "awaiting_duration",
          version: 1,
        }),
      ]),
    );

    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitments",
        `&id=eq.${commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&commitment_id=eq.${commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        outcome_at: expect.any(String),
        status: "more_work_needed",
      }),
    ]);

    const nextStartMillis = nextBoundary(Date.now() + 12 * 60 * 60_000);
    const nextWindow = {
      endAt: singaporeInstant(nextStartMillis + 45 * 60_000),
      startAt: singaporeInstant(nextStartMillis),
    };
    const checkedAt = new Date().toISOString();
    const availability = vi
      .fn()
      .mockResolvedValueOnce({
        alternatives: [nextWindow],
        checkedAt,
        proposed: null,
        status: "available",
      })
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt,
        proposed: { status: "free", window: nextWindow },
        status: "available",
      });
    const continuationRepository =
      new SupabaseWorkSessionContinuationRepository({
        ownerId: prepared.config.telegramOwnerUserId,
        supabaseSecretKey: prepared.config.supabaseSecretKey,
        supabaseUrl: prepared.config.supabaseUrl,
      });
    const continuation = new WorkSessionContinuationService({
      availability,
      repository: continuationRepository,
    });
    const intentId = outcomeResult.continuationId;
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });

    await expect(
      telegram.claimUpdate(
        baseUpdateId + 4,
        prepared.config.telegramOwnerUserId,
      ),
    ).resolves.toBe(true);
    const continuationAudit: DecisionAudit = {
      inputClass: "ordinary_question",
      modelId: "db-test-model",
      payload: {
        definitionOfDone: null,
        durationMinutes: null,
        missingFields: [],
        nextAction: "answer",
        offerWorkWindowHelp: false,
        possibleWorkSession: false,
        simpleAction: false,
        targetAt: null,
        targetTimeZone: null,
        timingConstraints: [],
        turnRelation: "none",
      },
      promptVersion: "db-test-prompt-v1",
    };
    await new SupabaseConversationRepository({
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    }).recordDecision({
      audit: continuationAudit,
      draftReference: null,
      updateId: baseUpdateId + 4,
    });
    const auditBefore = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "model_decisions",
      `&update_id=eq.${baseUpdateId + 4}`,
    );
    expect(auditBefore).toHaveLength(1);
    await expect(
      continuation.handleDurationInput(
        baseUpdateId + 4,
        prepared.config.telegramOwnerUserId,
        {
          durationMinutes: 45,
          intentId,
          intentVersion: 1,
        },
      ),
    ).resolves.toMatchObject({
      actions: [
        expect.objectContaining({ text: "Find a time" }),
        expect.objectContaining({ text: "Not now" }),
      ],
    });
    expect(availability).not.toHaveBeenCalled();
    await expect(
      telegram.claimUpdate(
        baseUpdateId + 4,
        prepared.config.telegramOwnerUserId,
      ),
    ).resolves.toBe(false);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "telegram_updates",
        `&update_id=eq.${baseUpdateId + 4}`,
      ),
    ).toEqual([
      expect.objectContaining({
        processing_result: "work_session_continuation_resolved",
        processing_status: "processed",
        resolved_action_key: `c:${intentId}:1:natural_duration`,
      }),
    ]);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "model_decisions",
        `&update_id=eq.${baseUpdateId + 4}`,
      ),
    ).toEqual(auditBefore);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_session_continuation_intents",
        `&id=eq.${intentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        duration_minutes: 45,
        stage: "offer",
        version: 2,
      }),
    ]);
    const restartedRepository =
      new SupabaseWorkSessionContinuationRepository({
        ownerId: prepared.config.telegramOwnerUserId,
        supabaseSecretKey: prepared.config.supabaseSecretKey,
        supabaseUrl: prepared.config.supabaseUrl,
      });
    await expect(
      restartedRepository.transitionFromConversation({
        action: "natural_duration",
        chatId: prepared.config.telegramOwnerUserId,
        durationMinutes: 45,
        expectedStage: "awaiting_duration",
        nextStage: "offer",
        reference: { id: intentId, version: 1 },
        updateId: baseUpdateId + 4,
      }),
    ).resolves.toEqual({ kind: "replay" });
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_session_continuation_intents",
        `&id=eq.${intentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        duration_minutes: 45,
        stage: "offer",
        version: 2,
      }),
    ]);
    await expect(
      continuation.handle(
        baseUpdateId + 5,
        prepared.config.telegramOwnerUserId,
        `c:${intentId}:2:another`,
      ),
    ).resolves.toMatchObject({
      actions: [expect.objectContaining({ text: "Choose option 1" }), expect.anything()],
    });
    await expect(
      continuation.handle(
        baseUpdateId + 6,
        prepared.config.telegramOwnerUserId,
        `c:${intentId}:3:option_1`,
      ),
    ).resolves.toMatchObject({
      actions: [expect.objectContaining({ text: "Confirm" }), expect.anything()],
    });
    await expect(
      continuation.handle(
        baseUpdateId + 7,
        prepared.config.telegramOwnerUserId,
        `c:${intentId}:4:confirm`,
      ),
    ).resolves.toMatchObject({
      text: expect.stringMatching(/Next work session scheduled/),
    });

    const sessions = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitmentId}`,
    );
    expect(sessions).toHaveLength(2);
    expect(
      sessions.map((session) => session.sequence_number).sort(),
    ).toEqual([1, 2]);
    const nextSession = sessions.find(
      (session) => session.sequence_number === 2,
    )!;
    expect(nextSession).toMatchObject({
      duration_minutes: 45,
      is_recovery: false,
      source_session_id: sourceSession.id,
      status: "planned",
    });
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "scheduled_messages",
        `&work_session_id=eq.${nextSession.id}`,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "commitments",
        `&id=eq.${commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({ target_at: originalTarget }),
    ]);

    await continuation.handle(
      baseUpdateId + 8,
      prepared.config.telegramOwnerUserId,
      `c:${intentId}:4:confirm`,
    );
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&commitment_id=eq.${commitmentId}`,
      ),
    ).toHaveLength(2);
  });

  it("persists conflict and unavailable final rechecks before explicit unverified save", async () => {
    const baseUpdateId =
      9_710_000_000 + randomInt(10_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    await committer(prepared).commit(prepared.request);
    const [commitment] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "commitments",
      `&source_draft_id=eq.${prepared.snapshot.id}`,
    );
    const [sourceSession] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitment.id}`,
    );
    const outcome = new SupabaseWorkSessionOutcomeRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    const missed = await outcome.resolve({
      action: "missed",
      chatId: prepared.config.telegramOwnerUserId,
      sessionId: String(sourceSession.id),
      updateId: baseUpdateId + 3,
      version: 1,
    });
    expect(missed.kind).toBe("missed");
    if (missed.kind !== "missed") {
      throw new Error("missed outcome was not persisted");
    }

    const startMillis = nextBoundary(Date.now() + 12 * 60 * 60_000);
    const option = {
      endAt: singaporeInstant(startMillis + 60 * 60_000),
      startAt: singaporeInstant(startMillis),
    };
    const checkedAt = new Date().toISOString();
    const availability = vi
      .fn()
      .mockResolvedValueOnce({
        alternatives: [option],
        checkedAt,
        proposed: null,
        status: "available",
      })
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt,
        proposed: { status: "conflict", window: option },
        status: "available",
      })
      .mockResolvedValueOnce({
        status: "authorization_expired",
      });
    const repository = new SupabaseWorkSessionContinuationRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    const continuation = new WorkSessionContinuationService({
      availability,
      repository,
    });
    const intentId = missed.continuationId;

    await continuation.handle(
      baseUpdateId + 4,
      prepared.config.telegramOwnerUserId,
      `c:${intentId}:1:another`,
    );
    await continuation.handle(
      baseUpdateId + 5,
      prepared.config.telegramOwnerUserId,
      `c:${intentId}:2:option_1`,
    );
    await expect(
      continuation.handle(
        baseUpdateId + 6,
        prepared.config.telegramOwnerUserId,
        `c:${intentId}:3:confirm`,
      ),
    ).resolves.toMatchObject({
      actions: [
        expect.objectContaining({ text: "Check again" }),
        expect.objectContaining({ text: "Not now" }),
      ],
    });
    const conflictState = await repository.read({
      id: intentId,
      version: 4,
    });
    expect(conflictState).toMatchObject({
      kind: "current",
      snapshot: {
        calendarCheckedAt: expect.any(String),
        finalObservation: "conflict",
        stage: "conflict_choice",
      },
    });
    if (conflictState.kind !== "current") {
      throw new Error("conflict continuation state was not persisted");
    }
    expect(
      Date.parse(String(conflictState.snapshot.calendarCheckedAt)),
    ).toBe(Date.parse(checkedAt));
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&commitment_id=eq.${commitment.id}`,
      ),
    ).toHaveLength(1);

    await expect(
      continuation.handle(
        baseUpdateId + 7,
        prepared.config.telegramOwnerUserId,
        `c:${intentId}:4:check_again`,
      ),
    ).resolves.toMatchObject({
      actions: [
        expect.objectContaining({ text: "Reconnect" }),
        expect.objectContaining({ text: "Check again" }),
        expect.objectContaining({ text: "Save without Calendar check" }),
        expect.objectContaining({ text: "Not now" }),
      ],
    });
    await expect(
      repository.read({ id: intentId, version: 5 }),
    ).resolves.toMatchObject({
      kind: "current",
      snapshot: {
        calendarAttemptedAt: expect.any(String),
        calendarCheckedAt: null,
        finalObservation: "unavailable",
        stage: "unverified_confirming",
      },
    });
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&commitment_id=eq.${commitment.id}`,
      ),
    ).toHaveLength(1);

    await expect(
      continuation.handle(
        baseUpdateId + 8,
        prepared.config.telegramOwnerUserId,
        `c:${intentId}:5:save_unverified`,
      ),
    ).resolves.toMatchObject({
      text: expect.stringMatching(/Next work session scheduled/),
    });
    expect(
      await rows(
        prepared.config.supabaseUrl,
        prepared.config.supabaseSecretKey,
        "work_sessions",
        `&commitment_id=eq.${commitment.id}&sequence_number=eq.2`,
      ),
    ).toEqual([
      expect.objectContaining({
        calendar_checked_at: null,
        calendar_status: "unverified",
        final_calendar_observation: "unavailable",
        source_session_id: sourceSession.id,
      }),
    ]);
  });

  it("offers and confirms one recovery only inside the immutable target-relative cap", async () => {
    const baseUpdateId =
      9_720_000_000 + randomInt(10_000_000);
    const prepared = await preparedDraft("free", baseUpdateId);
    await committer(prepared).commit(prepared.request);
    const [commitment] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "commitments",
      `&source_draft_id=eq.${prepared.snapshot.id}`,
    );
    const [sourceSession] = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitment.id}`,
    );
    const outcome = new SupabaseWorkSessionOutcomeRepository({
      ownerId: prepared.config.telegramOwnerUserId,
      supabaseSecretKey: prepared.config.supabaseSecretKey,
      supabaseUrl: prepared.config.supabaseUrl,
    });
    const missed = await outcome.resolve({
      action: "missed",
      chatId: prepared.config.telegramOwnerUserId,
      sessionId: String(sourceSession.id),
      updateId: baseUpdateId + 3,
      version: 1,
    });
    expect(missed.kind).toBe("missed");
    if (missed.kind !== "missed") {
      throw new Error("missed outcome was not persisted");
    }

    const targetMillis = Date.parse(String(commitment.target_at));
    const recoveryWindow = {
      endAt: singaporeInstant(
        nextBoundary(targetMillis + 60 * 60_000) + 60 * 60_000,
      ),
      startAt: singaporeInstant(
        nextBoundary(targetMillis + 60 * 60_000),
      ),
    };
    const checkedAt = new Date().toISOString();
    const availability = vi
      .fn()
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt,
        proposed: null,
        status: "no_fit",
      })
      .mockResolvedValueOnce({
        alternatives: [recoveryWindow],
        checkedAt,
        proposed: null,
        status: "available",
      })
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt,
        proposed: { status: "free", window: recoveryWindow },
        status: "available",
      });
    const continuation = new WorkSessionContinuationService({
      availability,
      repository: new SupabaseWorkSessionContinuationRepository({
        ownerId: prepared.config.telegramOwnerUserId,
        supabaseSecretKey: prepared.config.supabaseSecretKey,
        supabaseUrl: prepared.config.supabaseUrl,
      }),
    });

    await continuation.handle(
      baseUpdateId + 4,
      prepared.config.telegramOwnerUserId,
      `c:${missed.continuationId}:1:another`,
    );
    await continuation.handle(
      baseUpdateId + 5,
      prepared.config.telegramOwnerUserId,
      `c:${missed.continuationId}:2:option_1`,
    );
    await continuation.handle(
      baseUpdateId + 6,
      prepared.config.telegramOwnerUserId,
      `c:${missed.continuationId}:3:confirm`,
    );

    const sessions = await rows(
      prepared.config.supabaseUrl,
      prepared.config.supabaseSecretKey,
      "work_sessions",
      `&commitment_id=eq.${commitment.id}`,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          is_recovery: true,
          sequence_number: 2,
          source_session_id: sourceSession.id,
          status: "planned",
        }),
      ]),
    );
    expect(Date.parse(String(sessions[1].start_at))).toBeGreaterThan(
      targetMillis,
    );
    expect(Date.parse(String(sessions[1].end_at))).toBeLessThanOrEqual(
      targetMillis + 7 * 24 * 60 * 60_000,
    );
    expect(
      (
        await rows(
          prepared.config.supabaseUrl,
          prepared.config.supabaseSecretKey,
          "commitments",
          `&id=eq.${commitment.id}`,
        )
      )[0].target_at,
    ).toBe(commitment.target_at);
  });
});
