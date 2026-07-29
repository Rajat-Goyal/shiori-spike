import { describe, expect, it, vi } from "vitest";
import type { TelegramClient } from "./client.js";
import type {
  TelegramProcessingResult,
  TelegramRepository,
} from "./repository.js";
import { TelegramService } from "./service.js";
import {
  type ActivePromiseStatus,
  statusReplies,
  StatusService,
  SupabaseStatusRepository,
} from "./status-cancel.js";

const ownerId = 123456789;
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

const simpleStatus: ActivePromiseStatus = {
  calendarCheckedAt: null,
  calendarStatus: null,
  definitionOfDone: "Submit the bounded note",
  id: secondId,
  nextAt: "2026-07-25T02:00:00.000Z",
  nextKind: "simple_reminder",
  targetAt: "2026-07-25T02:00:00.000Z",
};
const workStatus: ActivePromiseStatus = {
  calendarCheckedAt: "2026-07-24T23:30:00.000Z",
  calendarStatus: "free",
  definitionOfDone: "Finish the bounded work",
  id: firstId,
  nextAt: "2026-07-25T01:00:00.000Z",
  nextKind: "work_session",
  targetAt: "2026-07-25T02:00:00.000Z",
};

describe("Telegram active promise status", () => {
  it("orders by target and ID and renders every required field with one action row", () => {
    const replies = statusReplies(
      [simpleStatus, workStatus],
      new Date("2026-07-25T03:00:00.000Z"),
    );

    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual({
      actions: [
        {
          callbackData: `p:${firstId}:1:done`,
          text: "Done",
        },
        {
          callbackData: `p:${firstId}:1:cancel`,
          text: "Cancel",
        },
      ],
      text: [
        "Promise 1 of 2",
        "",
        "Definition of done: Finish the bounded work",
        "Target: 25 Jul 2026 at 10:00 AM SGT (UTC+08:00)",
        "Status: Overdue",
        "Next: Work session at 25 Jul 2026 at 9:00 AM SGT (UTC+08:00).",
        "Calendar check: Free when checked at 25 Jul 2026 at 7:30 AM SGT (UTC+08:00).",
      ].join("\n"),
    });
    expect(replies[1].text).toContain("Promise 2 of 2");
    expect(replies[1].text).toContain(
      "Next: Simple reminder at 25 Jul 2026 at 10:00 AM SGT (UTC+08:00).",
    );
    expect(replies[1].text).toContain(
      "Calendar check: Not applicable.",
    );
    expect(JSON.stringify(replies)).not.toMatch(
      /eventTitle|attendee|description|secret|token/i,
    );
  });

  it("fails closed on inconsistent repository data", async () => {
    const repository = new SupabaseStatusRepository({
      fetch: (async () =>
        Response.json([
          {
            ...workStatus,
            calendarCheckedAt: null,
          },
        ])) as typeof fetch,
      ownerId,
      supabaseSecretKey: "test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(repository.listActive()).rejects.toThrow(
      "Telegram status returned inconsistent data",
    );
  });

  it("routes /status through the same conversational agent as other text", async () => {
    const sends: Array<{
      actions: unknown;
      chatId: number;
      text: string;
    }> = [];
    const completions: Array<{
      result: TelegramProcessingResult;
      updateId: number;
    }> = [];
    const client: TelegramClient = {
      async sendText(chatId, text, actions) {
        sends.push({ actions, chatId, text });
      },
    };
    const repository: TelegramRepository = {
      async claimUpdate() {
        return true;
      },
      async completeUpdate(updateId, result) {
        completions.push({ result, updateId });
      },
      async hasActiveCommitments() {
        return false;
      },
    };
    const conversation = vi
      .fn()
      .mockResolvedValueOnce("Promise summary from the agent.")
      .mockResolvedValueOnce("No active promises.");
    const service = new TelegramService({
      client,
      conversationService: { handle: conversation },
      ownerUserId: ownerId,
      repository,
    });
    const update = (updateId: number) => ({
      message: {
        chat: { id: ownerId, type: "private" },
        from: { id: ownerId },
        text: "/status",
      },
      update_id: updateId,
    });

    await service.handle(update(7100));
    await service.handle(update(7101));

    expect(sends).toEqual([
      {
        actions: undefined,
        chatId: ownerId,
        text: "Promise summary from the agent.",
      },
      {
        actions: undefined,
        chatId: ownerId,
        text: "No active promises.",
      },
    ]);
    expect(conversation.mock.calls).toEqual([
      [7100, "/status"],
      [7101, "/status"],
    ]);
    expect(completions).toEqual([]);
  });
});
