import type { TelegramInlineAction } from "../confirmation.js";

export interface TelegramClient {
  answerCallbackQuery?(callbackQueryId: string): Promise<void>;
  sendText(
    chatId: number,
    text: string,
    actions?: readonly TelegramInlineAction[],
  ): Promise<TelegramSendReceipt | void>;
}

export type TelegramDeliveryFailure =
  | "delivery_unknown"
  | "permanent_failure"
  | "rate_limited";

export type TelegramSendReceipt = {
  messageId?: number;
};

export class TelegramSendError extends Error {
  readonly failure: TelegramDeliveryFailure;
  readonly retryAfterSeconds?: number;

  constructor(
    failure: TelegramDeliveryFailure,
    retryAfterSeconds?: number,
  ) {
    super("Telegram delivery failed");
    this.name = "TelegramSendError";
    this.failure = failure;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type TelegramBotClientOptions = {
  botToken: string;
  fetch?: typeof fetch;
};

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

export class TelegramBotClient implements TelegramClient {
  readonly #botToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: TelegramBotClientOptions) {
    this.#botToken = options.botToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.#request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
    });
  }

  async sendText(
    chatId: number,
    text: string,
    actions?: readonly TelegramInlineAction[],
  ): Promise<TelegramSendReceipt> {
    const result = await this.#request("sendMessage", {
      chat_id: chatId,
      ...(actions && actions.length > 0
        ? {
            reply_markup: {
              inline_keyboard: [
                actions.map((action) => ({
                  callback_data: action.callbackData,
                  text: action.text,
                })),
              ],
            },
          }
        : {}),
      text,
    });
    return isRecord(result) && positiveSafeInteger(result.message_id)
      ? { messageId: result.message_id }
      : {};
  }

  async #request(
    method: "answerCallbackQuery" | "sendMessage",
    body: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;

    try {
      response = await this.#fetch(
        `https://api.telegram.org/bot${this.#botToken}/${method}`,
        {
          body: JSON.stringify(body),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      throw new TelegramSendError("delivery_unknown");
    }

    if (!response.ok) {
      if (response.status === 429) {
        const responseBody: unknown = await response.json().catch(() => null);
        const parameters =
          isRecord(responseBody) && isRecord(responseBody.parameters)
            ? responseBody.parameters
            : null;
        if (
          isRecord(responseBody) &&
          responseBody.ok === false &&
          responseBody.error_code === 429 &&
          parameters &&
          positiveSafeInteger(parameters.retry_after)
        ) {
          throw new TelegramSendError(
            "rate_limited",
            parameters.retry_after,
          );
        }
        throw new TelegramSendError("delivery_unknown");
      }
      throw new TelegramSendError(
        response.status >= 400 && response.status < 500
          ? "permanent_failure"
          : "delivery_unknown",
      );
    }

    if (method === "answerCallbackQuery") {
      return undefined;
    }

    const responseBody: unknown = await response.json().catch(() => null);
    if (
      !isRecord(responseBody) ||
      responseBody.ok !== true ||
      !("result" in responseBody)
    ) {
      return undefined;
    }
    return responseBody.result;
  }
}
