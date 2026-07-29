import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { buildApp, type AppOptions } from "../app.js";
import type { ServerConfig } from "../config.js";
import { conversationCopy } from "../conversation/copy.js";
import type {
  ConversationApplyResult,
  ConversationCommand,
  ConversationRepository,
} from "../conversation/repository.js";
import { ConversationService } from "../conversation/service.js";
import type { DecisionEngine } from "../decision/engine.js";
import type { DecisionContextFields } from "../decision/schema.js";
import type { TelegramClient } from "./client.js";
import {
  type TelegramProcessingResult,
  type TelegramRepository,
} from "./repository.js";
import { TelegramService } from "./service.js";
import type { TelegramUpdateHandler } from "./webhook.js";

const ownerUserId = 123456789;
const webhookSecret = "unit-test-webhook-secret";
const config: ServerConfig = {
  agentSessionRetentionSeconds: 2_592_000,
  dashboardPasswordHash:
    "$argon2id$v=19$m=65536,t=3,p=1$c2hpb3JpLXRlc3Qtc2FsdA$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ",
  dashboardSessionSecret: Buffer.alloc(32, 9).toString("base64"),
  googleOAuthClientId: "google-test-client.apps.googleusercontent.com",
  googleOAuthClientSecret: "unit-test-google-client-secret",
  googleOwnerEmail: "owner@example.com",
  googleTokenEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
  googleTokenKeyVersion: 1,
  openaiApiKey: "unit-test-openai-key",
  openaiModel: "gpt-test-model",
  openaiPromptVersion: "shiori-test-v1",
  ownerTimeZone: "Asia/Singapore",
  publicAppBaseUrl: "http://localhost:3000",
  supabaseSecretKey: "unit-test-supabase-key",
  supabaseUrl: "http://127.0.0.1:54321",
  telegramBotToken: "unit-test-bot-token",
  telegramOwnerUserId: ownerUserId,
  telegramWebhookSecret: webhookSecret,
};

type Claim = {
  ownerChatId?: number;
  updateId: number;
};

class ControlledRepository implements TelegramRepository {
  readonly claims: Claim[] = [];
  readonly completions: Array<{
    result: TelegramProcessingResult;
    updateId: number;
  }> = [];
  readonly updateIds = new Set<number>();
  activeCommitments = false;
  activeReads = 0;

  async claimUpdate(updateId: number, ownerChatId?: number): Promise<boolean> {
    this.claims.push({ ownerChatId, updateId });
    if (this.updateIds.has(updateId)) {
      return false;
    }
    this.updateIds.add(updateId);
    return true;
  }

  async completeUpdate(
    updateId: number,
    result: TelegramProcessingResult,
  ): Promise<void> {
    this.completions.push({ result, updateId });
  }

  async hasActiveCommitments(): Promise<boolean> {
    this.activeReads += 1;
    return this.activeCommitments;
  }
}

class ControlledClient implements TelegramClient {
  readonly sends: Array<{ chatId: number; text: string }> = [];

  async sendText(chatId: number, text: string): Promise<void> {
    this.sends.push({ chatId, text });
  }
}

class ControlledConversation {
  readonly turns: Array<{ ownerText: string; updateId: number }> = [];
  response = "Bounded conversation response.";

  async handle(updateId: number, ownerText: string): Promise<string> {
    this.turns.push({ ownerText, updateId });
    return this.response;
  }
}

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function appWith(
  handler: TelegramUpdateHandler,
  logger: AppOptions["logger"] = false,
) {
  const app = await buildApp({
    config,
    dashboardRepository: {
      readSummary: vi.fn().mockResolvedValue({
        commitments: [],
        counts: { active: 0, dueToday: 0, overdue: 0 },
        events: [],
        sessionHistory: [],
        terminalCommitments: [],
        updatedAt: "2026-07-24T12:00:00.000Z",
      }),
    },
    logger,
    serveStatic: false,
    telegramService: handler,
  });
  openApps.push(app);
  return app;
}

function serviceWith() {
  const repository = new ControlledRepository();
  const client = new ControlledClient();
  const conversation = new ControlledConversation();
  return {
    client,
    conversation,
    repository,
    service: new TelegramService({
      client,
      conversationService: conversation,
      ownerUserId,
      repository,
    }),
  };
}

function textUpdate(options: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  text: string;
  updateId: number;
}) {
  return {
    message: {
      chat: {
        id: options.chatId ?? ownerUserId,
        type: options.chatType ?? "private",
      },
      from: { id: options.fromId ?? ownerUserId },
      text: options.text,
    },
    update_id: options.updateId,
  };
}

const validHeaders = {
  "content-type": "application/json",
  "x-telegram-bot-api-secret-token": webhookSecret,
};

describe("POST /api/telegram/webhook", () => {
  it("rejects a missing or invalid secret before JSON parsing or processing", async () => {
    const handler: TelegramUpdateHandler = {
      handle: vi.fn().mockResolvedValue(undefined),
    };
    const app = await appWith(handler);

    const missing = await app.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: '{"message":"not valid JSON"',
      url: "/api/telegram/webhook",
    });
    const invalid = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret",
      },
      method: "POST",
      payload: '{"message":"not valid JSON"',
      url: "/api/telegram/webhook",
    });

    for (const response of [missing, invalid]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false });
    }
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a different private user",
      update: textUpdate({
        fromId: ownerUserId + 1,
        text: "/status",
        updateId: 2001,
      }),
    },
    {
      label: "the owner in a group",
      update: textUpdate({
        chatId: -987654321,
        chatType: "group",
        text: "/status",
        updateId: 2002,
      }),
    },
  ])("returns a generic refusal for $label", async ({ update }) => {
    const controlled = serviceWith();
    const app = await appWith(controlled.service);

    const response = await app.inject({
      headers: validHeaders,
      method: "POST",
      payload: update,
      url: "/api/telegram/webhook",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(controlled.client.sends).toEqual([
      {
        chatId: update.message.chat.id,
        text: "I can’t help in this chat.",
      },
    ]);
    expect(controlled.repository.claims).toEqual([
      { ownerChatId: undefined, updateId: update.update_id },
    ]);
    expect(controlled.repository.completions).toEqual([
      { result: "refused", updateId: update.update_id },
    ]);
    expect(controlled.repository.activeReads).toBe(0);
    expect(controlled.conversation.turns).toHaveLength(0);
  });

  it("routes the owner /status text through the unified conversation", async () => {
    const controlled = serviceWith();
    controlled.conversation.response = "No active promises.";
    const app = await appWith(controlled.service);

    const response = await app.inject({
      headers: validHeaders,
      method: "POST",
      payload: textUpdate({
        text: "/status",
        updateId: 3001,
      }),
      url: "/api/telegram/webhook",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(controlled.repository.claims).toEqual([
      { ownerChatId: ownerUserId, updateId: 3001 },
    ]);
    expect(controlled.repository.activeReads).toBe(0);
    expect(controlled.client.sends).toEqual([
      { chatId: ownerUserId, text: "No active promises." },
    ]);
    expect(controlled.repository.completions).toEqual([]);
    expect(controlled.conversation.turns).toEqual([
      { ownerText: "/status", updateId: 3001 },
    ]);
  });

  it("routes authorized owner text through the atomic conversation boundary", async () => {
    const controlled = serviceWith();
    const app = await appWith(controlled.service);
    const response = await app.inject({
      headers: validHeaders,
      method: "POST",
      payload: textUpdate({
        text: "private material that must not be persisted",
        updateId: 4001,
      }),
      url: "/api/telegram/webhook",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(controlled.client.sends).toEqual([
      {
        chatId: ownerUserId,
        text: "Bounded conversation response.",
      },
    ]);
    expect(controlled.conversation.turns).toEqual([
      {
        ownerText: "private material that must not be persisted",
        updateId: 4001,
      },
    ]);
    expect(controlled.repository.claims).toEqual([
      { ownerChatId: ownerUserId, updateId: 4001 },
    ]);
    expect(controlled.repository.completions).toEqual([]);
  });

  it("stops replay before the conversation engine and sends only once", async () => {
    const controlled = serviceWith();
    const app = await appWith(controlled.service);
    const request = {
      headers: validHeaders,
      method: "POST" as const,
      payload: textUpdate({ text: "Create a promise", updateId: 5001 }),
      url: "/api/telegram/webhook",
    };

    const responses = await Promise.all([
      app.inject(request),
      app.inject(request),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.map((response) => response.json())).toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(controlled.client.sends).toHaveLength(1);
    expect(controlled.conversation.turns).toEqual([
      { ownerText: "Create a promise", updateId: 5001 },
    ]);
    expect(controlled.repository.completions).toHaveLength(0);
  });

  it("finalizes one targeted decision failure and suppresses its replay", async () => {
    const fields: DecisionContextFields = {
      definitionOfDone: "Create a video for Telegram setup",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: false,
      targetAt: null,
      targetTimeZone: null,
      timingConstraints: [],
    };
    const commands: ConversationCommand[] = [];
    const conversationRepository: ConversationRepository = {
      applyTurn: vi.fn(
        async (
          command: ConversationCommand,
        ): Promise<ConversationApplyResult> => {
          commands.push(command);
          return {
            completed: true,
            draftCreated: false,
            status: "applied",
          };
        },
      ),
      readTurn: vi.fn(async () => ({
        expiresAt: "2026-07-30T02:02:00.000Z",
        fields,
        id: "11111111-1111-4111-8111-111111111111",
        kind: "draft" as const,
        phase: "awaiting_target" as const,
        version: 10,
      })),
    };
    const decisionEngine: DecisionEngine = {
      decide: vi.fn(async () => ({
        attemptCount: 2,
        failure: "semantic" as const,
        ok: false as const,
        reason: "target_not_future" as const,
        stage: "semantic" as const,
      })),
    };
    const conversation = new ConversationService({
      decisionEngine,
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository: conversationRepository,
    });
    const repository = new ControlledRepository();
    const client = new ControlledClient();
    const service = new TelegramService({
      client,
      conversationService: conversation,
      ownerUserId,
      repository,
    });
    const app = await appWith(service);
    const request = {
      headers: validHeaders,
      method: "POST" as const,
      payload: textUpdate({ text: "Tomorrow 9am", updateId: 5002 }),
      url: "/api/telegram/webhook",
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect([first.statusCode, replay.statusCode]).toEqual([200, 200]);
    expect(client.sends).toEqual([
      {
        chatId: ownerUserId,
        text: conversationCopy.targetFailureWithDraft,
      },
    ]);
    expect(decisionEngine.decide).toHaveBeenCalledOnce();
    expect(conversationRepository.readTurn).toHaveBeenCalledOnce();
    expect(conversationRepository.applyTurn).toHaveBeenCalledOnce();
    expect(commands).toEqual([
      {
        action: "preserve",
        expected: {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "draft",
          version: 10,
        },
        processingResult: "conversation_failed",
        updateId: 5002,
      },
    ]);
    expect(commands[0]).not.toHaveProperty("audit");
    expect(commands[0]).not.toHaveProperty("fields");
    expect(repository.claims).toEqual([
      { ownerChatId: ownerUserId, updateId: 5002 },
      { ownerChatId: ownerUserId, updateId: 5002 },
    ]);
    expect(repository.completions).toHaveLength(0);
  });

  it("redacts failures from HTTP state and service errors", async () => {
    const sensitiveText = "private-owner-text-should-never-leak";
    let logs = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    });
    const repository = new ControlledRepository();
    const service = new TelegramService({
      client: {
        sendText: vi
          .fn()
          .mockRejectedValue(
            new Error(
              `${sensitiveText}:${ownerUserId}:${webhookSecret}:unit-test-bot-token`,
            ),
          ),
      },
      conversationService: {
        handle: vi.fn().mockResolvedValue("Bounded safe response."),
      },
      ownerUserId,
      repository,
    });
    const app = await appWith(service, {
      level: "info",
      stream: logStream,
    });
    const response = await app.inject({
      headers: validHeaders,
      method: "POST",
      payload: textUpdate({
        text: sensitiveText,
        updateId: 6001,
      }),
      url: "/api/telegram/webhook",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
    for (const sensitiveValue of [
      sensitiveText,
      String(ownerUserId),
      "6001",
      webhookSecret,
      "unit-test-bot-token",
    ]) {
      expect(response.payload).not.toContain(sensitiveValue);
      expect(logs).not.toContain(sensitiveValue);
    }
    expect(repository.completions).toEqual([
      { result: "failed", updateId: 6001 },
    ]);
  });
});
