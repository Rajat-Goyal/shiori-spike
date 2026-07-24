import {
  formatSingaporeTarget,
  type TelegramInlineAction,
} from "../confirmation.js";
import { supabaseHeaders } from "../supabase.js";
import {
  type TelegramClient,
  TelegramSendError,
} from "../telegram/client.js";

export type ClaimedSimpleReminder = {
  actionVersion: number;
  attemptCount: number;
  chatId: number;
  commitmentId: string;
  definitionOfDone: string;
  id: string;
  logicalKey: string;
  targetAt: string;
};

export type SimpleReminderResult =
  | {
      attemptCount: number;
      messageId: string;
      recordedAt: Date;
      result: "delivery_unknown" | "permanent_failure";
    }
  | {
      attemptCount: number;
      messageId: string;
      recordedAt: Date;
      result: "delivered";
      telegramMessageId: number;
    }
  | {
      attemptCount: number;
      messageId: string;
      recordedAt: Date;
      result: "rate_limited";
      retryAt?: Date;
    };

export interface SimpleReminderRepository {
  claimDue(now: Date, limit: number): Promise<ClaimedSimpleReminder[]>;
  recordResult(result: SimpleReminderResult): Promise<void>;
}

type SupabaseSimpleReminderRepositoryOptions = {
  fetch?: typeof fetch;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

type SimpleReminderSchedulerOptions = {
  batchSize?: number;
  client: TelegramClient;
  intervalMilliseconds?: number;
  now?: () => Date;
  repository: SimpleReminderRepository;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function parseClaimedReminder(value: unknown): ClaimedSimpleReminder {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.logical_key !== "string" ||
    value.logical_key.length < 1 ||
    value.logical_key.length > 100 ||
    typeof value.commitment_id !== "string" ||
    !UUID_PATTERN.test(value.commitment_id) ||
    !positiveSafeInteger(value.action_version) ||
    !positiveSafeInteger(value.attempt_count) ||
    !positiveSafeInteger(value.chat_id) ||
    typeof value.definition_of_done !== "string" ||
    value.definition_of_done.trim().length === 0 ||
    typeof value.target_at !== "string"
  ) {
    throw new Error("Simple reminder claim returned an invalid response");
  }

  const targetAt = new Date(value.target_at);
  if (!Number.isFinite(targetAt.getTime())) {
    throw new Error("Simple reminder claim returned an invalid response");
  }
  const singaporeTarget = new Date(
    targetAt.getTime() + 8 * 60 * 60 * 1_000,
  );

  return {
    actionVersion: value.action_version,
    attemptCount: value.attempt_count,
    chatId: value.chat_id,
    commitmentId: value.commitment_id,
    definitionOfDone: value.definition_of_done,
    id: value.id,
    logicalKey: value.logical_key,
    targetAt: `${singaporeTarget.toISOString().slice(0, 19)}+08:00`,
  };
}

export function simpleReminderActionReference(
  commitmentId: string,
  version: number,
  action: "cancel" | "done",
): string {
  const value = `p:${commitmentId}:${version}:${action}`;
  if (
    !UUID_PATTERN.test(commitmentId) ||
    !positiveSafeInteger(version) ||
    value.length > 64
  ) {
    throw new Error("Invalid simple reminder action reference");
  }
  return value;
}

export function simpleReminderReply(
  reminder: Pick<
    ClaimedSimpleReminder,
    "actionVersion" | "commitmentId" | "definitionOfDone" | "targetAt"
  >,
): { actions: readonly TelegramInlineAction[]; text: string } {
  const actions: readonly TelegramInlineAction[] = [
    {
      callbackData: simpleReminderActionReference(
        reminder.commitmentId,
        reminder.actionVersion,
        "done",
      ),
      text: "Done",
    },
    {
      callbackData: simpleReminderActionReference(
        reminder.commitmentId,
        reminder.actionVersion,
        "cancel",
      ),
      text: "Cancel",
    },
  ];

  return {
    actions,
    text: [
      "Simple reminder.",
      "",
      `Definition of done: ${reminder.definitionOfDone}`,
      `Target: ${formatSingaporeTarget(reminder.targetAt)}`,
    ].join("\n"),
  };
}

export class SupabaseSimpleReminderRepository
  implements SimpleReminderRepository
{
  readonly #fetch: typeof fetch;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseSimpleReminderRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async claimDue(
    now: Date,
    limit: number,
  ): Promise<ClaimedSimpleReminder[]> {
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      throw new Error("Invalid simple reminder claim");
    }
    const response = await this.#rpc("claim_due_simple_reminders", {
      p_limit: limit,
      p_now: now.toISOString(),
    });
    if (!Array.isArray(response)) {
      throw new Error("Simple reminder claim returned an invalid response");
    }
    return response.map(parseClaimedReminder);
  }

  async recordResult(result: SimpleReminderResult): Promise<void> {
    const response = await this.#rpc("record_simple_reminder_result", {
      p_attempt_count: result.attemptCount,
      p_message_id: result.messageId,
      p_recorded_at: result.recordedAt.toISOString(),
      p_result: result.result,
      p_retry_at:
        result.result === "rate_limited" && result.retryAt
          ? result.retryAt.toISOString()
          : null,
      p_telegram_message_id:
        result.result === "delivered" ? result.telegramMessageId : null,
    });
    if (
      !isRecord(response) ||
      response.applied !== true ||
      typeof response.state !== "string"
    ) {
      throw new Error("Simple reminder result was not applied");
    }
  }

  async #rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/${name}`,
      {
        body: JSON.stringify(body),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Simple reminder repository request failed");
    }
    return response.json();
  }
}

export class SimpleReminderScheduler {
  readonly #batchSize: number;
  readonly #client: TelegramClient;
  readonly #intervalMilliseconds: number;
  readonly #now: () => Date;
  readonly #repository: SimpleReminderRepository;
  #activePoll: Promise<number> | null = null;
  #interval: NodeJS.Timeout | null = null;

  constructor(options: SimpleReminderSchedulerOptions) {
    this.#batchSize = options.batchSize ?? 5;
    this.#client = options.client;
    this.#intervalMilliseconds = options.intervalMilliseconds ?? 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;

    if (
      !Number.isSafeInteger(this.#batchSize) ||
      this.#batchSize < 1 ||
      this.#batchSize > 20 ||
      !Number.isSafeInteger(this.#intervalMilliseconds) ||
      this.#intervalMilliseconds < 100
    ) {
      throw new Error("Invalid simple reminder scheduler configuration");
    }
  }

  async poll(): Promise<number> {
    if (this.#activePoll) {
      return this.#activePoll;
    }
    this.#activePoll = this.#runPoll();
    try {
      return await this.#activePoll;
    } finally {
      this.#activePoll = null;
    }
  }

  start(): void {
    if (this.#interval) {
      return;
    }
    this.#interval = setInterval(() => {
      void this.poll().catch(() => undefined);
    }, this.#intervalMilliseconds);
    this.#interval.unref();
  }

  async stop(): Promise<void> {
    if (this.#interval) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    await this.#activePoll;
  }

  async #runPoll(): Promise<number> {
    const reminders = await this.#repository.claimDue(
      this.#now(),
      this.#batchSize,
    );
    for (const reminder of reminders) {
      await this.#deliver(reminder);
    }
    return reminders.length;
  }

  async #deliver(reminder: ClaimedSimpleReminder): Promise<void> {
    const reply = simpleReminderReply(reminder);
    try {
      const receipt = await this.#client.sendText(
        reminder.chatId,
        reply.text,
        reply.actions,
      );
      if (!receipt?.messageId || !positiveSafeInteger(receipt.messageId)) {
        throw new TelegramSendError("delivery_unknown");
      }
      await this.#repository.recordResult({
        attemptCount: reminder.attemptCount,
        messageId: reminder.id,
        recordedAt: this.#now(),
        result: "delivered",
        telegramMessageId: receipt.messageId,
      });
    } catch (error) {
      const failure =
        error instanceof TelegramSendError
          ? error
          : new TelegramSendError("delivery_unknown");
      if (failure.failure === "rate_limited") {
        const recordedAt = this.#now();
        const retryAtMilliseconds =
          recordedAt.getTime() +
          (failure.retryAfterSeconds ?? 0) * 1_000;
        const retryAt = new Date(retryAtMilliseconds);
        await this.#repository.recordResult({
          attemptCount: reminder.attemptCount,
          messageId: reminder.id,
          recordedAt,
          result: "rate_limited",
          ...(Number.isFinite(retryAt.getTime()) &&
          retryAt > recordedAt &&
          reminder.attemptCount < 3
            ? { retryAt }
            : {}),
        });
        return;
      }
      await this.#repository.recordResult({
        attemptCount: reminder.attemptCount,
        messageId: reminder.id,
        recordedAt: this.#now(),
        result: failure.failure,
      });
    }
  }
}
