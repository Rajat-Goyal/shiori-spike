export interface TelegramClient {
  sendText(chatId: number, text: string): Promise<void>;
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

  async sendText(chatId: number, text: string): Promise<void> {
    let response: Response;

    try {
      response = await this.#fetch(
        `https://api.telegram.org/bot${this.#botToken}/sendMessage`,
        {
          body: JSON.stringify({
            chat_id: chatId,
            text,
          }),
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
