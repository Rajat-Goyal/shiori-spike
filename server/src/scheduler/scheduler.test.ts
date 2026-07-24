import { describe, expect, it, vi } from "vitest";
import {
  type ClaimedSimpleReminder,
  SimpleReminderScheduler,
  type SimpleReminderRepository,
  type SimpleReminderResult,
  simpleReminderActionReference,
  simpleReminderReply,
  SupabaseSimpleReminderRepository,
} from "./scheduler.js";
import {
  TelegramBotClient,
  type TelegramClient,
  TelegramSendError,
} from "../telegram/client.js";

const reminder: ClaimedSimpleReminder = {
  actionVersion: 1,
  attemptCount: 1,
  chatId: 123456789,
  commitmentId: "11111111-1111-4111-8111-111111111111",
  definitionOfDone: "Submit the synthetic note",
  id: "22222222-2222-4222-8222-222222222222",
  leaseToken: "33333333-3333-4333-8333-333333333333",
  logicalKey: "simple-reminder:11111111-1111-4111-8111-111111111111",
  targetAt: "2026-07-27T10:05:00+08:00",
};

class ControlledRepository implements SimpleReminderRepository {
  readonly deliveryStarts: Array<{
    reminder: Pick<
      ClaimedSimpleReminder,
      "attemptCount" | "id" | "leaseToken"
    >;
    startedAt: Date;
  }> = [];
  readonly claims: Array<{ limit: number; now: Date }> = [];
  readonly results: SimpleReminderResult[] = [];
  beginFailure: Error | null = null;
  due: ClaimedSimpleReminder[][] = [];

  async beginDelivery(
    claimed: Pick<
      ClaimedSimpleReminder,
      "attemptCount" | "id" | "leaseToken"
    >,
    startedAt: Date,
  ): Promise<void> {
    this.deliveryStarts.push({ reminder: claimed, startedAt });
    if (this.beginFailure) {
      throw this.beginFailure;
    }
  }

  async claimDue(
    now: Date,
    limit: number,
  ): Promise<ClaimedSimpleReminder[]> {
    this.claims.push({ limit, now });
    return this.due.shift() ?? [];
  }

  async recordResult(result: SimpleReminderResult): Promise<void> {
    this.results.push(result);
  }
}

class ControlledClient implements TelegramClient {
  readonly sends: Parameters<TelegramClient["sendText"]>[] = [];
  failure: TelegramSendError | null = null;
  messageId = 41;

  async sendText(
    ...parameters: Parameters<TelegramClient["sendText"]>
  ): Promise<{ messageId: number }> {
    this.sends.push(parameters);
    if (this.failure) {
      throw this.failure;
    }
    return { messageId: this.messageId };
  }
}

describe("simple reminder contract", () => {
  it("renders one reminder with opaque versioned Done and Cancel actions", () => {
    expect(simpleReminderReply(reminder)).toEqual({
      actions: [
        {
          callbackData:
            "p:11111111-1111-4111-8111-111111111111:1:done",
          text: "Done",
        },
        {
          callbackData:
            "p:11111111-1111-4111-8111-111111111111:1:cancel",
          text: "Cancel",
        },
      ],
      text: [
        "Simple reminder.",
        "",
        "Definition of done: Submit the synthetic note",
        "Target: 27 Jul 2026 at 10:05 AM SGT (UTC+08:00)",
      ].join("\n"),
    });
  });

  it("rejects invalid or oversized generated action references", () => {
    expect(() =>
      simpleReminderActionReference("not-a-uuid", 1, "done"),
    ).toThrow("Invalid simple reminder action reference");
    expect(() =>
      simpleReminderActionReference(reminder.commitmentId, 0, "done"),
    ).toThrow("Invalid simple reminder action reference");
  });
});

describe("SupabaseSimpleReminderRepository", () => {
  it("claims a bounded due batch and normalizes the target to Singapore", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json([
        {
          action_version: 1,
          attempt_count: 1,
          chat_id: 123456789,
          commitment_id: reminder.commitmentId,
          definition_of_done: reminder.definitionOfDone,
          id: reminder.id,
          lease_token: reminder.leaseToken,
          logical_key: reminder.logicalKey,
          target_at: "2026-07-27T02:05:00+00:00",
        },
      ]),
    );
    const repository = new SupabaseSimpleReminderRepository({
      fetch: fetchFromSupabase as typeof fetch,
      supabaseSecretKey: "sb_secret_opaque-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    const now = new Date("2026-07-27T02:05:00.000Z");

    await expect(repository.claimDue(now, 5)).resolves.toEqual([reminder]);
    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/claim_due_simple_reminders",
      expect.objectContaining({
        body: JSON.stringify({
          p_limit: 5,
          p_now: now.toISOString(),
        }),
        method: "POST",
      }),
    );
  });

  it("records only bounded result fields without provider material", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ applied: true, state: "delivered" }),
    );
    const repository = new SupabaseSimpleReminderRepository({
      fetch: fetchFromSupabase as typeof fetch,
      supabaseSecretKey: "test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    const recordedAt = new Date("2026-07-27T02:05:01.000Z");

    await repository.recordResult({
      attemptCount: 1,
      leaseToken: reminder.leaseToken,
      messageId: reminder.id,
      recordedAt,
      result: "delivered",
      telegramMessageId: 41,
    });

    const options = fetchFromSupabase.mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toEqual({
      p_attempt_count: 1,
      p_lease_token: reminder.leaseToken,
      p_message_id: reminder.id,
      p_recorded_at: recordedAt.toISOString(),
      p_result: "delivered",
      p_retry_at: null,
      p_telegram_message_id: 41,
    });
    expect(String(options?.body)).not.toMatch(
      /definition|target|payload|response|secret|bot_token/,
    );
  });

  it("durably crosses the send boundary for the current lease", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ applied: true, state: "claimed" }),
    );
    const repository = new SupabaseSimpleReminderRepository({
      fetch: fetchFromSupabase as typeof fetch,
      supabaseSecretKey: "test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    const startedAt = new Date("2026-07-27T02:05:00.500Z");

    await repository.beginDelivery(reminder, startedAt);

    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/begin_simple_reminder_delivery",
      expect.objectContaining({
        body: JSON.stringify({
          p_attempt_count: 1,
          p_lease_token: reminder.leaseToken,
          p_message_id: reminder.id,
          p_started_at: startedAt.toISOString(),
        }),
      }),
    );
  });

  it.each([
    {},
    [{ ...reminder, action_version: 0 }],
    [{ ...reminder, id: "not-a-uuid" }],
  ])("fails closed on malformed claims %#", async (body) => {
    const repository = new SupabaseSimpleReminderRepository({
      fetch: (async () => Response.json(body)) as typeof fetch,
      supabaseSecretKey: "test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    await expect(
      repository.claimDue(new Date("2026-07-27T02:05:00.000Z"), 5),
    ).rejects.toThrow();
  });
});

describe("SimpleReminderScheduler", () => {
  it("claims and records one delivered reminder without a follow-up", async () => {
    const repository = new ControlledRepository();
    repository.due = [[reminder], []];
    const client = new ControlledClient();
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-07-27T02:05:00.000Z"))
      .mockReturnValue(new Date("2026-07-27T02:05:01.000Z"));
    const scheduler = new SimpleReminderScheduler({
      client,
      now,
      repository,
    });

    await expect(scheduler.poll()).resolves.toBe(1);
    await expect(scheduler.poll()).resolves.toBe(0);

    expect(client.sends).toEqual([
      [reminder.chatId, simpleReminderReply(reminder).text, simpleReminderReply(reminder).actions],
    ]);
    expect(repository.results).toEqual([
      {
        attemptCount: 1,
        leaseToken: reminder.leaseToken,
        messageId: reminder.id,
        recordedAt: new Date("2026-07-27T02:05:01.000Z"),
        result: "delivered",
        telegramMessageId: 41,
      },
    ]);
    expect(repository.deliveryStarts).toEqual([
      {
        reminder: {
          attemptCount: 1,
          id: reminder.id,
          leaseToken: reminder.leaseToken,
        },
        startedAt: new Date("2026-07-27T02:05:01.000Z"),
      },
    ]);
    expect(repository.claims).toHaveLength(2);
  });

  it("serializes overlapping in-process polls", async () => {
    let release!: (value: ClaimedSimpleReminder[]) => void;
    const repository = new ControlledRepository();
    repository.claimDue = vi.fn(
      () =>
        new Promise<ClaimedSimpleReminder[]>((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = new SimpleReminderScheduler({
      client: new ControlledClient(),
      repository,
    });

    const first = scheduler.poll();
    const second = scheduler.poll();
    release([]);

    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(repository.claimDue).toHaveBeenCalledTimes(1);
  });

  it("does not send when the durable send boundary rejects the lease", async () => {
    const repository = new ControlledRepository();
    repository.due = [[reminder]];
    repository.beginFailure = new Error("stale lease");
    const client = new ControlledClient();
    const scheduler = new SimpleReminderScheduler({
      client,
      repository,
    });

    await expect(scheduler.poll()).rejects.toThrow("stale lease");

    expect(client.sends).toHaveLength(0);
    expect(repository.results).toHaveLength(0);
  });

  it.each([
    {
      expected: "delivery_unknown",
      failure: new TelegramSendError("delivery_unknown"),
    },
    {
      expected: "permanent_failure",
      failure: new TelegramSendError("permanent_failure"),
    },
  ] as const)("records $expected once and does not retry", async ({ expected, failure }) => {
    const repository = new ControlledRepository();
    repository.due = [[reminder], []];
    const client = new ControlledClient();
    client.failure = failure;
    const scheduler = new SimpleReminderScheduler({
      client,
      repository,
    });

    await scheduler.poll();
    await scheduler.poll();

    expect(client.sends).toHaveLength(1);
    expect(repository.results).toHaveLength(1);
    expect(repository.results[0]).toMatchObject({ result: expected });
  });

  it("treats a success response without a message identity as unknown", async () => {
    const repository = new ControlledRepository();
    repository.due = [[reminder]];
    const scheduler = new SimpleReminderScheduler({
      client: { async sendText() {} },
      repository,
    });

    await scheduler.poll();

    expect(repository.results).toHaveLength(1);
    expect(repository.results[0]).toMatchObject({
      result: "delivery_unknown",
    });
  });

  it("records validated rate limiting with retry time before exhaustion", async () => {
    const repository = new ControlledRepository();
    repository.due = [[reminder]];
    const client = new ControlledClient();
    client.failure = new TelegramSendError("rate_limited", 17);
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-07-27T02:05:00.000Z"))
      .mockReturnValue(new Date("2026-07-27T02:05:01.000Z"));
    const scheduler = new SimpleReminderScheduler({
      client,
      now,
      repository,
    });

    await scheduler.poll();

    expect(repository.results).toEqual([
      {
        attemptCount: 1,
        leaseToken: reminder.leaseToken,
        messageId: reminder.id,
        recordedAt: new Date("2026-07-27T02:05:01.000Z"),
        result: "rate_limited",
        retryAt: new Date("2026-07-27T02:05:18.000Z"),
      },
    ]);
  });

  it("leaves an exhausted third validated rate limit without retry time", async () => {
    const repository = new ControlledRepository();
    repository.due = [[{ ...reminder, attemptCount: 3 }]];
    const client = new ControlledClient();
    client.failure = new TelegramSendError("rate_limited", 17);
    const scheduler = new SimpleReminderScheduler({
      client,
      repository,
    });

    await scheduler.poll();

    expect(repository.results).toHaveLength(1);
    expect(repository.results[0]).toMatchObject({
      attemptCount: 3,
      result: "rate_limited",
    });
    expect(repository.results[0]).not.toHaveProperty("retryAt");
  });
});

describe("TelegramBotClient delivery classification", () => {
  it("returns the confirmed Telegram message identity", async () => {
    const client = new TelegramBotClient({
      botToken: "test-token",
      fetch: vi.fn(async () =>
        Response.json({ ok: true, result: { message_id: 41 } }),
      ) as typeof fetch,
    });
    await expect(client.sendText(123, "Reminder")).resolves.toEqual({
      messageId: 41,
    });
  });

  it("accepts only a validated HTTP 429 as retry-safe", async () => {
    const valid = new TelegramBotClient({
      botToken: "test-token",
      fetch: vi.fn(async () =>
        Response.json(
          {
            error_code: 429,
            ok: false,
            parameters: { retry_after: 17 },
          },
          { status: 429 },
        ),
      ) as typeof fetch,
    });
    await expect(valid.sendText(123, "Reminder")).rejects.toMatchObject({
      failure: "rate_limited",
      retryAfterSeconds: 17,
    });

    const invalid = new TelegramBotClient({
      botToken: "test-token",
      fetch: vi.fn(async () =>
        Response.json(
          { error_code: 429, ok: false, parameters: {} },
          { status: 429 },
        ),
      ) as typeof fetch,
    });
    await expect(invalid.sendText(123, "Reminder")).rejects.toMatchObject({
      failure: "delivery_unknown",
    });
  });

  it("classifies ambiguous and definitive non-retryable failures", async () => {
    const ambiguous = new TelegramBotClient({
      botToken: "test-token",
      fetch: vi.fn(async () => {
        throw new TypeError("private network detail");
      }) as typeof fetch,
    });
    await expect(
      ambiguous.sendText(123, "Reminder"),
    ).rejects.toMatchObject({ failure: "delivery_unknown" });

    const permanent = new TelegramBotClient({
      botToken: "test-token",
      fetch: vi.fn(async () => new Response("{}", { status: 400 })) as typeof fetch,
    });
    await expect(
      permanent.sendText(123, "Reminder"),
    ).rejects.toMatchObject({ failure: "permanent_failure" });
  });
});
