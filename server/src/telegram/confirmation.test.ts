import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationService,
  type ConfirmationRepository,
  type ConfirmationResult,
  confirmationCopy,
  confirmationSummary,
  draftActionReference,
  formatSingaporeTarget,
  parseDraftAction,
  SupabaseConfirmationRepository,
  type TelegramInlineAction,
} from "../confirmation.js";
import {
  TelegramBotClient,
  type TelegramClient,
} from "./client.js";
import type {
  TelegramProcessingResult,
  TelegramRepository,
} from "./repository.js";
import { TelegramService } from "./service.js";

const ownerId = 123456789;
const draft = {
  definitionOfDone: "Submit the synthetic note",
  id: "11111111-1111-4111-8111-111111111111",
  targetAt: "2026-07-27T10:05:00+08:00",
  version: 4,
};

type ConfirmationCommand = Parameters<ConfirmationRepository["resolve"]>[0];

class ControlledConfirmationRepository
  implements ConfirmationRepository
{
  readonly commands: ConfirmationCommand[] = [];
  failure = false;
  result: ConfirmationResult = {
    completed: true,
    kind: "confirmed",
    reminderAt: draft.targetAt,
  };

  async resolve(command: ConfirmationCommand): Promise<ConfirmationResult> {
    this.commands.push(command);
    if (this.failure) {
      throw new Error("private database failure");
    }
    return this.result;
  }
}

function confirmationWith(result?: ConfirmationResult) {
  const repository = new ControlledConfirmationRepository();
  if (result) {
    repository.result = result;
  }
  return {
    repository,
    service: new ConfirmationService({ repository }),
  };
}

describe("simple confirmation copy and action references", () => {
  it("renders the exact full summary and one Confirm/Cancel row", () => {
    expect(confirmationSummary(draft, draft)).toEqual({
      actions: [
        {
          callbackData:
            "d:11111111-1111-4111-8111-111111111111:4:confirm",
          text: "Confirm",
        },
        {
          callbackData:
            "d:11111111-1111-4111-8111-111111111111:4:cancel",
          text: "Cancel",
        },
      ],
      text: [
        "Please confirm this promise.",
        "",
        "Definition of done: Submit the synthetic note",
        "Target: 27 Jul 2026 at 10:05 AM SGT (UTC+08:00)",
        "Reminder: 27 Jul 2026 at 10:05 AM SGT (UTC+08:00)",
        "Calendar availability: Not checked.",
        "Google Calendar will not be changed.",
        "Nothing has been saved yet.",
      ].join("\n"),
    });
  });

  it("includes seconds only when nonzero", () => {
    expect(
      formatSingaporeTarget("2026-07-27T10:05:09+08:00"),
    ).toBe("27 Jul 2026 at 10:05:09 AM SGT (UTC+08:00)");
    expect(
      formatSingaporeTarget("2026-07-27T12:05:00+08:00"),
    ).toBe("27 Jul 2026 at 12:05 PM SGT (UTC+08:00)");
    expect(
      formatSingaporeTarget("2026-07-27T00:05:00+08:00"),
    ).toBe("27 Jul 2026 at 12:05 AM SGT (UTC+08:00)");
  });

  it("accepts only a strict full lowercase bounded action reference", () => {
    const valid =
      "d:11111111-1111-4111-8111-111111111111:4:confirm";
    expect(parseDraftAction(valid)).toEqual({
      action: "confirm",
      id: draft.id,
      version: 4,
    });
    expect(valid.length).toBeLessThanOrEqual(64);

    for (const invalid of [
      `${valid}:extra`,
      valid.toUpperCase(),
      valid.replace(":4:", ":0:"),
      valid.replace(":4:", ":04:"),
      valid.replace(":confirm", ":done"),
      `d:${draft.id}:${Number.MAX_SAFE_INTEGER}0:confirm`,
      "not-an-action",
      null,
    ]) {
      expect(parseDraftAction(invalid)).toBeNull();
    }
  });

  it("rejects an invalid generated reference or target", () => {
    expect(() =>
      draftActionReference({ id: "not-a-uuid", version: 1 }, "confirm"),
    ).toThrow("Invalid draft action reference");
    expect(() =>
      formatSingaporeTarget("2026-02-30T10:00:00+08:00"),
    ).toThrow("Invalid Singapore target");
  });
});

describe("SupabaseConfirmationRepository", () => {
  it("sends only the bounded authoritative action and parses a completed result", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        completed: true,
        kind: "confirmed",
        reminderAt: draft.targetAt,
      }),
    );
    const repository = new SupabaseConfirmationRepository({
      fetch: fetchFromSupabase as typeof fetch,
      ownerId,
      supabaseSecretKey: "sb_secret_opaque-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(
      repository.resolve({
        action: "confirm",
        chatId: ownerId,
        draftId: draft.id,
        updateId: 9001,
        version: draft.version,
      }),
    ).resolves.toEqual({
      completed: true,
      kind: "confirmed",
      reminderAt: draft.targetAt,
    });

    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/resolve_simple_draft_action",
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      p_action: "confirm",
      p_draft_id: draft.id,
      p_owner_chat_id: ownerId,
      p_owner_id: String(ownerId),
      p_update_id: 9001,
      p_version: 4,
    });
    expect(String(options?.body)).not.toMatch(
      /definition|target|calendar|secret|token|ownerText|payload/,
    );
  });

  it.each([
    {},
    { completed: false, kind: "cancelled" },
    { completed: true, kind: "confirmed", reminderAt: "invalid" },
    {
      completed: true,
      draft: { ...draft, version: 0 },
      kind: "stale",
    },
  ])("fails closed on malformed repository result %#", async (body) => {
    const repository = new SupabaseConfirmationRepository({
      fetch: (async () => Response.json(body)) as typeof fetch,
      ownerId,
      supabaseSecretKey: "test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(
      repository.resolve({
        action: "confirm",
        chatId: ownerId,
        draftId: draft.id,
        updateId: 9002,
        version: 4,
      }),
    ).rejects.toThrow();
  });
});

describe("ConfirmationService", () => {
  it.each([
    {
      copy: "Promise saved. I’ll remind you at 27 Jul 2026 at 10:05 AM SGT (UTC+08:00).",
      result: {
        completed: true,
        kind: "confirmed",
        reminderAt: draft.targetAt,
      } satisfies ConfirmationResult,
    },
    {
      copy: confirmationCopy.cancelled,
      result: {
        completed: true,
        kind: "cancelled",
      } satisfies ConfirmationResult,
    },
    {
      copy: confirmationCopy.alreadyConfirmed,
      result: {
        completed: true,
        kind: "already_confirmed",
      } satisfies ConfirmationResult,
    },
    {
      copy: confirmationCopy.alreadyCancelled,
      result: {
        completed: true,
        kind: "already_cancelled",
      } satisfies ConfirmationResult,
    },
    {
      copy: confirmationCopy.expired,
      result: {
        completed: true,
        kind: "expired",
      } satisfies ConfirmationResult,
    },
    {
      copy: confirmationCopy.malformed,
      result: {
        completed: true,
        kind: "malformed",
      } satisfies ConfirmationResult,
    },
  ])("returns the exact bounded '$result.kind' result", async ({ copy, result }) => {
    const test = confirmationWith(result);

    await expect(
      test.service.handle(
        9003,
        ownerId,
        `d:${draft.id}:4:confirm`,
      ),
    ).resolves.toEqual({ text: copy });
  });

  it("rerenders the authoritative current summary for a stale action", async () => {
    const test = confirmationWith({
      completed: true,
      draft,
      kind: "stale",
    });

    await expect(
      test.service.handle(
        9004,
        ownerId,
        `d:${draft.id}:3:confirm`,
      ),
    ).resolves.toEqual(
      confirmationSummary(draft, draft, confirmationCopy.stale),
    );
  });

  it("claims malformed callback data without passing any inferred authority", async () => {
    const test = confirmationWith({
      completed: true,
      kind: "malformed",
    });

    await expect(
      test.service.handle(9005, ownerId, "private malformed material"),
    ).resolves.toEqual({ text: confirmationCopy.malformed });
    expect(test.repository.commands).toEqual([
      {
        action: null,
        chatId: ownerId,
        draftId: null,
        updateId: 9005,
        version: null,
      },
    ]);
  });

  it.each([
    {
      action: "confirm",
      copy: confirmationCopy.uncertainConfirm,
    },
    {
      action: "cancel",
      copy: confirmationCopy.uncertainCancel,
    },
  ] as const)(
    "does not claim success when the '$action' transaction fails",
    async ({ action, copy }) => {
      const test = confirmationWith();
      test.repository.failure = true;

      await expect(
        test.service.handle(
          9006,
          ownerId,
          `d:${draft.id}:4:${action}`,
        ),
      ).resolves.toEqual({ text: copy });
    },
  );

  it("suppresses every visible effect for a claimed Telegram replay", async () => {
    const test = confirmationWith({ kind: "replay" });

    await expect(
      test.service.handle(
        9007,
        ownerId,
        `d:${draft.id}:4:confirm`,
      ),
    ).resolves.toBeNull();
  });
});

class ControlledTelegramClient implements TelegramClient {
  readonly answers: string[] = [];
  readonly sends: Array<{
    actions?: readonly TelegramInlineAction[];
    chatId: number;
    text: string;
  }> = [];

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answers.push(callbackQueryId);
  }

  async sendText(
    chatId: number,
    text: string,
    actions?: readonly TelegramInlineAction[],
  ): Promise<void> {
    this.sends.push({
      ...(actions ? { actions } : {}),
      chatId,
      text,
    });
  }
}

class ControlledTelegramRepository implements TelegramRepository {
  readonly claims: Array<{ ownerChatId?: number; updateId: number }> = [];
  readonly completions: Array<{
    result: TelegramProcessingResult;
    updateId: number;
  }> = [];

  async claimUpdate(updateId: number, ownerChatId?: number): Promise<boolean> {
    this.claims.push({ ownerChatId, updateId });
    return true;
  }

  async completeUpdate(
    updateId: number,
    result: TelegramProcessingResult,
  ): Promise<void> {
    this.completions.push({ result, updateId });
  }

  async hasActiveCommitments(): Promise<boolean> {
    return false;
  }
}

function callbackUpdate(options: {
  chatId?: number;
  chatType?: string;
  data?: unknown;
  fromId?: number;
  updateId: number;
}) {
  return {
    callback_query: {
      data: options.data ?? `d:${draft.id}:4:confirm`,
      from: { id: options.fromId ?? ownerId },
      id: `callback-${options.updateId}`,
      message: {
        chat: {
          id: options.chatId ?? ownerId,
          type: options.chatType ?? "private",
        },
      },
    },
    update_id: options.updateId,
  };
}

describe("authorized Telegram callback boundary", () => {
  it.each([
    `w:${draft.id}:4:help`,
    `s:${draft.id}:4:done`,
    `c:${draft.id}:4:duration_60`,
  ])("routes %s through the work-session lifecycle boundary", async (data) => {
    const client = new ControlledTelegramClient();
    const repository = new ControlledTelegramRepository();
    const workSession = {
      handle: vi.fn(async () => ({ text: "Work-session result" })),
    };
    const confirmation = { handle: vi.fn() };
    const service = new TelegramService({
      client,
      confirmationService: confirmation,
      conversationService: { handle: vi.fn() },
      ownerUserId: ownerId,
      repository,
      workSessionActionService: workSession,
    });

    await service.handle(
      callbackUpdate({ data, updateId: 9090 }),
    );

    expect(workSession.handle).toHaveBeenCalledWith(
      9090,
      ownerId,
      data,
    );
    expect(confirmation.handle).not.toHaveBeenCalled();
    expect(client.answers).toEqual(["callback-9090"]);
    expect(client.sends).toEqual([
      {
        actions: undefined,
        chatId: ownerId,
        text: "Work-session result",
      },
    ]);
  });

  it("delegates owner-private authority once, clears the spinner, and sends one visible result", async () => {
    const client = new ControlledTelegramClient();
    const repository = new ControlledTelegramRepository();
    const confirmation = {
      handle: vi.fn(async () => confirmationSummary(draft, draft)),
    };
    const conversation = { handle: vi.fn() };
    const service = new TelegramService({
      client,
      confirmationService: confirmation,
      conversationService: conversation,
      ownerUserId: ownerId,
      repository,
    });

    await service.handle(callbackUpdate({ updateId: 9101 }));

    expect(confirmation.handle).toHaveBeenCalledWith(
      9101,
      ownerId,
      `d:${draft.id}:4:confirm`,
    );
    expect(client.answers).toEqual(["callback-9101"]);
    expect(client.sends).toEqual([
      {
        actions: confirmationSummary(draft, draft).actions,
        chatId: ownerId,
        text: confirmationSummary(draft, draft).text,
      },
    ]);
    expect(repository.claims).toEqual([]);
    expect(repository.completions).toEqual([]);
    expect(conversation.handle).not.toHaveBeenCalled();
  });

  it("sends and acknowledges nothing when the atomic callback claim reports replay", async () => {
    const client = new ControlledTelegramClient();
    const repository = new ControlledTelegramRepository();
    const service = new TelegramService({
      client,
      confirmationService: { handle: vi.fn(async () => null) },
      conversationService: { handle: vi.fn() },
      ownerUserId: ownerId,
      repository,
    });

    await service.handle(callbackUpdate({ updateId: 9102 }));

    expect(client.answers).toEqual([]);
    expect(client.sends).toEqual([]);
    expect(repository.claims).toEqual([]);
  });

  it.each([
    callbackUpdate({ fromId: ownerId + 1, updateId: 9103 }),
    callbackUpdate({
      chatId: -123,
      chatType: "group",
      updateId: 9104,
    }),
  ])("keeps callback authority behind the owner-private boundary", async (update) => {
    const client = new ControlledTelegramClient();
    const repository = new ControlledTelegramRepository();
    const confirmation = { handle: vi.fn() };
    const service = new TelegramService({
      client,
      confirmationService: confirmation,
      conversationService: { handle: vi.fn() },
      ownerUserId: ownerId,
      repository,
    });

    await service.handle(update);

    expect(confirmation.handle).not.toHaveBeenCalled();
    expect(client.sends).toEqual([
      {
        chatId: update.callback_query.message.chat.id,
        text: "I can’t help in this chat.",
      },
    ]);
    expect(repository.completions).toEqual([
      { result: "refused", updateId: update.update_id },
    ]);
  });
});

describe("TelegramBotClient confirmation delivery", () => {
  it("uses an empty callback acknowledgement and one plain-text message with one action row", async () => {
    const telegramFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = new TelegramBotClient({
      botToken: "test-bot-token",
      fetch: telegramFetch as typeof fetch,
    });
    const reply = confirmationSummary(draft, draft);

    await client.answerCallbackQuery("callback-9201");
    await client.sendText(ownerId, reply.text, reply.actions);

    expect(telegramFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.telegram.org/bottest-bot-token/answerCallbackQuery",
      "https://api.telegram.org/bottest-bot-token/sendMessage",
    ]);
    expect(JSON.parse(String(telegramFetch.mock.calls[0][1]?.body))).toEqual({
      callback_query_id: "callback-9201",
    });
    expect(JSON.parse(String(telegramFetch.mock.calls[1][1]?.body))).toEqual({
      chat_id: ownerId,
      reply_markup: {
        inline_keyboard: [
          [
            {
              callback_data:
                "d:11111111-1111-4111-8111-111111111111:4:confirm",
              text: "Confirm",
            },
            {
              callback_data:
                "d:11111111-1111-4111-8111-111111111111:4:cancel",
              text: "Cancel",
            },
          ],
        ],
      },
      text: reply.text,
    });
  });
});
