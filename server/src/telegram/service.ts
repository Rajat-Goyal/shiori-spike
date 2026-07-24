import type { TelegramClient } from "./client.js";
import type { TelegramReply } from "../confirmation.js";
import {
  type TelegramProcessingResult,
  type TelegramRepository,
} from "./repository.js";

type TelegramServiceOptions = {
  client: TelegramClient;
  confirmationService?: {
    handle(
      updateId: number,
      chatId: number,
      callbackData: unknown,
    ): Promise<TelegramReply | null>;
  };
  conversationService: {
    handle(
      updateId: number,
      ownerText: string,
    ): Promise<string | TelegramReply>;
  };
  ownerUserId: number;
  repository: TelegramRepository;
  simpleCommitmentActionService?: {
    handle(
      updateId: number,
      chatId: number,
      callbackData: unknown,
    ): Promise<TelegramReply | null>;
  };
  statusService?: {
    read(): Promise<readonly TelegramReply[]>;
  };
  workSessionActionService?: {
    handle(
      updateId: number,
      chatId: number,
      callbackData: unknown,
    ): Promise<TelegramReply | null>;
  };
};

type ParsedUpdate =
  | {
      callbackData: unknown;
      callbackId: string;
      chatId: number;
      chatType: string;
      fromId?: number;
      kind: "callback";
      updateId: number;
    }
  | {
      chatId: number;
      chatType: string;
      fromId?: number;
      kind: "text";
      text: string;
      updateId: number;
    }
  | {
      kind: "ignored";
      updateId: number;
    };

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseUpdate(value: unknown): ParsedUpdate | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const update = value as Record<string, unknown>;
  if (!safeInteger(update.update_id) || update.update_id < 0) {
    return undefined;
  }
  if (
    update.callback_query &&
    typeof update.callback_query === "object"
  ) {
    const callback = update.callback_query as Record<string, unknown>;
    const message =
      callback.message && typeof callback.message === "object"
        ? (callback.message as Record<string, unknown>)
        : undefined;
    const chat =
      message?.chat && typeof message.chat === "object"
        ? (message.chat as Record<string, unknown>)
        : undefined;
    const from =
      callback.from && typeof callback.from === "object"
        ? (callback.from as Record<string, unknown>)
        : undefined;
    if (
      typeof callback.id !== "string" ||
      !chat ||
      !safeInteger(chat.id) ||
      typeof chat.type !== "string"
    ) {
      return { kind: "ignored", updateId: update.update_id };
    }
    return {
      callbackData: callback.data,
      callbackId: callback.id,
      chatId: chat.id,
      chatType: chat.type,
      fromId: safeInteger(from?.id) ? from.id : undefined,
      kind: "callback",
      updateId: update.update_id,
    };
  }
  if (!update.message || typeof update.message !== "object") {
    return { kind: "ignored", updateId: update.update_id };
  }

  const message = update.message as Record<string, unknown>;
  if (!message.chat || typeof message.chat !== "object") {
    return { kind: "ignored", updateId: update.update_id };
  }

  const chat = message.chat as Record<string, unknown>;
  if (
    !safeInteger(chat.id) ||
    typeof chat.type !== "string" ||
    typeof message.text !== "string"
  ) {
    return { kind: "ignored", updateId: update.update_id };
  }

  const from =
    message.from && typeof message.from === "object"
      ? (message.from as Record<string, unknown>)
      : undefined;

  return {
    chatId: chat.id,
    chatType: chat.type,
    fromId: safeInteger(from?.id) ? from.id : undefined,
    kind: "text",
    text: message.text,
    updateId: update.update_id,
  };
}

export class TelegramService {
  readonly #client: TelegramClient;
  readonly #confirmationService:
    | TelegramServiceOptions["confirmationService"]
    | undefined;
  readonly #conversationService: TelegramServiceOptions["conversationService"];
  readonly #ownerUserId: number;
  readonly #repository: TelegramRepository;
  readonly #simpleCommitmentActionService:
    | TelegramServiceOptions["simpleCommitmentActionService"]
    | undefined;
  readonly #statusService:
    | TelegramServiceOptions["statusService"]
    | undefined;
  readonly #workSessionActionService:
    | TelegramServiceOptions["workSessionActionService"]
    | undefined;

  constructor(options: TelegramServiceOptions) {
    this.#client = options.client;
    this.#confirmationService = options.confirmationService;
    this.#conversationService = options.conversationService;
    this.#ownerUserId = options.ownerUserId;
    this.#repository = options.repository;
    this.#simpleCommitmentActionService =
      options.simpleCommitmentActionService;
    this.#statusService = options.statusService;
    this.#workSessionActionService = options.workSessionActionService;
  }

  async handle(value: unknown): Promise<void> {
    try {
      await this.#process(value);
    } catch {
      throw new Error("Telegram processing failed");
    }
  }

  async #process(value: unknown): Promise<void> {
    const update = parseUpdate(value);
    if (!update) {
      return;
    }

    const isOwnerPrivate =
      update.kind !== "ignored" &&
      update.fromId === this.#ownerUserId &&
      update.chatType === "private" &&
      update.chatId === this.#ownerUserId;
    const ownerChatId = isOwnerPrivate ? update.chatId : undefined;

    if (
      update.kind === "callback" &&
      isOwnerPrivate &&
      (
        this.#confirmationService ||
        this.#simpleCommitmentActionService ||
        this.#workSessionActionService
      )
    ) {
      const useSimpleCommitmentAction =
        typeof update.callbackData === "string" &&
        (
          update.callbackData.startsWith("p:") ||
          update.callbackData.startsWith("x:")
        );
      const useWorkSessionAction =
        typeof update.callbackData === "string" &&
        (
          update.callbackData.startsWith("s:") ||
          update.callbackData.startsWith("c:") ||
          update.callbackData.startsWith("w:")
        );
      const callbackService = useSimpleCommitmentAction
        ? this.#simpleCommitmentActionService
        : useWorkSessionAction
          ? this.#workSessionActionService
          : this.#confirmationService;
      if (!callbackService) {
        throw new Error("Callback service is unavailable");
      }
      const reply = await callbackService.handle(
        update.updateId,
        update.chatId,
        update.callbackData,
      );
      if (!reply) {
        return;
      }
      await this.#client
        .answerCallbackQuery?.(update.callbackId)
        .catch(() => undefined);
      await this.#client.sendText(
        update.chatId,
        reply.text,
        reply.actions,
      );
      return;
    }

    const claimed = await this.#repository.claimUpdate(
      update.updateId,
      ownerChatId,
    );

    if (!claimed) {
      return;
    }

    let result: TelegramProcessingResult = "ignored";
    try {
      if (update.kind === "ignored") {
        result = "ignored";
      } else if (!isOwnerPrivate) {
        await this.#client.sendText(update.chatId, "I can’t help in this chat.");
        result = "refused";
      } else if (update.kind === "callback") {
        throw new Error("Confirmation service is unavailable");
      } else if (update.text.trim() === "/status") {
        let replies: readonly TelegramReply[];
        if (this.#statusService) {
          replies = await this.#statusService.read();
        } else {
          if (await this.#repository.hasActiveCommitments()) {
            throw new Error("Status service is unavailable");
          }
          replies = [];
        }
        if (replies.length === 0) {
          await this.#client.sendText(update.chatId, "No active promises.");
          result = "status_empty";
        } else {
          for (const reply of replies) {
            await this.#client.sendText(
              update.chatId,
              reply.text,
              reply.actions,
            );
          }
          result = "status_listed";
        }
      } else {
        const response = await this.#conversationService.handle(
          update.updateId,
          update.text,
        );
        const reply =
          typeof response === "string" ? { text: response } : response;
        await this.#client.sendText(
          update.chatId,
          reply.text,
          reply.actions,
        );
        return;
      }

      await this.#repository.completeUpdate(update.updateId, result);
    } catch {
      await this.#repository
        .completeUpdate(update.updateId, "failed")
        .catch(() => undefined);
      throw new Error("Telegram processing failed");
    }
  }
}
