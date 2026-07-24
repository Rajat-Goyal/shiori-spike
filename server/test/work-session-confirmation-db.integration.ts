import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
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

function nextBoundary(afterMillis: number): number {
  const halfHour = 30 * 60_000;
  return Math.ceil(afterMillis / halfHour) * halfHour;
}

type ConfirmationOutcome = "conflict_kept" | "free" | "unverified";

async function preparedDraft(
  outcome: ConfirmationOutcome,
  baseUpdateId: number,
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
    endAt: singaporeInstant(startMillis + 60 * 60_000),
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
      : outcome === "conflict_kept"
        ? "conflict_confirming"
        : "unverified_confirming";
  const transitioned = await flow.transition({
    calendarAttemptedAt: attemptedAt,
    calendarCheckedAt: checkedAt,
    chatId: config.telegramOwnerUserId,
    conflictConsent: outcome === "conflict_kept",
    durationMinutes: 60,
    expectedStage: "offer_help",
    finalObservation:
      outcome === "unverified"
        ? "unavailable"
        : outcome === "conflict_kept"
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
    outcome === "unverified" ? "unavailable" : "free";
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
        conflictConsent: outcome === "conflict_kept",
        finalObservation,
        status: outcome,
      },
      chatId: config.telegramOwnerUserId,
      definitionOfDone: snapshot.definitionOfDone,
      draft: { id: snapshot.id, version: snapshot.version },
      durationMinutes: 60,
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
  it.each([
    "free",
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
          calendar_status: outcome,
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
  });
});
