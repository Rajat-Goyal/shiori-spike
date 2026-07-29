import { describe, expect, it, vi } from "vitest";
import {
  cancellationActionReference,
  parseSimpleCommitmentAction,
  SimpleCommitmentActionService,
  simpleCommitmentActionCopy,
  type SimpleCommitmentActionRepository,
  type SimpleCommitmentActionResult,
  SupabaseSimpleCommitmentActionRepository,
} from "./simple-action.js";
import type { TelegramClient } from "../telegram/client.js";
import type { TelegramRepository } from "../telegram/repository.js";
import { TelegramService } from "../telegram/service.js";

const ownerId = 123456789;
const commitmentId = "11111111-1111-4111-8111-111111111111";
const actionData = `p:${commitmentId}:1:done`;

type ActionCommand = Parameters<
  SimpleCommitmentActionRepository["resolve"]
>[0];

class ControlledRepository
  implements SimpleCommitmentActionRepository
{
  readonly commands: ActionCommand[] = [];
  failure = false;
  result: SimpleCommitmentActionResult = {
    completed: true,
    completedAt: "2026-07-27T02:05:17.123Z",
    kind: "done",
  };

  async resolve(
    command: ActionCommand,
  ): Promise<SimpleCommitmentActionResult> {
    this.commands.push(command);
    if (this.failure) {
      throw new Error("private database failure");
    }
    return this.result;
  }
}

describe("simple commitment action reference", () => {
  it("accepts only a strict opaque versioned Done or Cancel callback", () => {
    expect(parseSimpleCommitmentAction(actionData)).toEqual({
      action: "done",
      commitmentId,
      version: 1,
    });
    expect(
      parseSimpleCommitmentAction(`p:${commitmentId}:1:cancel`),
    ).toEqual({
      action: "cancel",
      commitmentId,
      version: 1,
    });
    expect(
      parseSimpleCommitmentAction(
        `x:${commitmentId}:2:confirm_cancel`,
      ),
    ).toEqual({
      action: "confirm_cancel",
      commitmentId,
      version: 2,
    });
    expect(
      cancellationActionReference(commitmentId, 2, "keep"),
    ).toBe(`x:${commitmentId}:2:keep`);
    expect(actionData.length).toBeLessThanOrEqual(64);

    for (const invalid of [
      `${actionData}:extra`,
      actionData.toUpperCase(),
      actionData.replace(":1:", ":0:"),
      actionData.replace(":1:", ":01:"),
      actionData.replace(":done", ":confirm"),
      `x:${commitmentId}:2:cancel`,
      `p:${commitmentId}:${Number.MAX_SAFE_INTEGER}0:done`,
      "not-an-action",
      null,
    ]) {
      expect(parseSimpleCommitmentAction(invalid)).toBeNull();
    }
  });
});

describe("SupabaseSimpleCommitmentActionRepository", () => {
  it("sends only bounded application-owned authority to the transition", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        completed: true,
        completedAt: "2026-07-27T02:05:17.123Z",
        kind: "done",
      }),
    );
    const repository = new SupabaseSimpleCommitmentActionRepository({
      fetch: fetchFromSupabase as typeof fetch,
      ownerId,
      supabaseSecretKey: "sb_secret_opaque-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(
      repository.resolve({
        action: "done",
        chatId: ownerId,
        commitmentId,
        updateId: 7001,
        version: 1,
      }),
    ).resolves.toEqual({
      completed: true,
      completedAt: "2026-07-27T02:05:17.123Z",
      kind: "done",
    });

    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/resolve_simple_reminder_action",
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      p_action: "done",
      p_commitment_id: commitmentId,
      p_owner_chat_id: ownerId,
      p_owner_id: String(ownerId),
      p_update_id: 7001,
      p_version: 1,
    });
    expect(String(options?.body)).not.toMatch(
      /definition|target|calendar|secret|token|payload/,
    );
  });

  it("routes the second cancellation confirmation to its dedicated RPC", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ completed: true, kind: "cancelled" }),
    );
    const repository = new SupabaseSimpleCommitmentActionRepository({
      fetch: fetchFromSupabase as typeof fetch,
      ownerId,
      supabaseSecretKey: "sb_secret_opaque-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await repository.resolve({
      action: "confirm_cancel",
      chatId: ownerId,
      commitmentId,
      updateId: 7002,
      version: 3,
    });

    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/resolve_commitment_cancellation_action",
    );
    expect(JSON.parse(String(options?.body))).toEqual({
      p_action: "confirm_cancel",
      p_commitment_id: commitmentId,
      p_owner_chat_id: ownerId,
      p_owner_id: String(ownerId),
      p_update_id: 7002,
      p_version: 3,
    });
  });

  it.each([
    {},
    { completed: false, kind: "done" },
    { completed: true, kind: "done" },
    {
      completed: true,
      completedAt: "invalid",
      kind: "already_done",
    },
  ])("fails closed on malformed repository result %#", async (body) => {
    const repository = new SupabaseSimpleCommitmentActionRepository({
      fetch: (async () => Response.json(body)) as typeof fetch,
      ownerId,
      supabaseSecretKey: "test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    await expect(
      repository.resolve({
        action: "done",
        chatId: ownerId,
        commitmentId,
        updateId: 7002,
        version: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("SimpleCommitmentActionService", () => {
  it.each([
    {
      copy: simpleCommitmentActionCopy.done,
      result: {
        completed: true,
        completedAt: "2026-07-27T02:05:17.123Z",
        kind: "done",
      } satisfies SimpleCommitmentActionResult,
    },
    {
      copy: simpleCommitmentActionCopy.alreadyDone,
      result: {
        completed: true,
        completedAt: "2026-07-27T02:05:17.123Z",
        kind: "already_done",
      } satisfies SimpleCommitmentActionResult,
    },
    {
      copy: simpleCommitmentActionCopy.alreadyCancelled,
      result: {
        completed: true,
        kind: "already_cancelled",
      } satisfies SimpleCommitmentActionResult,
    },
    {
      copy: simpleCommitmentActionCopy.cancelled,
      result: {
        completed: true,
        kind: "cancelled",
      } satisfies SimpleCommitmentActionResult,
    },
    {
      copy: simpleCommitmentActionCopy.kept,
      result: {
        completed: true,
        kind: "kept",
      } satisfies SimpleCommitmentActionResult,
    },
    {
      copy: simpleCommitmentActionCopy.stale,
      result: {
        completed: true,
        kind: "stale",
      } satisfies SimpleCommitmentActionResult,
    },
    {
      copy: simpleCommitmentActionCopy.malformed,
      result: {
        completed: true,
        kind: "malformed",
      } satisfies SimpleCommitmentActionResult,
    },
  ])("returns the bounded $result.kind copy", async ({ copy, result }) => {
    const repository = new ControlledRepository();
    repository.result = result;
    const service = new SimpleCommitmentActionService({ repository });

    await expect(
      service.handle(7003, ownerId, actionData),
    ).resolves.toEqual({ text: copy });
  });

  it("renders only the current opaque second-confirmation actions", async () => {
    const repository = new ControlledRepository();
    repository.result = {
      commitmentId,
      completed: true,
      kind: "cancel_pending",
      version: 4,
    };
    const service = new SimpleCommitmentActionService({ repository });

    await expect(
      service.handle(
        7004,
        ownerId,
        `p:${commitmentId}:1:cancel`,
      ),
    ).resolves.toEqual({
      actions: [
        {
          callbackData: `x:${commitmentId}:4:confirm_cancel`,
          text: "Confirm cancellation",
        },
        {
          callbackData: `x:${commitmentId}:4:keep`,
          text: "Keep",
        },
      ],
      text: simpleCommitmentActionCopy.cancelPrompt,
    });
  });

  it("passes no inferred authority for malformed callback data", async () => {
    const repository = new ControlledRepository();
    repository.result = { completed: true, kind: "malformed" };
    const service = new SimpleCommitmentActionService({ repository });

    await expect(
      service.handle(7004, ownerId, "private malformed material"),
    ).resolves.toEqual({ text: simpleCommitmentActionCopy.malformed });
    expect(repository.commands).toEqual([
      {
        action: null,
        chatId: ownerId,
        commitmentId: null,
        updateId: 7004,
        version: null,
      },
    ]);
  });

  it("suppresses exact Telegram update replay", async () => {
    const repository = new ControlledRepository();
    repository.result = { kind: "replay" };
    const service = new SimpleCommitmentActionService({ repository });

    await expect(
      service.handle(7005, ownerId, actionData),
    ).resolves.toBeNull();
  });

  it("does not claim success when the transaction outcome is uncertain", async () => {
    const repository = new ControlledRepository();
    repository.failure = true;
    const service = new SimpleCommitmentActionService({ repository });

    await expect(
      service.handle(7006, ownerId, actionData),
    ).resolves.toEqual({ text: simpleCommitmentActionCopy.uncertain });
  });
});

describe("Telegram simple commitment callback routing", () => {
  it("routes owner-private p: actions once without draft interpretation", async () => {
    const sends: Array<{ actions: unknown; chatId: number; text: string }> =
      [];
    const client: TelegramClient = {
      async answerCallbackQuery() {},
      async sendText(chatId, text, actions) {
        sends.push({ actions, chatId, text });
      },
    };
    const claims = vi.fn();
    const completions = vi.fn();
    const telegramRepository: TelegramRepository = {
      claimUpdate: claims,
      completeUpdate: completions,
      hasActiveCommitments: vi.fn(async () => false),
    };
    const reminderHandler = vi.fn(async () => ({
      text: simpleCommitmentActionCopy.done,
    }));
    const confirmationHandler = vi.fn();
    const callbackContext = { record: vi.fn(async () => undefined) };
    const service = new TelegramService({
      callbackContextService: callbackContext,
      client,
      confirmationService: { handle: confirmationHandler },
      conversationService: { handle: vi.fn() },
      ownerUserId: ownerId,
      repository: telegramRepository,
      simpleCommitmentActionService: { handle: reminderHandler },
    });

    await service.handle({
      callback_query: {
        data: actionData,
        from: { id: ownerId },
        id: "callback-7007",
        message: {
          chat: { id: ownerId, type: "private" },
        },
      },
      update_id: 7007,
    });

    expect(reminderHandler).toHaveBeenCalledWith(
      7007,
      ownerId,
      actionData,
    );
    expect(confirmationHandler).not.toHaveBeenCalled();
    expect(callbackContext.record).toHaveBeenCalledWith(
      7007,
      ownerId,
      actionData,
      { text: simpleCommitmentActionCopy.done },
    );
    expect(claims).not.toHaveBeenCalled();
    expect(completions).not.toHaveBeenCalled();
    expect(sends).toEqual([
      {
        actions: undefined,
        chatId: ownerId,
        text: simpleCommitmentActionCopy.done,
      },
    ]);
  });
});
