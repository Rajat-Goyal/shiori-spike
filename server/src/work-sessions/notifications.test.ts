import { describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "../telegram/client.js";
import { TelegramSendError } from "../telegram/client.js";
import {
  type ClaimedWorkSessionMessage,
  type WorkSessionMessageRepository,
  type WorkSessionMessageResult,
  WorkSessionNotificationScheduler,
  workSessionNotificationReply,
  workSessionOutcomeReference,
} from "./notifications.js";

const startMessage: ClaimedWorkSessionMessage = {
  actionVersion: 1,
  attemptCount: 1,
  chatId: 123456789,
  commitmentId: "11111111-1111-4111-8111-111111111111",
  definitionOfDone: "Submit the synthetic note",
  endAt: "2026-07-27T03:00:00.000Z",
  id: "22222222-2222-4222-8222-222222222222",
  kind: "work_session_start",
  leaseToken: "33333333-3333-4333-8333-333333333333",
  logicalKey: "ws:44444444-4444-4444-8444-444444444444:start",
  startAt: "2026-07-27T02:00:00.000Z",
  workSessionId: "44444444-4444-4444-8444-444444444444",
};

class Repository implements WorkSessionMessageRepository {
  readonly begun: string[] = [];
  readonly results: WorkSessionMessageResult[] = [];
  due: ClaimedWorkSessionMessage[][] = [];

  async beginDelivery(message: Pick<ClaimedWorkSessionMessage, "id">) {
    this.begun.push(message.id);
  }

  async claimDue() {
    return this.due.shift() ?? [];
  }

  async recordResult(result: WorkSessionMessageResult) {
    this.results.push(result);
  }
}

describe("work-session notification contract", () => {
  it("offers Done at start and all three honest outcomes at the end", () => {
    expect(workSessionNotificationReply(startMessage).actions).toEqual([
      {
        callbackData:
          "s:44444444-4444-4444-8444-444444444444:1:done",
        text: "Done",
      },
    ]);
    expect(
      workSessionNotificationReply({
        ...startMessage,
        kind: "work_session_end",
      }).actions.map((action) => action.text),
    ).toEqual(["Done", "Need more time", "Missed this session"]);
  });

  it("rejects malformed action references", () => {
    expect(() =>
      workSessionOutcomeReference("not-a-uuid", 1, "done"),
    ).toThrow("Invalid work-session outcome reference");
    expect(() =>
      workSessionOutcomeReference(startMessage.workSessionId, 0, "done"),
    ).toThrow("Invalid work-session outcome reference");
  });
});

describe("WorkSessionNotificationScheduler", () => {
  it("crosses the durable boundary then records one confirmed delivery", async () => {
    const repository = new Repository();
    repository.due = [[startMessage]];
    const sendText = vi.fn(async () => ({ messageId: 71 }));
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-07-27T02:00:00.000Z"))
      .mockReturnValue(new Date("2026-07-27T02:00:01.000Z"));
    const scheduler = new WorkSessionNotificationScheduler({
      client: { sendText },
      now,
      repository,
    });

    await expect(scheduler.poll()).resolves.toBe(1);

    expect(repository.begun).toEqual([startMessage.id]);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(repository.results).toEqual([
      {
        attemptCount: 1,
        leaseToken: startMessage.leaseToken,
        messageId: startMessage.id,
        recordedAt: new Date("2026-07-27T02:00:01.000Z"),
        result: "delivered",
        telegramMessageId: 71,
      },
    ]);
  });

  it.each([
    "delivery_unknown",
    "permanent_failure",
  ] as const)("records %s without an unsafe retry", async (failure) => {
    const repository = new Repository();
    repository.due = [[startMessage], []];
    const client: TelegramClient = {
      async sendText() {
        throw new TelegramSendError(failure);
      },
    };
    const scheduler = new WorkSessionNotificationScheduler({
      client,
      repository,
    });

    await scheduler.poll();
    await scheduler.poll();

    expect(repository.results).toHaveLength(1);
    expect(repository.results[0]).toMatchObject({ result: failure });
  });

  it("records a validated rate limit as retryable before exhaustion", async () => {
    const repository = new Repository();
    repository.due = [[startMessage]];
    const client: TelegramClient = {
      async sendText() {
        throw new TelegramSendError("rate_limited", 10);
      },
    };
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-07-27T02:00:00.000Z"))
      .mockReturnValue(new Date("2026-07-27T02:00:01.000Z"));
    const scheduler = new WorkSessionNotificationScheduler({
      client,
      now,
      repository,
    });

    await scheduler.poll();

    expect(repository.results[0]).toMatchObject({
      result: "rate_limited",
      retryAt: new Date("2026-07-27T02:00:11.000Z"),
    });
  });
});
