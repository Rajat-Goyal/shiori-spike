import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SimpleCommitmentActionService,
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
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";
import {
  StatusService,
  SupabaseStatusRepository,
} from "../src/telegram/status-cancel.js";
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
    telegram.claimUpdate(
      baseUpdateId,
      config.telegramOwnerUserId,
    ),
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
  await confirmation.resolve({
    action: "confirm",
    chatId: created.config.telegramOwnerUserId,
    draftId: created.reference.id,
    updateId: baseUpdateId + 1,
    version: created.reference.version,
  });
  const commitments = await rows(
    created.config.supabaseUrl,
    created.config.supabaseSecretKey,
    "commitments",
    `&source_draft_id=eq.${created.reference.id}`,
  );
  expect(commitments).toHaveLength(1);
  return {
    ...created,
    commitmentId: String(commitments[0].id),
  };
}

async function createWork(
  baseUpdateId: number,
  targetAt: string,
  startAt: string,
) {
  const fields: DecisionContextFields = {
    definitionOfDone: `Finish managed work ${baseUpdateId}`,
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
  const startMillis = Date.parse(startAt);
  const endAt = singaporeInstant(startMillis + 60 * 60_000);
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
  await committer.commit({
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
  });
  const commitments = await rows(
    created.config.supabaseUrl,
    created.config.supabaseSecretKey,
    "commitments",
    `&source_draft_id=eq.${created.reference.id}`,
  );
  expect(commitments).toHaveLength(1);
  return {
    ...created,
    checkedAt,
    commitmentId: String(commitments[0].id),
  };
}

describe("local Supabase active promise management", () => {
  it("lists, completes, and second-confirms cancellation without duplicate consequence", async () => {
    const base = 9_800_000_000 + randomInt(50_000_000);
    const now = Date.now();
    const draftFields: DecisionContextFields = {
      definitionOfDone: `Cancel only draft ${base}`,
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: true,
      targetAt: singaporeInstant(now + 24 * 60 * 60_000),
      targetTimeZone: "Asia/Singapore",
      timingConstraints: [],
    };
    const draft = await createDraft(base - 100, draftFields);
    const consequencesBeforeDraftCancel = {
      commitments: (
        await rows(
          draft.config.supabaseUrl,
          draft.config.supabaseSecretKey,
          "commitments",
        )
      ).length,
      messages: (
        await rows(
          draft.config.supabaseUrl,
          draft.config.supabaseSecretKey,
          "scheduled_messages",
        )
      ).length,
    };
    const draftConfirmation = new SupabaseConfirmationRepository({
      ownerId: draft.config.telegramOwnerUserId,
      supabaseSecretKey: draft.config.supabaseSecretKey,
      supabaseUrl: draft.config.supabaseUrl,
    });
    await expect(
      draftConfirmation.resolve({
        action: "cancel",
        chatId: draft.config.telegramOwnerUserId,
        draftId: draft.reference.id,
        updateId: base - 99,
        version: draft.reference.version,
      }),
    ).resolves.toMatchObject({ kind: "cancelled" });
    expect(
      await rows(
        draft.config.supabaseUrl,
        draft.config.supabaseSecretKey,
        "conversation_drafts",
        `&id=eq.${draft.reference.id}`,
      ),
    ).toEqual([expect.objectContaining({ state: "cancelled" })]);
    expect(
      (
        await rows(
          draft.config.supabaseUrl,
          draft.config.supabaseSecretKey,
          "commitments",
        )
      ).length,
    ).toBe(consequencesBeforeDraftCancel.commitments);
    expect(
      (
        await rows(
          draft.config.supabaseUrl,
          draft.config.supabaseSecretKey,
          "scheduled_messages",
        )
      ).length,
    ).toBe(consequencesBeforeDraftCancel.messages);

    const simple = await createSimple(
      base,
      `Submit managed simple ${base}`,
      singaporeInstant(now + 2 * 24 * 60 * 60_000),
    );
    const workStart = singaporeInstant(
      nextBoundary(now + 4 * 60 * 60_000),
    );
    const work = await createWork(
      base + 100,
      singaporeInstant(now + 3 * 24 * 60 * 60_000),
      workStart,
    );
    const googleBefore = await rows(
      simple.config.supabaseUrl,
      simple.config.supabaseSecretKey,
      "google_calendar_connection",
    );
    const status = new StatusService({
      now: () => new Date(now),
      repository: new SupabaseStatusRepository({
        ownerId: simple.config.telegramOwnerUserId,
        supabaseSecretKey: simple.config.supabaseSecretKey,
        supabaseUrl: simple.config.supabaseUrl,
      }),
    });

    const replies = await status.read();
    const managedIds = new Set([
      simple.commitmentId,
      work.commitmentId,
    ]);
    const managedReplies = replies.filter((reply) =>
      reply.actions?.some((action) =>
        [...managedIds].some((id) =>
          action.callbackData.includes(id)
        )
      )
    );
    expect(managedReplies).toHaveLength(2);
    expect(managedReplies[0].text).toContain("Promise ");
    expect(managedReplies[0].text).toContain(
      `Definition of done: Submit managed simple ${base}`,
    );
    expect(managedReplies[0].text).toContain("Status: Active");
    expect(managedReplies[0].text).toContain(
      "Calendar check: Not applicable.",
    );
    expect(managedReplies[1].text).toContain("Next: Work session at");
    expect(managedReplies[1].text).toContain(
      "Calendar check: Free when checked at",
    );
    expect(
      managedReplies.every(
        (reply) =>
          reply.actions?.map((action) => action.text).join(",") ===
          "Done,Cancel",
      ),
    ).toBe(true);

    const actions = new SimpleCommitmentActionService({
      repository: new SupabaseSimpleCommitmentActionRepository({
        ownerId: simple.config.telegramOwnerUserId,
        supabaseSecretKey: simple.config.supabaseSecretKey,
        supabaseUrl: simple.config.supabaseUrl,
      }),
    });
    const firstCancel = await actions.handle(
      base + 2,
      simple.config.telegramOwnerUserId,
      `p:${simple.commitmentId}:1:cancel`,
    );
    expect(firstCancel?.actions?.[0]?.callbackData).toBe(
      `x:${simple.commitmentId}:1:confirm_cancel`,
    );
    const firstCancelReplay = await actions.handle(
      base + 2,
      simple.config.telegramOwnerUserId,
      `p:${simple.commitmentId}:1:cancel`,
    );
    expect(firstCancelReplay).toEqual(firstCancel);
    const secondCancel = await actions.handle(
      base + 3,
      simple.config.telegramOwnerUserId,
      `p:${simple.commitmentId}:1:cancel`,
    );
    expect(secondCancel?.actions?.[0]?.callbackData).toBe(
      `x:${simple.commitmentId}:2:confirm_cancel`,
    );
    await expect(
      actions.handle(
        base + 4,
        simple.config.telegramOwnerUserId,
        `x:${simple.commitmentId}:1:confirm_cancel`,
      ),
    ).resolves.toEqual({
      text: "That action is stale. Nothing was changed.",
    });
    await expect(
      actions.handle(
        base + 5,
        simple.config.telegramOwnerUserId,
        `x:${simple.commitmentId}:2:keep`,
      ),
    ).resolves.toEqual({ text: "Promise kept active." });
    const thirdCancel = await actions.handle(
      base + 6,
      simple.config.telegramOwnerUserId,
      `p:${simple.commitmentId}:1:cancel`,
    );
    expect(thirdCancel?.actions?.[0]?.callbackData).toBe(
      `x:${simple.commitmentId}:3:confirm_cancel`,
    );

    const cancellationBefore = Date.now();
    await expect(
      actions.handle(
        base + 7,
        simple.config.telegramOwnerUserId,
        `x:${simple.commitmentId}:3:confirm_cancel`,
      ),
    ).resolves.toEqual({ text: "Promise cancelled." });
    const cancellationAfter = Date.now();
    await expect(
      actions.handle(
        base + 7,
        simple.config.telegramOwnerUserId,
        `x:${simple.commitmentId}:3:confirm_cancel`,
      ),
    ).resolves.toEqual({
      text: "That promise was already cancelled.",
    });
    await expect(
      actions.handle(
        base + 8,
        simple.config.telegramOwnerUserId,
        `p:${simple.commitmentId}:2:cancel`,
      ),
    ).resolves.toEqual({
      text: "That promise was already cancelled.",
    });

    const completionBefore = Date.now();
    await expect(
      actions.handle(
        base + 103,
        work.config.telegramOwnerUserId,
        `p:${work.commitmentId}:1:done`,
      ),
    ).resolves.toEqual({ text: "Promise completed." });
    const completionAfter = Date.now();
    await expect(
      actions.handle(
        base + 104,
        work.config.telegramOwnerUserId,
        `p:${work.commitmentId}:1:done`,
      ),
    ).resolves.toEqual({
      text: "That promise is already complete.",
    });
    await expect(
      actions.handle(
        base + 105,
        work.config.telegramOwnerUserId,
        `p:${work.commitmentId}:2:done`,
      ),
    ).resolves.toEqual({
      text: "That promise is already complete.",
    });

    const commitments = await rows(
      simple.config.supabaseUrl,
      simple.config.supabaseSecretKey,
      "commitments",
      `&id=in.(${simple.commitmentId},${work.commitmentId})`,
    );
    const cancelled = commitments.find(
      (row) => row.id === simple.commitmentId,
    )!;
    const done = commitments.find(
      (row) => row.id === work.commitmentId,
    )!;
    expect(cancelled.status).toBe("cancelled");
    expect(Date.parse(String(cancelled.cancelled_at))).toBeGreaterThanOrEqual(
      cancellationBefore,
    );
    expect(Date.parse(String(cancelled.cancelled_at))).toBeLessThanOrEqual(
      cancellationAfter,
    );
    expect(done.status).toBe("done");
    expect(Date.parse(String(done.completed_at))).toBeGreaterThanOrEqual(
      completionBefore,
    );
    expect(Date.parse(String(done.completed_at))).toBeLessThanOrEqual(
      completionAfter,
    );

    const messages = await rows(
      simple.config.supabaseUrl,
      simple.config.supabaseSecretKey,
      "scheduled_messages",
      `&commitment_id=in.(${simple.commitmentId},${work.commitmentId})`,
    );
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.state === "cancelled")).toBe(
      true,
    );
    const events = await rows(
      simple.config.supabaseUrl,
      simple.config.supabaseSecretKey,
      "commitment_events",
      `&commitment_id=in.(${simple.commitmentId},${work.commitmentId})`,
    );
    expect(
      events.filter(
        (event) => event.event_type === "commitment.cancelled",
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.event_type === "commitment.done"),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.event_type === "scheduled_message.cancelled",
      ),
    ).toHaveLength(3);
    expect(
      await rows(
        simple.config.supabaseUrl,
        simple.config.supabaseSecretKey,
        "google_calendar_connection",
      ),
    ).toEqual(googleBefore);
  });
});
