import type { TelegramInlineAction } from "../confirmation.js";

export interface TelegramClient {
  answerCallbackQuery?(callbackQueryId: string): Promise<void>;
  sendText(
    chatId: number,
    text: string,
    actions?: readonly TelegramInlineAction[],
  ): Promise<void>;
}

type TelegramBotClientOptions = {
  botToken: string;
  fetch?: typeof fetch;
};

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
  ): Promise<void> {
    await this.#request("sendMessage", {
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
  }

  async #request(
    method: "answerCallbackQuery" | "sendMessage",
    body: Record<string, unknown>,
  ): Promise<void> {
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
      throw new Error("Telegram delivery failed");
    }

    if (!response.ok) {
      throw new Error("Telegram delivery failed");
    }
  }
}
