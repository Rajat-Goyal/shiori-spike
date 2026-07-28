import type {
  DecisionContextFields,
  DecisionInput,
  DecisionResult,
} from "../decision/schema.js";
import { supabaseHeaders } from "../supabase.js";

export type ConversationPhase = Exclude<
  DecisionInput["context"]["phase"],
  "none" | "awaiting_permission"
>;

type StoredCandidate = {
  expiresAt: string;
  fields: DecisionContextFields;
  id: string;
};

export type ActiveDraft = StoredCandidate & {
  kind: "draft";
  phase: ConversationPhase;
  version: number;
};

export type PermissionCandidate = StoredCandidate & {
  correlatedUpdateId: number;
  kind: "permission";
  sourceUpdateId: number;
};

export type ConversationSnapshot =
  | { kind: "none" }
  | ActiveDraft
  | PermissionCandidate;

export type ConversationReadResult =
  | ConversationSnapshot
  | { completed: true; kind: "busy" }
  | { completed: true; kind: "expired" }
  | { completed: true; kind: "interrupted" };

type ExpectedSnapshot =
  | { kind: "none" }
  | Pick<ActiveDraft, "id" | "kind" | "version">
  | Pick<
      PermissionCandidate,
      "correlatedUpdateId" | "id" | "kind" | "sourceUpdateId"
    >;

type CandidateAction = {
  fields: DecisionContextFields;
  phase: ConversationPhase;
};

export type DecisionAudit = {
  inputClass: DecisionResult["inputClass"];
  modelId: string;
  payload: Omit<
    DecisionResult,
    "commitmentMode" | "inputClass" | "response"
  > & {
    possibleWorkSession: boolean;
    simpleAction: boolean;
  };
  promptVersion: string;
};

type ConversationAction =
  | (CandidateAction & {
      action:
        | "accept_work_permission"
        | "create_draft"
        | "update_draft";
      expected: ExpectedSnapshot;
      updateId: number;
    })
  | {
      action: "create_permission";
      expected: ExpectedSnapshot;
      fields: DecisionContextFields;
      updateId: number;
    }
  | {
      action:
        | "accept_permission"
        | "preserve"
        | "rearm_permission"
        | "terminate_permission";
      expected: ExpectedSnapshot;
      updateId: number;
    };

type ConversationCompletion =
  | {
      audit: DecisionAudit;
      processingResult: "conversation";
    }
  | {
      audit?: never;
      processingResult: "conversation_failed";
    };

export type ConversationCommand = ConversationAction &
  ConversationCompletion;

export type ConversationApplyResult = {
  completed: boolean;
  draftReference?: {
    id: string;
    version: number;
  };
  draftCreated: boolean;
  status: "applied" | "expired" | "interrupted" | "stale";
};

export interface ConversationRepository {
  applyTurn(
    command: ConversationCommand,
  ): Promise<ConversationApplyResult>;
  readTurn(updateId: number): Promise<ConversationReadResult>;
}

type SupabaseConversationRepositoryOptions = {
  fetch?: typeof fetch;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function fieldsFrom(record: Record<string, unknown>): DecisionContextFields {
  const fields = {
    definitionOfDone: record.definitionOfDone,
    durationMinutes: record.durationMinutes,
    offerWorkWindowHelp: record.offerWorkWindowHelp,
    possibleWorkSession: record.possibleWorkSession,
    simpleAction: record.simpleAction,
    targetAt: record.targetAt,
    targetTimeZone: record.targetTimeZone,
    timingConstraints: record.timingConstraints,
  };

  if (
    !(
      (fields.definitionOfDone === null ||
        typeof fields.definitionOfDone === "string") &&
      (fields.durationMinutes === null ||
        (typeof fields.durationMinutes === "number" &&
          [30, 60, 90, 120].includes(fields.durationMinutes))) &&
      typeof fields.offerWorkWindowHelp === "boolean" &&
      typeof fields.possibleWorkSession === "boolean" &&
      typeof fields.simpleAction === "boolean" &&
      (fields.targetAt === null || typeof fields.targetAt === "string") &&
      (fields.targetTimeZone === null ||
        typeof fields.targetTimeZone === "string") &&
      Array.isArray(fields.timingConstraints) &&
      fields.timingConstraints.every((item) => typeof item === "string")
    )
  ) {
    throw new Error("Conversation repository returned invalid fields");
  }

  return fields as DecisionContextFields;
}

function storedCandidate(record: Record<string, unknown>): StoredCandidate {
  if (
    typeof record.id !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    throw new Error("Conversation repository returned invalid state");
  }
  return {
    expiresAt: record.expiresAt,
    fields: fieldsFrom(record),
    id: record.id,
  };
}

function parseReadResult(value: unknown): ConversationReadResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Conversation read returned an invalid response");
  }

  if (value.kind === "none") {
    return { kind: "none" };
  }
  if (["busy", "expired", "interrupted"].includes(value.kind)) {
    if (value.completed !== true) {
      throw new Error("Conversation read did not complete the update");
    }
    return {
      completed: true,
      kind: value.kind as "busy" | "expired" | "interrupted",
    };
  }

  const stored = storedCandidate(value);
  if (value.kind === "draft") {
    if (
      !safeInteger(value.version) ||
      value.version < 1 ||
      !["awaiting_definition", "awaiting_target", "complete"].includes(
        String(value.phase),
      )
    ) {
      throw new Error("Conversation read returned an invalid draft");
    }
    return {
      ...stored,
      kind: "draft",
      phase: value.phase as ConversationPhase,
      version: value.version,
    };
  }
  if (value.kind === "permission") {
    if (
      !safeInteger(value.sourceUpdateId) ||
      !safeInteger(value.correlatedUpdateId)
    ) {
      throw new Error(
        "Conversation read returned an invalid permission candidate",
      );
    }
    return {
      ...stored,
      correlatedUpdateId: value.correlatedUpdateId,
      kind: "permission",
      sourceUpdateId: value.sourceUpdateId,
    };
  }

  throw new Error("Conversation read returned an unknown state");
}

function parseApplyResult(value: unknown): ConversationApplyResult {
  if (
    !isRecord(value) ||
    !["applied", "expired", "interrupted", "stale"].includes(
      String(value.status),
    ) ||
    typeof value.completed !== "boolean" ||
    typeof value.draftCreated !== "boolean"
  ) {
    throw new Error("Conversation apply returned an invalid response");
  }
  const draftReference = value.draftReference;
  if (
    draftReference !== undefined &&
    (!isRecord(draftReference) ||
      typeof draftReference.id !== "string" ||
      !safeInteger(draftReference.version) ||
      draftReference.version < 1)
  ) {
    throw new Error("Conversation apply returned an invalid draft reference");
  }
  return {
    completed: value.completed,
    ...(draftReference === undefined
      ? {}
      : {
          draftReference: {
            id: draftReference.id as string,
            version: (draftReference as Record<string, unknown>)
              .version as number,
          },
        }),
    draftCreated: value.draftCreated,
    status: value.status as ConversationApplyResult["status"],
  };
}

export class SupabaseConversationRepository
  implements ConversationRepository
{
  readonly #fetch: typeof fetch;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseConversationRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async readTurn(updateId: number): Promise<ConversationReadResult> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/read_conversation_turn`,
      {
        body: JSON.stringify({ p_update_id: updateId }),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      throw new Error("Conversation read failed");
    }
    return parseReadResult(await response.json());
  }

  async applyTurn(
    command: ConversationCommand,
  ): Promise<ConversationApplyResult> {
    const candidate =
      "fields" in command
        ? {
            p_definition_of_done: command.fields.definitionOfDone,
            p_duration_minutes: command.fields.durationMinutes,
            p_offer_work_window_help:
              command.fields.offerWorkWindowHelp,
            p_phase: "phase" in command ? command.phase : null,
            p_possible_work_session:
              command.fields.possibleWorkSession,
            p_simple_action: command.fields.simpleAction,
            p_target_at: command.fields.targetAt,
            p_target_time_zone: command.fields.targetTimeZone,
            p_timing_constraints: command.fields.timingConstraints,
          }
        : {
            p_definition_of_done: null,
            p_duration_minutes: null,
            p_offer_work_window_help: null,
            p_phase: null,
            p_possible_work_session: null,
            p_simple_action: null,
            p_target_at: null,
            p_target_time_zone: null,
            p_timing_constraints: null,
          };
    const expected = command.expected;
    const body = {
      p_action: command.action,
      p_audit_input_class: command.audit?.inputClass ?? null,
      p_audit_payload: command.audit?.payload ?? null,
      ...candidate,
      p_expected_correlated_update_id:
        expected.kind === "permission"
          ? expected.correlatedUpdateId
          : null,
      p_expected_id: expected.kind === "none" ? null : expected.id,
      p_expected_kind: expected.kind,
      p_expected_source_update_id:
        expected.kind === "permission" ? expected.sourceUpdateId : null,
      p_expected_version:
        expected.kind === "draft" ? expected.version : null,
      p_processing_result: command.processingResult,
      p_model_id: command.audit?.modelId ?? null,
      p_prompt_version: command.audit?.promptVersion ?? null,
      p_update_id: command.updateId,
    };
    const rpc =
      command.action === "accept_work_permission"
        ? "accept_work_session_permission"
        : "apply_conversation_turn";
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/${rpc}`,
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
      throw new Error(
        command.action === "accept_work_permission"
          ? "Work-session permission acceptance failed"
          : "Conversation apply failed",
      );
    }
    return parseApplyResult(await response.json());
  }
}
