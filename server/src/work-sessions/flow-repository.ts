import { supabaseHeaders } from "../supabase.js";
import type { DraftReference } from "../confirmation.js";
import type { WorkWindow } from "../scheduling/availability.js";
import type {
  WorkSessionDraftSnapshot,
  WorkSessionFlowRepository,
  WorkSessionFlowStage,
  WorkSessionFlowTransition,
  WorkSessionFlowTransitionResult,
  PreparationDeclineResult,
} from "./flow.js";
import { isWorkSessionDuration } from "./duration.js";

const stages = new Set<WorkSessionFlowStage>([
  "availability_unavailable",
  "awaiting_constraints",
  "awaiting_duration_help",
  "awaiting_duration_owner",
  "awaiting_owner_time",
  "choosing",
  "commit_pending",
  "confirming",
  "conflict_choice",
  "conflict_confirming",
  "offer_help",
  "unverified_confirming",
]);

type SupabaseWorkSessionFlowRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function instant(value: unknown, nullable = false): value is string | null {
  return (
    (nullable && value === null) ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function window(value: unknown): WorkWindow | undefined {
  const item = record(value);
  return item &&
      typeof item.startAt === "string" &&
      typeof item.endAt === "string" &&
      Number.isFinite(Date.parse(item.startAt)) &&
      Number.isFinite(Date.parse(item.endAt)) &&
      Date.parse(item.endAt) > Date.parse(item.startAt)
    ? { endAt: item.endAt, startAt: item.startAt }
    : undefined;
}

function snapshot(value: unknown): WorkSessionDraftSnapshot {
  const item = record(value);
  if (!item) {
    throw new Error("Work-session draft repository returned invalid data");
  }
  const options = Array.isArray(item.options)
    ? item.options.map(window)
    : undefined;
  const selectedWindow =
    item.selectedWindow === null ? null : window(item.selectedWindow);
  if (
    typeof item.id !== "string" ||
    typeof item.version !== "number" ||
    !Number.isSafeInteger(item.version) ||
    item.version < 1 ||
    !stages.has(item.stage as WorkSessionFlowStage) ||
    typeof item.definitionOfDone !== "string" ||
    item.definitionOfDone.trim().length === 0 ||
    typeof item.targetAt !== "string" ||
    !Number.isFinite(Date.parse(item.targetAt)) ||
    (
      item.durationMinutes !== null &&
      !isWorkSessionDuration(item.durationMinutes)
    ) ||
    (
      item.timingConstraints !== null &&
      typeof item.timingConstraints !== "string"
    ) ||
    !Array.isArray(options) ||
    options.length > 2 ||
    options.some((option) => option === undefined) ||
    (item.selectedWindow !== null && selectedWindow === undefined) ||
    !instant(item.calendarAttemptedAt, true) ||
    !instant(item.calendarCheckedAt, true) ||
    typeof item.conflictConsent !== "boolean" ||
    ![null, "conflict", "free", "unavailable"].includes(
      item.finalObservation as null | string,
    )
  ) {
    throw new Error("Work-session draft repository returned invalid data");
  }
  return {
    calendarAttemptedAt: item.calendarAttemptedAt,
    calendarCheckedAt: item.calendarCheckedAt,
    conflictConsent: item.conflictConsent,
    definitionOfDone: item.definitionOfDone,
    durationMinutes: item.durationMinutes as number | null,
    finalObservation: item.finalObservation as
      | "conflict"
      | "free"
      | "unavailable"
      | null,
    id: item.id,
    options: options as WorkWindow[],
    selectedWindow: selectedWindow ?? null,
    stage: item.stage as WorkSessionFlowStage,
    targetAt: item.targetAt,
    timingConstraints: item.timingConstraints as string | null,
    version: item.version,
  };
}

function readResult(value: unknown):
  | Readonly<{ kind: "expired" | "missing" | "stale" }>
  | Readonly<{ kind: "current"; snapshot: WorkSessionDraftSnapshot }> {
  const item = record(value);
  if (
    !item ||
    !["current", "expired", "missing", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Work-session draft read returned invalid data");
  }
  return item.kind === "current"
    ? { kind: "current", snapshot: snapshot(item.snapshot) }
    : { kind: item.kind as "expired" | "missing" | "stale" };
}

function transitionResult(value: unknown): WorkSessionFlowTransitionResult {
  const item = record(value);
  if (
    !item ||
    !["applied", "expired", "replay", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Work-session draft transition returned invalid data");
  }
  return item.kind === "applied"
    ? { kind: "applied", snapshot: snapshot(item.snapshot) }
    : { kind: item.kind as "expired" | "replay" | "stale" };
}

function finalizationResult(
  value: unknown,
): Readonly<{ kind: "applied" | "replay" }> {
  const item = record(value);
  if (
    !item ||
    !["applied", "replay"].includes(String(item.kind))
  ) {
    throw new Error("Work-session conversation finalization failed");
  }
  return { kind: item.kind as "applied" | "replay" };
}

function preparationDeclineResult(
  value: unknown,
): PreparationDeclineResult {
  const item = record(value);
  if (
    !item ||
    !["applied", "expired", "replay", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Preparation decline returned invalid data");
  }
  if (item.kind !== "applied") {
    return { kind: item.kind as "expired" | "replay" | "stale" };
  }
  const draft = record(item.draft);
  if (
    !draft ||
    typeof draft.id !== "string" ||
    typeof draft.version !== "number" ||
    !Number.isSafeInteger(draft.version) ||
    draft.version < 1 ||
    typeof draft.definitionOfDone !== "string" ||
    draft.definitionOfDone.trim().length === 0 ||
    typeof draft.targetAt !== "string" ||
    !Number.isFinite(Date.parse(draft.targetAt))
  ) {
    throw new Error("Preparation decline returned invalid data");
  }
  return {
    draft: {
      definitionOfDone: draft.definitionOfDone,
      id: draft.id,
      targetAt: draft.targetAt,
      version: draft.version,
    },
    kind: "applied",
  };
}

export class SupabaseWorkSessionFlowRepository
  implements WorkSessionFlowRepository
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseWorkSessionFlowRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async declinePreparation(
    updateId: number,
    chatId: number,
    reference: DraftReference,
  ): Promise<PreparationDeclineResult> {
    return preparationDeclineResult(
      await this.#rpc("decline_work_session_preparation", {
        p_draft_id: reference.id,
        p_owner_chat_id: chatId,
        p_owner_id: this.#ownerId,
        p_update_id: updateId,
        p_version: reference.version,
      }),
    );
  }

  async declinePreparationFromConversation(
    updateId: number,
    chatId: number,
    reference: DraftReference,
  ): Promise<PreparationDeclineResult> {
    return preparationDeclineResult(
      await this.#rpc(
        "decline_work_session_preparation_from_conversation",
        {
          p_draft_id: reference.id,
          p_owner_chat_id: chatId,
          p_owner_id: this.#ownerId,
          p_update_id: updateId,
          p_version: reference.version,
        },
      ),
    );
  }

  async finalizeConversation(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    result: "domain_error" | "expired" | "invalid" | "stale",
  ) {
    return finalizationResult(
      await this.#rpc("finalize_work_session_conversation_turn", {
        p_draft_id: reference.id,
        p_owner_chat_id: chatId,
        p_owner_id: this.#ownerId,
        p_result: result,
        p_update_id: updateId,
        p_version: reference.version,
      }),
    );
  }

  async #rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/${name}`,
      {
        body: JSON.stringify(body),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Work-session draft persistence failed");
    }
    return response.json();
  }

  async read(reference: DraftReference) {
    return readResult(
      await this.#rpc("read_work_session_draft", {
        p_draft_id: reference.id,
        p_version: reference.version,
      }),
    );
  }

  async transition(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult> {
    return this.#transitionRpc(
      "transition_work_session_draft",
      command,
    );
  }

  async transitionFromConversation(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult> {
    return this.#transitionRpc(
      "transition_work_session_draft_from_conversation",
      command,
    );
  }

  async #transitionRpc(
    name: string,
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult> {
    return transitionResult(
      await this.#rpc(name, {
        p_calendar_attempted_at:
          command.calendarAttemptedAt ?? null,
        p_calendar_checked_at:
          command.calendarCheckedAt ?? null,
        p_conflict_consent: command.conflictConsent ?? null,
        p_duration_minutes: command.durationMinutes ?? null,
        p_expected_stage: command.expectedStage,
        p_final_observation:
          command.finalObservation ?? null,
        p_is_cancel: false,
        p_next_stage: command.nextStage,
        p_options: command.options ?? null,
        p_owner_chat_id: command.chatId,
        p_owner_id: this.#ownerId,
        p_selected_window:
          command.selectedWindow === undefined
            ? null
            : command.selectedWindow,
        p_timing_constraints:
          command.timingConstraints ?? null,
        p_update_id: command.updateId,
        p_version: command.reference.version,
        p_draft_id: command.reference.id,
      }),
    );
  }

  async cancel(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    expectedStage: WorkSessionFlowStage,
  ): Promise<WorkSessionFlowTransitionResult> {
    return transitionResult(
      await this.#rpc("transition_work_session_draft", {
        p_calendar_attempted_at: null,
        p_calendar_checked_at: null,
        p_conflict_consent: null,
        p_duration_minutes: null,
        p_expected_stage: expectedStage,
        p_final_observation: null,
        p_is_cancel: true,
        p_next_stage: expectedStage,
        p_options: null,
        p_owner_chat_id: chatId,
        p_owner_id: this.#ownerId,
        p_selected_window: null,
        p_timing_constraints: null,
        p_update_id: updateId,
        p_version: reference.version,
        p_draft_id: reference.id,
      }),
    );
  }
}
