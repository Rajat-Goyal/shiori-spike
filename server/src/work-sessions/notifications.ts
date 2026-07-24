import {
  formatSingaporeTarget,
  type TelegramInlineAction,
} from "../confirmation.js";
import { supabaseHeaders } from "../supabase.js";
import {
  type TelegramClient,
  TelegramSendError,
} from "../telegram/client.js";

export type WorkSessionMessageKind =
  | "work_session_start"
  | "work_session_end";

export type ClaimedWorkSessionMessage = Readonly<{
  actionVersion: number;
  attemptCount: number;
  chatId: number;
  commitmentId: string;
  definitionOfDone: string;
  endAt: string;
  id: string;
  kind: WorkSessionMessageKind;
  leaseToken: string;
  logicalKey: string;
  startAt: string;
  workSessionId: string;
}>;

export type WorkSessionMessageResult =
  | Readonly<{
      attemptCount: number;
      leaseToken: string;
      messageId: string;
      recordedAt: Date;
      result: "delivery_unknown" | "permanent_failure";
    }>
  | Readonly<{
      attemptCount: number;
      leaseToken: string;
      messageId: string;
      recordedAt: Date;
      result: "delivered";
      telegramMessageId: number;
    }>
  | Readonly<{
      attemptCount: number;
      leaseToken: string;
      messageId: string;
      recordedAt: Date;
      result: "rate_limited";
      retryAt?: Date;
    }>;

export interface WorkSessionMessageRepository {
  beginDelivery(
    message: Pick<
      ClaimedWorkSessionMessage,
      "attemptCount" | "id" | "leaseToken"
    >,
    startedAt: Date,
  ): Promise<void>;
  claimDue(now: Date, limit: number): Promise<ClaimedWorkSessionMessage[]>;
  recordResult(result: WorkSessionMessageResult): Promise<void>;
}

type SupabaseWorkSessionMessageRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

type WorkSessionNotificationSchedulerOptions = Readonly<{
  batchSize?: number;
  client: TelegramClient;
  intervalMilliseconds?: number;
  now?: () => Date;
  repository: WorkSessionMessageRepository;
}>;

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

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(new Date(value).getTime())
  );
}

function singaporeInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Invalid work-session instant");
  }
  const local = new Date(parsed.getTime() + 8 * 60 * 60 * 1_000);
  return `${local.toISOString().slice(0, 19)}+08:00`;
}

function parseClaimedMessage(value: unknown): ClaimedWorkSessionMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.logical_key !== "string" ||
    value.logical_key.length < 1 ||
    value.logical_key.length > 100 ||
    typeof value.commitment_id !== "string" ||
    !UUID_PATTERN.test(value.commitment_id) ||
    typeof value.work_session_id !== "string" ||
    !UUID_PATTERN.test(value.work_session_id) ||
    !["work_session_start", "work_session_end"].includes(
      String(value.kind),
    ) ||
    !positiveSafeInteger(value.action_version) ||
    !positiveSafeInteger(value.attempt_count) ||
    typeof value.lease_token !== "string" ||
    !UUID_PATTERN.test(value.lease_token) ||
    !positiveSafeInteger(value.chat_id) ||
    typeof value.definition_of_done !== "string" ||
    value.definition_of_done.trim().length === 0 ||
    !instant(value.start_at) ||
    !instant(value.end_at) ||
    Date.parse(value.end_at) <= Date.parse(value.start_at)
  ) {
    throw new Error("Work-session claim returned an invalid response");
  }
  return {
    actionVersion: value.action_version,
    attemptCount: value.attempt_count,
    chatId: value.chat_id,
    commitmentId: value.commitment_id,
    definitionOfDone: value.definition_of_done,
    endAt: value.end_at,
    id: value.id,
    kind: value.kind as WorkSessionMessageKind,
    leaseToken: value.lease_token,
    logicalKey: value.logical_key,
    startAt: value.start_at,
    workSessionId: value.work_session_id,
  };
}

export function workSessionOutcomeReference(
  workSessionId: string,
  version: number,
  action: "done" | "missed" | "more",
): string {
  const value = `s:${workSessionId}:${version}:${action}`;
  if (
    !UUID_PATTERN.test(workSessionId) ||
    !positiveSafeInteger(version) ||
    value.length > 64
  ) {
    throw new Error("Invalid work-session outcome reference");
  }
  return value;
}

export function workSessionNotificationReply(
  message: Pick<
    ClaimedWorkSessionMessage,
    | "actionVersion"
    | "definitionOfDone"
    | "endAt"
    | "kind"
    | "startAt"
    | "workSessionId"
  >,
): Readonly<{
  actions: readonly TelegramInlineAction[];
  text: string;
}> {
  const done: TelegramInlineAction = {
    callbackData: workSessionOutcomeReference(
      message.workSessionId,
      message.actionVersion,
      "done",
    ),
    text: "Done",
  };
  if (message.kind === "work_session_start") {
    return {
      actions: [done],
      text: [
        "Your work session starts now.",
        "",
        `Definition of done: ${message.definitionOfDone}`,
        `Ends: ${formatSingaporeTarget(singaporeInstant(message.endAt))}`,
      ].join("\n"),
    };
  }
  return {
    actions: [
      done,
      {
        callbackData: workSessionOutcomeReference(
          message.workSessionId,
          message.actionVersion,
          "more",
        ),
        text: "Need more time",
      },
      {
        callbackData: workSessionOutcomeReference(
          message.workSessionId,
          message.actionVersion,
          "missed",
        ),
        text: "Missed this session",
      },
    ],
    text: [
      "Your work session has ended.",
      "",
      `Definition of done: ${message.definitionOfDone}`,
      `Started: ${formatSingaporeTarget(singaporeInstant(message.startAt))}`,
      "How did it go?",
    ].join("\n"),
  };
}

export class SupabaseWorkSessionMessageRepository
  implements WorkSessionMessageRepository
{
  readonly #fetch: typeof fetch;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseWorkSessionMessageRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async claimDue(
    now: Date,
    limit: number,
  ): Promise<ClaimedWorkSessionMessage[]> {
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    ) {
      throw new Error("Invalid work-session claim");
    }
    const response = await this.#rpc(
      "claim_due_work_session_messages",
      {
        p_limit: limit,
        p_now: now.toISOString(),
      },
    );
    if (!Array.isArray(response)) {
      throw new Error("Work-session claim returned an invalid response");
    }
    return response.map(parseClaimedMessage);
  }

  async beginDelivery(
    message: Pick<
      ClaimedWorkSessionMessage,
      "attemptCount" | "id" | "leaseToken"
    >,
    startedAt: Date,
  ): Promise<void> {
    const response = await this.#rpc(
      "begin_work_session_message_delivery",
      {
        p_attempt_count: message.attemptCount,
        p_lease_token: message.leaseToken,
        p_message_id: message.id,
        p_started_at: startedAt.toISOString(),
      },
    );
    if (
      !isRecord(response) ||
      response.applied !== true ||
      response.state !== "claimed"
    ) {
      throw new Error("Work-session delivery start was not applied");
    }
  }

  async recordResult(result: WorkSessionMessageResult): Promise<void> {
    const response = await this.#rpc(
      "record_work_session_message_result",
      {
        p_attempt_count: result.attemptCount,
        p_lease_token: result.leaseToken,
        p_message_id: result.messageId,
        p_recorded_at: result.recordedAt.toISOString(),
        p_result: result.result,
        p_retry_at:
          result.result === "rate_limited" && result.retryAt
            ? result.retryAt.toISOString()
            : null,
        p_telegram_message_id:
          result.result === "delivered"
            ? result.telegramMessageId
            : null,
      },
    );
    if (
      !isRecord(response) ||
      response.applied !== true ||
      typeof response.state !== "string"
    ) {
      throw new Error("Work-session delivery result was not applied");
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
      throw new Error("Work-session message repository request failed");
    }
    return response.json();
  }
}

export class WorkSessionNotificationScheduler {
  readonly #batchSize: number;
  readonly #client: TelegramClient;
  readonly #intervalMilliseconds: number;
  readonly #now: () => Date;
  readonly #repository: WorkSessionMessageRepository;
  #activePoll: Promise<number> | null = null;
  #interval: NodeJS.Timeout | null = null;

  constructor(options: WorkSessionNotificationSchedulerOptions) {
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
      throw new Error(
        "Invalid work-session notification scheduler configuration",
      );
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
    const messages = await this.#repository.claimDue(
      this.#now(),
      this.#batchSize,
    );
    for (const message of messages) {
      await this.#deliver(message);
    }
    return messages.length;
  }

  async #deliver(message: ClaimedWorkSessionMessage): Promise<void> {
    const reply = workSessionNotificationReply(message);
    await this.#repository.beginDelivery(
      {
        attemptCount: message.attemptCount,
        id: message.id,
        leaseToken: message.leaseToken,
      },
      this.#now(),
    );
    try {
      const receipt = await this.#client.sendText(
        message.chatId,
        reply.text,
        reply.actions,
      );
      if (!receipt?.messageId || !positiveSafeInteger(receipt.messageId)) {
        throw new TelegramSendError("delivery_unknown");
      }
      await this.#repository.recordResult({
        attemptCount: message.attemptCount,
        leaseToken: message.leaseToken,
        messageId: message.id,
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
        const retryAt = new Date(
          recordedAt.getTime() +
            (failure.retryAfterSeconds ?? 0) * 1_000,
        );
        await this.#repository.recordResult({
          attemptCount: message.attemptCount,
          leaseToken: message.leaseToken,
          messageId: message.id,
          recordedAt,
          result: "rate_limited",
          ...(retryAt > recordedAt && message.attemptCount < 3
            ? { retryAt }
            : {}),
        });
        return;
      }
      await this.#repository.recordResult({
        attemptCount: message.attemptCount,
        leaseToken: message.leaseToken,
        messageId: message.id,
        recordedAt: this.#now(),
        result: failure.failure,
      });
    }
  }
}
