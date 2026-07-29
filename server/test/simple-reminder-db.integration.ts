import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import {
  SimpleCommitmentActionService,
  SupabaseSimpleCommitmentActionRepository,
} from "../src/commitments/simple-action.js";
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
import type {
  TelegramClient,
  TelegramSendReceipt,
} from "../src/telegram/client.js";
import { TelegramSendError } from "../src/telegram/client.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";
import { DB_WALL_CLOCK_TOLERANCE_MS } from "./db-wall-clock.js";

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

function singaporeTarget(hoursAhead: number): string {
  const singapore = new Date(
    Date.now() +
      hoursAhead * 60 * 60 * 1_000 +
      8 * 60 * 60 * 1_000,
  );
  return `${singapore.toISOString().slice(0, 19)}+08:00`;
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

class DeliveredClient implements TelegramClient {
  readonly sends: Array<{
    actions: unknown;
    chatId: number;
    text: string;
  }> = [];

  async sendText(
    chatId: number,
    text: string,
    actions?: Parameters<TelegramClient["sendText"]>[2],
  ): Promise<TelegramSendReceipt> {
    this.sends.push({ actions, chatId, text });
    return { messageId: 9001 };
  }
}

class RateLimitedClient implements TelegramClient {
  async sendText(): Promise<never> {
    throw new TelegramSendError("rate_limited", 2);
  }
}

describe("local Supabase simple reminder delivery", () => {
  it("claims and delivers once, records no follow-up, and resolves Done once", async () => {
    const baseUpdateId = 9_400_000_000 + randomInt(10_000_000);
    const targetAt = singaporeTarget(2);
    const created = await createConfirmedPromise({
      baseUpdateId,
      definitionOfDone: "Submit the delivered synthetic note",
      targetAt,
    });
    const repository = new SupabaseSimpleReminderRepository({
      supabaseSecretKey: created.config.supabaseSecretKey,
      supabaseUrl: created.config.supabaseUrl,
    });
    const client = new DeliveredClient();
    const dueAt = new Date(targetAt);
    const schedulerNow = new Date(dueAt.getTime() + 1_000);
    const scheduler = new SimpleReminderScheduler({
      client,
      now: () => schedulerNow,
      repository,
    });

    await expect(scheduler.poll()).resolves.toBe(1);
    await expect(scheduler.poll()).resolves.toBe(0);
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0]).toMatchObject({
      chatId: created.config.telegramOwnerUserId,
    });
    expect(client.sends[0].actions).toEqual([
      {
        callbackData: `p:${created.commitmentId}:1:done`,
        text: "Done",
      },
      {
        callbackData: `p:${created.commitmentId}:1:cancel`,
        text: "Cancel",
      },
    ]);

    const deliveredRows = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "scheduled_messages",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(deliveredRows).toEqual([
      expect.objectContaining({
        attempt_count: 1,
        next_attempt_at: null,
        state: "delivered",
        telegram_message_id: 9001,
      }),
    ]);

    const action = new SimpleCommitmentActionService({
      repository: new SupabaseSimpleCommitmentActionRepository({
        ownerId: created.config.telegramOwnerUserId,
        supabaseSecretKey: created.config.supabaseSecretKey,
        supabaseUrl: created.config.supabaseUrl,
      }),
    });
    const beforeDone = Date.now();
    await expect(
      action.handle(
        baseUpdateId + 2,
        created.config.telegramOwnerUserId,
        `p:${created.commitmentId}:1:done`,
      ),
    ).resolves.toEqual({ text: "Promise completed." });
    const afterDone = Date.now();
    await expect(
      action.handle(
        baseUpdateId + 3,
        created.config.telegramOwnerUserId,
        `p:${created.commitmentId}:1:done`,
      ),
    ).resolves.toEqual({
      text: "That promise is already complete.",
    });
    await expect(
      action.handle(
        baseUpdateId + 3,
        created.config.telegramOwnerUserId,
        `p:${created.commitmentId}:1:done`,
      ),
    ).resolves.toEqual({
      text: "That promise is already complete.",
    });

    const commitmentRows = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "commitments",
      `&id=eq.${created.commitmentId}`,
    );
    expect(commitmentRows).toHaveLength(1);
    expect(commitmentRows[0].status).toBe("done");
    const completedAt = new Date(
      String(commitmentRows[0].completed_at),
    ).getTime();
    expect(completedAt).toBeGreaterThanOrEqual(
      beforeDone - DB_WALL_CLOCK_TOLERANCE_MS,
    );
    expect(completedAt).toBeLessThanOrEqual(
      afterDone + DB_WALL_CLOCK_TOLERANCE_MS,
    );

    const events = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "commitment_events",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(
      events.map((event) => event.event_type).sort(),
    ).toEqual([
      "commitment.created",
      "commitment.done",
      "scheduled_message.created",
      "scheduled_message.delivered",
      "scheduled_message.delivery_attempt",
    ]);
    expect(
      events.filter((event) => event.event_type === "commitment.done"),
    ).toHaveLength(1);
  });

  it("keeps Cancel non-mutating and atomically cancels pending work on Done", async () => {
    const baseUpdateId = 9_420_000_000 + randomInt(10_000_000);
    const created = await createConfirmedPromise({
      baseUpdateId,
      definitionOfDone: "Submit the pending synthetic note",
      targetAt: singaporeTarget(3),
    });
    const action = new SimpleCommitmentActionService({
      repository: new SupabaseSimpleCommitmentActionRepository({
        ownerId: created.config.telegramOwnerUserId,
        supabaseSecretKey: created.config.supabaseSecretKey,
        supabaseUrl: created.config.supabaseUrl,
      }),
    });

    await expect(
      action.handle(
        baseUpdateId + 2,
        created.config.telegramOwnerUserId,
        `p:${created.commitmentId}:1:cancel`,
      ),
    ).resolves.toEqual({
      actions: [
        {
          callbackData: `x:${created.commitmentId}:1:confirm_cancel`,
          text: "Confirm cancellation",
        },
        {
          callbackData: `x:${created.commitmentId}:1:keep`,
          text: "Keep",
        },
      ],
      text:
        "Cancel this saved promise? This requires a second confirmation. Nothing has changed yet.",
    });
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "commitments",
        `&id=eq.${created.commitmentId}`,
      ),
    ).toEqual([expect.objectContaining({ status: "active" })]);
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${created.commitmentId}`,
      ),
    ).toEqual([expect.objectContaining({ state: "pending" })]);

    await expect(
      action.handle(
        baseUpdateId + 3,
        created.config.telegramOwnerUserId,
        `p:${created.commitmentId}:1:done`,
      ),
    ).resolves.toEqual({ text: "Promise completed." });
    expect(
      await rows(
        created.config.supabaseUrl,
        created.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${created.commitmentId}`,
      ),
    ).toEqual([expect.objectContaining({ state: "cancelled" })]);

    const events = await rows(
      created.config.supabaseUrl,
      created.config.supabaseSecretKey,
      "commitment_events",
      `&commitment_id=eq.${created.commitmentId}`,
    );
    expect(
      events.filter(
        (event) =>
          event.event_type === "scheduled_message.cancelled",
      ),
    ).toHaveLength(1);
  });

  it("bounds validated 429 retries at three and never retries ambiguity", async () => {
    const baseUpdateId = 9_440_000_000 + randomInt(10_000_000);
    const targetAt = singaporeTarget(4);
    const retryPromise = await createConfirmedPromise({
      baseUpdateId,
      definitionOfDone: "Submit the rate-limited synthetic note",
      targetAt,
    });
    const repository = new SupabaseSimpleReminderRepository({
      supabaseSecretKey: retryPromise.config.supabaseSecretKey,
      supabaseUrl: retryPromise.config.supabaseUrl,
    });
    let pollTime = new Date(new Date(targetAt).getTime() + 1_000);
    const scheduler = new SimpleReminderScheduler({
      client: new RateLimitedClient(),
      now: () => pollTime,
      repository,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(scheduler.poll()).resolves.toBe(1);
      pollTime = new Date(pollTime.getTime() + 3_000);
    }
    await expect(scheduler.poll()).resolves.toBe(0);
    const retryRows = await rows(
      retryPromise.config.supabaseUrl,
      retryPromise.config.supabaseSecretKey,
      "scheduled_messages",
      `&commitment_id=eq.${retryPromise.commitmentId}`,
    );
    expect(retryRows).toEqual([
      expect.objectContaining({
        attempt_count: 3,
        last_error_class: "rate_limited",
        next_attempt_at: null,
        state: "retryable_failure",
      }),
    ]);
    const retryEvents = await rows(
      retryPromise.config.supabaseUrl,
      retryPromise.config.supabaseSecretKey,
      "commitment_events",
      `&commitment_id=eq.${retryPromise.commitmentId}`,
    );
    expect(
      retryEvents.filter(
        (event) =>
          event.event_type === "scheduled_message.delivery_attempt",
      ),
    ).toHaveLength(3);
    expect(
      retryEvents.filter(
        (event) =>
          event.event_type === "scheduled_message.retry_scheduled",
      ),
    ).toHaveLength(2);
    expect(
      retryEvents.filter(
        (event) =>
          event.event_type === "scheduled_message.retry_exhausted",
      ),
    ).toHaveLength(1);

    const unknownBaseUpdateId = baseUpdateId + 100;
    const unknownTarget = singaporeTarget(5);
    const unknownPromise = await createConfirmedPromise({
      baseUpdateId: unknownBaseUpdateId,
      definitionOfDone: "Submit the uncertain synthetic note",
      targetAt: unknownTarget,
    });
    const unknownRepository = new SupabaseSimpleReminderRepository({
      supabaseSecretKey: unknownPromise.config.supabaseSecretKey,
      supabaseUrl: unknownPromise.config.supabaseUrl,
    });
    const unknownNow = new Date(
      new Date(unknownTarget).getTime() + 1_000,
    );
    const unknownScheduler = new SimpleReminderScheduler({
      client: {
        async sendText() {
          throw new TelegramSendError("delivery_unknown");
        },
      },
      now: () => unknownNow,
      repository: unknownRepository,
    });
    await expect(unknownScheduler.poll()).resolves.toBe(1);
    await expect(unknownScheduler.poll()).resolves.toBe(0);
    expect(
      await rows(
        unknownPromise.config.supabaseUrl,
        unknownPromise.config.supabaseSecretKey,
        "scheduled_messages",
        `&commitment_id=eq.${unknownPromise.commitmentId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_count: 1,
        next_attempt_at: null,
        state: "delivery_unknown",
      }),
    ]);
  });
});
