import { supabaseHeaders } from "../supabase.js";
import type {
  WorkSessionCommitRequest,
  WorkSessionCommitResult,
  WorkSessionCommitter,
} from "./flow.js";

type SupabaseWorkSessionCommitterOptions = Readonly<{
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

function parseResult(value: unknown): WorkSessionCommitResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["applied", "replay", "resolved", "stale"].includes(
      String((value as Record<string, unknown>).kind),
    )
  ) {
    throw new Error("Work-session confirmation returned invalid data");
  }
  return {
    kind: (value as Record<string, unknown>)
      .kind as WorkSessionCommitResult["kind"],
  };
}

export class SupabaseWorkSessionCommitter
  implements WorkSessionCommitter
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseWorkSessionCommitterOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async commit(
    request: WorkSessionCommitRequest,
  ): Promise<WorkSessionCommitResult> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/confirm_work_session`,
      {
        body: JSON.stringify({
          p_action: request.action,
          p_calendar_attempted_at: request.calendar.attemptedAt,
          p_calendar_checked_at: request.calendar.checkedAt,
          p_calendar_status: request.calendar.status,
          p_conflict_consent: request.calendar.conflictConsent,
          p_draft_id: request.draft.id,
          p_expected_stage: request.expectedStage,
          p_final_observation: request.calendar.finalObservation,
          p_owner_chat_id: request.chatId,
          p_owner_id: this.#ownerId,
          p_update_id: request.updateId,
          p_version: request.draft.version,
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
      throw new Error("Work-session confirmation failed");
    }
    return parseResult(await response.json());
  }
}
