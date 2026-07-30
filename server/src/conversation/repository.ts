import type {
  DecisionContextFields,
  DecisionInput,
  DecisionResult,
} from "../decision/schema.js";
import { supabaseHeaders } from "../supabase.js";
import { isWorkSessionDuration } from "../work-sessions/duration.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  | {
      completed: true;
      draftReference?: { id: string; version: number };
      kind: "interrupted";
    };

export type ExpectedConversationFocus =
  | { kind: "none" }
  | Pick<ActiveDraft, "id" | "kind" | "version">;

type ExpectedSnapshot =
  | ExpectedConversationFocus
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
        | "create_separate_draft"
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
    }
  | {
      audit?: never;
      processingResult: "status_empty" | "status_listed";
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

export type ConversationDraftSummary = ActiveDraft & {
  focused: boolean;
  updatedAt: string;
};

export type ConversationDraftPage = {
  drafts: ConversationDraftSummary[];
  nextCursor: string | null;
};

export type ConversationDraftReadResult =
  | { draft: ConversationDraftSummary; kind: "draft" }
  | { kind: "not_found" };

export type ConversationDraftAuthority = Readonly<{
  expectedVersion: number;
  id: string;
  kind: "draft";
}>;

export type ConversationDraftResolutionCandidate = Readonly<{
  authority: ConversationDraftAuthority;
  draft: ConversationDraftSummary;
}>;

export type ConversationDraftResolution =
  | (ConversationDraftResolutionCandidate & { kind: "exact" })
  | {
      candidates: ConversationDraftResolutionCandidate[];
      kind: "ambiguous";
    }
  | { kind: "none" };

export type ConversationDraftListRequest = {
  cursor?: string;
  limit?: number;
};

export type ConversationDraftMutationCommand = ConversationCompletion & {
  audit: DecisionAudit;
  expectedFocus: ExpectedConversationFocus;
  updateId: number;
};

export type CreateFocusedDraftCommand =
  ConversationDraftMutationCommand & {
    fields: DecisionContextFields;
    phase: ConversationPhase;
  };

export type FocusDraftCommand = ConversationDraftMutationCommand & {
  target: ConversationDraftAuthority;
};

export type PatchFocusedDraftCommand = FocusDraftCommand & {
  fields: DecisionContextFields;
  phase: ConversationPhase;
};

export interface ConversationRepository {
  applyTurn(
    command: ConversationCommand,
  ): Promise<ConversationApplyResult>;
  recordDecision?(command: Readonly<{
    audit: DecisionAudit;
    draftReference: Readonly<{ id: string; version: number }> | null;
    updateId: number;
  }>): Promise<void>;
  readTurn(updateId: number): Promise<ConversationReadResult>;
}

export interface ConversationDraftRepository
  extends ConversationRepository {
  createFocusedDraft(
    command: CreateFocusedDraftCommand,
  ): Promise<ConversationApplyResult>;
  focusDraft(
    command: FocusDraftCommand,
  ): Promise<ConversationApplyResult>;
  listDrafts(
    request?: ConversationDraftListRequest,
  ): Promise<ConversationDraftPage>;
  patchFocusedDraft(
    command: PatchFocusedDraftCommand,
  ): Promise<ConversationApplyResult>;
  readDraft(id: string): Promise<ConversationDraftReadResult>;
  resolveDraftReference(
    query: string,
    limit?: number,
  ): Promise<ConversationDraftResolution>;
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
        isWorkSessionDuration(fields.durationMinutes)) &&
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
    const draftReference = value.draftReference;
    if (
      draftReference !== undefined &&
      (
        value.kind !== "interrupted" ||
        !isRecord(draftReference) ||
        typeof draftReference.id !== "string" ||
        !safeInteger(draftReference.version) ||
        draftReference.version < 1
      )
    ) {
      throw new Error(
        "Conversation read returned an invalid restored draft reference",
      );
    }
    if (value.kind === "interrupted" && draftReference !== undefined) {
      return {
        completed: true,
        draftReference: {
          id: draftReference.id as string,
          version: draftReference.version as number,
        },
        kind: "interrupted",
      };
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

const DEFAULT_DRAFT_LIST_LIMIT = 10;
const MAX_DRAFT_LIST_LIMIT = 20;

type DraftCursor = {
  id: string;
  updatedAt: string;
};

function draftSummary(value: unknown): ConversationDraftSummary {
  if (
    !isRecord(value) ||
    value.kind !== "draft" ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.focused !== "boolean" ||
    typeof value.updatedAt !== "string" ||
    !safeInteger(value.version) ||
    value.version < 1 ||
    !["awaiting_definition", "awaiting_target", "complete"].includes(
      String(value.phase),
    )
  ) {
    throw new Error("Conversation draft read returned invalid state");
  }
  return {
    ...storedCandidate(value),
    focused: value.focused,
    kind: "draft",
    phase: value.phase as ConversationPhase,
    updatedAt: value.updatedAt,
    version: value.version,
  };
}

function boundedLimit(limit = DEFAULT_DRAFT_LIST_LIMIT): number {
  if (!safeInteger(limit) || limit < 1 || limit > MAX_DRAFT_LIST_LIMIT) {
    throw new Error(
      `Conversation draft limit must be between 1 and ${MAX_DRAFT_LIST_LIMIT}`,
    );
  }
  return limit;
}

function encodeCursor(cursor: DraftCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined): DraftCursor | null {
  if (cursor === undefined) {
    return null;
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error("invalid");
    }
    return { id: value.id, updatedAt: value.updatedAt };
  } catch {
    throw new Error("Conversation draft cursor is invalid");
  }
}

function parseDraftPage(value: unknown): ConversationDraftPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.drafts) ||
    !(
      value.nextCursor === null ||
      (isRecord(value.nextCursor) &&
        typeof value.nextCursor.id === "string" &&
        typeof value.nextCursor.updatedAt === "string")
    )
  ) {
    throw new Error("Conversation draft list returned an invalid response");
  }
  return {
    drafts: value.drafts.map(draftSummary),
    nextCursor:
      value.nextCursor === null
        ? null
        : encodeCursor({
            id: value.nextCursor.id as string,
            updatedAt: value.nextCursor.updatedAt as string,
          }),
  };
}

function parseDraftRead(value: unknown): ConversationDraftReadResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Conversation draft read returned an invalid response");
  }
  if (value.kind === "not_found") {
    return { kind: "not_found" };
  }
  if (value.kind === "draft") {
    return { draft: draftSummary(value.draft), kind: "draft" };
  }
  throw new Error("Conversation draft read returned an unknown response");
}

function parseDraftResolution(
  value: unknown,
): ConversationDraftResolution {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(
      "Conversation draft resolution returned an invalid response",
    );
  }
  if (value.kind === "none") {
    return { kind: "none" };
  }
  if (value.kind === "exact") {
    const draft = draftSummary(value.draft);
    return {
      authority: {
        expectedVersion: draft.version,
        id: draft.id,
        kind: "draft",
      },
      draft,
      kind: "exact",
    };
  }
  if (value.kind === "ambiguous" && Array.isArray(value.candidates)) {
    return {
      candidates: value.candidates.map((candidate) => {
        const draft = draftSummary(candidate);
        return {
          authority: {
            expectedVersion: draft.version,
            id: draft.id,
            kind: "draft" as const,
          },
          draft,
        };
      }),
      kind: "ambiguous",
    };
  }
  throw new Error(
    "Conversation draft resolution returned an unknown response",
  );
}

export class SupabaseConversationRepository
  implements ConversationDraftRepository
{
  readonly #fetch: typeof fetch;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseConversationRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
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
      throw new Error(`Conversation ${name} failed`);
    }
    return response.json();
  }

  #candidateBody(
    fields: DecisionContextFields,
    phase: ConversationPhase,
  ): Record<string, unknown> {
    return {
      p_definition_of_done: fields.definitionOfDone,
      p_duration_minutes: fields.durationMinutes,
      p_offer_work_window_help: fields.offerWorkWindowHelp,
      p_phase: phase,
      p_possible_work_session: fields.possibleWorkSession,
      p_simple_action: fields.simpleAction,
      p_target_at: fields.targetAt,
      p_target_time_zone: fields.targetTimeZone,
      p_timing_constraints: fields.timingConstraints,
    };
  }

  #focusBody(expected: ExpectedConversationFocus): Record<string, unknown> {
    return {
      p_expected_focus_id:
        expected.kind === "draft" ? expected.id : null,
      p_expected_focus_version:
        expected.kind === "draft" ? expected.version : null,
    };
  }

  #targetBody(
    target: ConversationDraftAuthority,
  ): Record<string, unknown> {
    if (
      target.kind !== "draft" ||
      !UUID_PATTERN.test(target.id) ||
      !safeInteger(target.expectedVersion) ||
      target.expectedVersion < 1
    ) {
      throw new Error("Conversation draft authority is invalid");
    }
    return {
      p_draft_id: target.id,
      p_expected_version: target.expectedVersion,
    };
  }

  #completionBody(
    command: ConversationDraftMutationCommand,
  ): Record<string, unknown> {
    return {
      p_audit_input_class: command.audit.inputClass,
      p_audit_payload: command.audit.payload,
      p_model_id: command.audit.modelId,
      p_processing_result: command.processingResult,
      p_prompt_version: command.audit.promptVersion,
      p_update_id: command.updateId,
    };
  }

  async createFocusedDraft(
    command: CreateFocusedDraftCommand,
  ): Promise<ConversationApplyResult> {
    return parseApplyResult(
      await this.#rpc("create_focused_conversation_draft", {
        ...this.#candidateBody(command.fields, command.phase),
        ...this.#completionBody(command),
        ...this.#focusBody(command.expectedFocus),
      }),
    );
  }

  async focusDraft(
    command: FocusDraftCommand,
  ): Promise<ConversationApplyResult> {
    return parseApplyResult(
      await this.#rpc("focus_conversation_draft", {
        ...this.#completionBody(command),
        ...this.#focusBody(command.expectedFocus),
        ...this.#targetBody(command.target),
      }),
    );
  }

  async listDrafts(
    request: ConversationDraftListRequest = {},
  ): Promise<ConversationDraftPage> {
    const cursor = decodeCursor(request.cursor);
    return parseDraftPage(
      await this.#rpc("list_conversation_drafts", {
        p_before_id: cursor?.id ?? null,
        p_before_updated_at: cursor?.updatedAt ?? null,
        p_limit: boundedLimit(request.limit),
      }),
    );
  }

  async patchFocusedDraft(
    command: PatchFocusedDraftCommand,
  ): Promise<ConversationApplyResult> {
    return parseApplyResult(
      await this.#rpc("patch_focused_conversation_draft", {
        ...this.#candidateBody(command.fields, command.phase),
        ...this.#completionBody(command),
        ...this.#focusBody(command.expectedFocus),
        ...this.#targetBody(command.target),
      }),
    );
  }

  async readDraft(id: string): Promise<ConversationDraftReadResult> {
    return parseDraftRead(
      await this.#rpc("read_conversation_draft", { p_draft_id: id }),
    );
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

  async recordDecision(command: Readonly<{
    audit: DecisionAudit;
    draftReference: Readonly<{ id: string; version: number }> | null;
    updateId: number;
  }>): Promise<void> {
    const result =
      await this.#rpc("record_claimed_conversation_decision", {
        p_audit_input_class: command.audit.inputClass,
        p_audit_payload: command.audit.payload,
        p_draft_id: command.draftReference?.id ?? null,
        p_draft_version: command.draftReference?.version ?? null,
        p_model_id: command.audit.modelId,
        p_prompt_version: command.audit.promptVersion,
        p_update_id: command.updateId,
      });
    if (
      !isRecord(result) ||
      !["applied", "replay"].includes(String(result.kind))
    ) {
      throw new Error("Conversation decision record failed");
    }
  }

  async applyTurn(
    command: ConversationCommand,
  ): Promise<ConversationApplyResult> {
    if (
      ["status_empty", "status_listed"].includes(
        command.processingResult,
      ) &&
      (
        command.action !== "preserve" ||
        command.audit !== undefined ||
        "fields" in command
      )
    ) {
      throw new Error(
        "Status completion must preserve conversation state without audit",
      );
    }
    if (command.action === "create_separate_draft") {
      if (
        command.processingResult !== "conversation" ||
        command.audit === undefined
      ) {
        throw new Error(
          "Separate draft creation requires a successful audited decision",
        );
      }
      if (command.expected.kind === "permission") {
        throw new Error(
          "Separate draft creation requires a draft or empty focus",
        );
      }
      return this.createFocusedDraft({
        audit: command.audit,
        expectedFocus: command.expected,
        fields: command.fields,
        phase: command.phase,
        processingResult: command.processingResult,
        updateId: command.updateId,
      });
    }
    if (
      command.action === "create_permission" &&
      command.expected.kind === "draft"
    ) {
      if (
        command.processingResult !== "conversation" ||
        command.audit === undefined
      ) {
        throw new Error(
          "Separate permission creation requires a successful audited decision",
        );
      }
      return parseApplyResult(
        await this.#rpc("create_separate_conversation_permission", {
          ...this.#focusBody(command.expected),
          p_audit_input_class: command.audit.inputClass,
          p_audit_payload: command.audit.payload,
          p_definition_of_done: command.fields.definitionOfDone,
          p_duration_minutes: command.fields.durationMinutes,
          p_model_id: command.audit.modelId,
          p_offer_work_window_help: command.fields.offerWorkWindowHelp,
          p_possible_work_session: command.fields.possibleWorkSession,
          p_processing_result: command.processingResult,
          p_prompt_version: command.audit.promptVersion,
          p_simple_action: command.fields.simpleAction,
          p_target_at: command.fields.targetAt,
          p_target_time_zone: command.fields.targetTimeZone,
          p_timing_constraints: command.fields.timingConstraints,
          p_update_id: command.updateId,
        }),
      );
    }
    if (
      ["accept_permission", "terminate_permission"].includes(command.action) &&
      command.expected.kind === "permission"
    ) {
      return parseApplyResult(
        await this.#rpc("resolve_separate_conversation_permission", {
          p_action: command.action,
          p_audit_input_class: command.audit?.inputClass ?? null,
          p_audit_payload: command.audit?.payload ?? null,
          p_expected_correlated_update_id:
            command.expected.correlatedUpdateId,
          p_expected_id: command.expected.id,
          p_expected_source_update_id: command.expected.sourceUpdateId,
          p_model_id: command.audit?.modelId ?? null,
          p_processing_result: command.processingResult,
          p_prompt_version: command.audit?.promptVersion ?? null,
          p_update_id: command.updateId,
        }),
      );
    }
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

  async resolveDraftReference(
    query: string,
    limit = 5,
  ): Promise<ConversationDraftResolution> {
    if (query.trim().length === 0 || query.length > 500) {
      throw new Error(
        "Conversation draft reference must be between 1 and 500 characters",
      );
    }
    return parseDraftResolution(
      await this.#rpc("resolve_conversation_draft_reference", {
        p_limit: boundedLimit(limit),
        p_query: query,
      }),
    );
  }
}
