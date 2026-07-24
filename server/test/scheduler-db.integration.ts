import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { SupabaseConfirmationRepository } from "../src/confirmation.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import {
  SimpleReminderScheduler,
  SupabaseSimpleReminderRepository,
} from "../src/scheduler/scheduler.js";
import { supabaseHeaders } from "../src/supabase.js";
import { TelegramSendError } from "../src/telegram/client.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";

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
  const body: unknown = await response.json();
  expect(Array.isArray(body)).toBe(true);
  return body as Array<Record<string, unknown>>;
}

function decisionAudit(fields: DecisionContextFields): DecisionAudit {
  return {
    inputClass: "explicit_commitment",
    modelId: "gpt-test-model",
    payload: {
      ...fields,
      missingFields: [],
      nextAction: "ready",
      turnRelation: "new_request",
    },
    promptVersion: "shiori-test-v1",
  };
}

async function createConfirmedPromise(options: {
  baseUpdateId: number;
  definitionOfDone: string;
  targetAt: string;
}) {
  const config = localConfig();
  const telegram = new SupabaseTelegramRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const conversation = new SupabaseConversationRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const confirmation = new SupabaseConfirmationRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const fields: DecisionContextFields = {
    definitionOfDone: options.definitionOfDone,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: false,
    simpleAction: true,
    targetAt: options.targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };

  await expect(
    telegram.claimUpdate(
      options.baseUpdateId,
      config.telegramOwnerUserId,
    ),
  ).resolves.toBe(true);
  const created = await conversation.applyTurn({
    action: "create_draft",
    audit: decisionAudit(fields),
    expected: { kind: "none" },
    fields,
    phase: "complete",
    processingResult: "conversation",
    updateId: options.baseUpdateId,
  });
  expect(created).toMatchObject({
    completed: true,
    draftCreated: true,
    status: "applied",
  });
  expect(created.draftReference).toBeDefined();
  const draft = created.draftReference!;

  await expect(
    confirmation.resolve({
      action: "confirm",
      chatId: config.telegramOwnerUserId,
      draftId: draft.id,
      updateId: options.baseUpdateId + 1,
      version: draft.version,
    }),
  ).resolves.toMatchObject({
    completed: true,
    kind: "confirmed",
  });

  const commitments = await rows(
    config.supabaseUrl,
    config.supabaseSecretKey,
    "commitments",
    `&source_draft_id=eq.${draft.id}`,
  );
  expect(commitments).toHaveLength(1);
  return {
    commitmentId: String(commitments[0].id),
    config,
  };
}

function targetAt(minutesAhead: number): string {
  const singapore = new Date(
    Date.now() + minutesAhead * 60 * 1_000 + 8 * 60 * 60 * 1_000,
  );
  return `${singapore.toISOString().slice(0, 19)}+08:00`;
}

describe("restart-safe scheduler on local Supabase", () => {
  it("grants one concurrent lease and safely reclaims an unstarted attempt", async () => {
    const created = await createConfirmedPromise({
      baseUpdateId: 9_500_000_000 + randomInt(10_000_000),
      definitionOfDone: "Verify the restart-safe concurrent claim",
      targetAt: targetAt(30),
    });
    const dueAt = new Date(
      String(
        (
          await rows(
            created.config.supabaseUrl,
            created.config.supabaseSecretKey,
            "scheduled_messages",
            `&commitment_id=eq.${created.commitmentId}`,
          )
        )[0].due_at,
      ),
    );
    const claimAt = new Date(dueAt.getTime() + 1_000);
    const repositories = Array.from(
      { length: 8 },
      () =>
        new SupabaseSimpleReminderRepository({
          supabaseSecretKey: created.config.supabaseSecretKey,
          supabaseUrl: created.config.supabaseUrl,
        }),
    );

    const concurrentClaims = (
      await Promise.all(
        repositories.map((repository) =>
          repository.claimDue(claimAt, 1),
        ),
      )
    ).flat();
    expect(concurrentClaims).toHaveLength(1);
    const firstLease = concurrentClaims[0];
    expect(firstLease.attemptCount).toBe(1);

    const restartedRepository =
      new SupabaseSimpleReminderRepository({
        supabaseSecretKey: created.config.supabaseSecretKey,
        supabaseUrl: created.config.supabaseUrl,
      });
    const recovered = await restartedRepository.claimDue(
      new Date(claimAt.getTime() + 31_000),
      1,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      attemptCount: 1,
      id: firstLease.id,
      logicalKey: firstLease.logicalKey,
    });
    expect(recovered[0].leaseToken).not.toBe(firstLease.leaseToken);
    await expect(
      restartedRepository.beginDelivery(
        firstLease,
        new Date(claimAt.getTime() + 31_500),
      ),
    ).rejects.toThrow("delivery start was not applied");
    const recoveredStartedAt = new Date(claimAt.getTime() + 32_000);
    await restartedRepository.beginDelivery(
      recovered[0],
      recoveredStartedAt,
    );
    await restartedRepository.recordResult({
      attemptCount: recovered[0].attemptCount,
      leaseToken: recovered[0].leaseToken,
      messageId: recovered[0].id,
      recordedAt: new Date(recoveredStartedAt.getTime() + 1_000),
      result: "delivery_unknown",
    });

    const events = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "commitment_events",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(
      events.filter(
        (event) =>
          event.event_type === "scheduled_message.delivery_attempt",
      ),
    ).toHaveLength(1);
  });

  it("turns an expired started send into delivery_unknown without resend", async () => {
    const created = await createConfirmedPromise({
      baseUpdateId: 9_520_000_000 + randomInt(10_000_000),
      definitionOfDone: "Verify ambiguity remains terminal",
      targetAt: targetAt(31),
    });
    const message = (
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${created.commitmentId}`,
      )
    )[0];
    const claimAt = new Date(
      new Date(String(message.due_at)).getTime() + 1_000,
    );
    const repository = new SupabaseSimpleReminderRepository({
      supabaseSecretKey: created.config.supabaseSecretKey,
      supabaseUrl: created.config.supabaseUrl,
    });
    const claimed = (await repository.claimDue(claimAt, 1))[0];
    await repository.beginDelivery(
      claimed,
      new Date(claimAt.getTime() + 1_000),
    );

    await expect(
      repository.claimDue(new Date(claimAt.getTime() + 31_000), 1),
    ).resolves.toEqual([]);
    await expect(
      repository.claimDue(new Date(claimAt.getTime() + 62_000), 1),
    ).resolves.toEqual([]);
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${created.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_count: 1,
        delivery_started_at: null,
        lease_token: null,
        state: "delivery_unknown",
      }),
    ]);
  });

  it("bounds validated 429 attempts and keeps permanent rejection terminal", async () => {
    const retryPromise = await createConfirmedPromise({
      baseUpdateId: 9_540_000_000 + randomInt(10_000_000),
      definitionOfDone: "Verify bounded restart-safe retries",
      targetAt: targetAt(32),
    });
    const retryMessage = (
      await rows(
        retryPromise.config.supabaseUrl,
        retryPromise.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${retryPromise.commitmentId}`,
      )
    )[0];
    let pollTime = new Date(
      new Date(String(retryMessage.due_at)).getTime() + 1_000,
    );
    const repository = new SupabaseSimpleReminderRepository({
      supabaseSecretKey: retryPromise.config.supabaseSecretKey,
      supabaseUrl: retryPromise.config.supabaseUrl,
    });
    const retryScheduler = new SimpleReminderScheduler({
      client: {
        async sendText() {
          throw new TelegramSendError("rate_limited", 2);
        },
      },
      now: () => pollTime,
      repository,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(retryScheduler.poll()).resolves.toBe(1);
      pollTime = new Date(pollTime.getTime() + 3_000);
    }
    await expect(retryScheduler.poll()).resolves.toBe(0);
    expect(
      await rows(
        retryPromise.config.supabaseUrl,
        retryPromise.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${retryPromise.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_count: 3,
        lease_token: null,
        next_attempt_at: null,
        state: "retryable_failure",
      }),
    ]);

    const permanentPromise = await createConfirmedPromise({
      baseUpdateId: 9_560_000_000 + randomInt(10_000_000),
      definitionOfDone: "Verify permanent rejection remains terminal",
      targetAt: targetAt(33),
    });
    const permanentMessage = (
      await rows(
        permanentPromise.config.supabaseUrl,
        permanentPromise.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${permanentPromise.commitmentId}`,
      )
    )[0];
    const permanentAt = new Date(
      new Date(String(permanentMessage.due_at)).getTime() + 1_000,
    );
    const permanentScheduler = new SimpleReminderScheduler({
      client: {
        async sendText() {
          throw new TelegramSendError("permanent_failure");
        },
      },
      now: () => permanentAt,
      repository: new SupabaseSimpleReminderRepository({
        supabaseSecretKey: permanentPromise.config.supabaseSecretKey,
        supabaseUrl: permanentPromise.config.supabaseUrl,
      }),
    });
    await expect(permanentScheduler.poll()).resolves.toBe(1);
    await expect(permanentScheduler.poll()).resolves.toBe(0);
    expect(
      await rows(
        permanentPromise.config.supabaseUrl,
        permanentPromise.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${permanentPromise.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_count: 1,
        lease_token: null,
        state: "permanent_failure",
      }),
    ]);
  });
});
