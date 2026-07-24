import { supabaseHeaders } from "../supabase.js";

export type TelegramProcessingResult =
  | "failed"
  | "ignored"
  | "refused"
  | "status_empty"
  | "status_listed"
  | "unsupported";

export interface TelegramRepository {
  claimUpdate(updateId: number, ownerChatId?: number): Promise<boolean>;
  completeUpdate(
    updateId: number,
    result: TelegramProcessingResult,
  ): Promise<void>;
  hasActiveCommitments(): Promise<boolean>;
}

type SupabaseTelegramRepositoryOptions = {
  fetch?: typeof fetch;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

export class SupabaseTelegramRepository implements TelegramRepository {
  readonly #fetch: typeof fetch;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseTelegramRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async claimUpdate(updateId: number, ownerChatId?: number): Promise<boolean> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/claim_telegram_update`,
      {
        body: JSON.stringify({
          p_owner_chat_id: ownerChatId ?? null,
          p_update_id: updateId,
        }),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      throw new Error("Telegram update claim failed");
    }

    const body: unknown = await response.json();
    if (typeof body !== "boolean") {
      throw new Error("Telegram update claim returned an invalid response");
    }

    return body;
  }

  async completeUpdate(
    updateId: number,
    result: TelegramProcessingResult,
  ): Promise<void> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/complete_telegram_update`,
      {
        body: JSON.stringify({
          p_processing_result: result,
          p_update_id: updateId,
        }),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok || (await response.json()) !== true) {
      throw new Error("Telegram update completion failed");
    }
  }

  async hasActiveCommitments(): Promise<boolean> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/commitments?select=id&status=eq.active&limit=1`,
      {
        headers: supabaseHeaders(this.#supabaseSecretKey),
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      throw new Error("Telegram status read failed");
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error("Telegram status read returned an invalid response");
    }

    return body.length > 0;
  }
}
