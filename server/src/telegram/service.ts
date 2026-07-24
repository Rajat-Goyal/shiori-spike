import type { TelegramClient } from "./client.js";
import {
  type TelegramProcessingResult,
  type TelegramRepository,
} from "./repository.js";

type TelegramServiceOptions = {
  client: TelegramClient;
  ownerUserId: number;
  repository: TelegramRepository;
};

type ParsedUpdate =
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
  readonly #ownerUserId: number;
  readonly #repository: TelegramRepository;

  constructor(options: TelegramServiceOptions) {
    this.#client = options.client;
    this.#ownerUserId = options.ownerUserId;
    this.#repository = options.repository;
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
      update.kind === "text" &&
      update.fromId === this.#ownerUserId &&
      update.chatType === "private" &&
      update.chatId === this.#ownerUserId;
    const ownerChatId = isOwnerPrivate ? update.chatId : undefined;
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
      } else if (update.text.trim() === "/status") {
        if (await this.#repository.hasActiveCommitments()) {
          throw new Error("Populated Telegram status is outside S01-02");
        }
        await this.#client.sendText(update.chatId, "No active promises.");
        result = "status_empty";
      } else {
        await this.#client.sendText(
          update.chatId,
          "Send /status to view active promises.",
        );
        result = "unsupported";
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
