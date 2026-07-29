import {
  decisionJsonSchema,
  type DecisionContextFields,
  type DecisionInput,
  type DecisionResult,
  parseDecisionInputStructure,
  parseProviderDecisionStructure,
} from "./schema.js";
import {
  type DecisionSemanticFailureReason,
  evaluateDecisionSemantics,
  materializeProviderDecision,
  validateDecisionInputSemantics,
} from "./semantic.js";
import type { TelegramReply } from "../confirmation.js";
import type {
  InitialWorkSessionConversationInput,
  WorkSessionConversationInput,
} from "../work-sessions/conversation-input.js";
import type { WorkSessionContinuationConversationInput } from "../work-sessions/continuation.js";

export type DecisionFailureClass =
  | "http"
  | "provider_error"
  | "incomplete"
  | "refusal"
  | "missing_output"
  | "non_json"
  | "schema"
  | "semantic"
  | "timeout";

export type DecisionFailureStage =
  | "request"
  | "provider"
  | "completion"
  | "schema"
  | "semantic";

export type DecisionAttemptCount = 0 | 1 | 2;

export type DecisionRetryRecovery = {
  attemptCount: 2;
  reason: DecisionSemanticFailureReason;
};

export type DecisionTelemetryReason =
  | DecisionFailureClass
  | DecisionSemanticFailureReason;

export type DecisionOutcome =
  | {
      decision: DecisionResult;
      approval?: Readonly<{
        reply: TelegramReply;
        target: Readonly<{
          id: string;
          kind: "commitment" | "draft";
          version: number;
        }>;
      }>;
      draftTarget?: Readonly<{
        authority: Readonly<{
          expectedVersion: number;
          id: string;
          kind: "draft";
        }>;
        fields: DecisionContextFields;
        phase: Exclude<
          DecisionInput["context"]["phase"],
          "awaiting_permission" | "none"
        >;
      }>;
      clarification?: "ambiguous_reference";
      ok: true;
      recovery?: DecisionRetryRecovery;
      continuationInput?: WorkSessionContinuationConversationInput;
      initialWorkSessionInput?: InitialWorkSessionConversationInput;
      workSessionInput?: WorkSessionConversationInput;
    }
  | {
      failure: DecisionFailureClass;
      ok: false;
      attemptCount: DecisionAttemptCount;
      reason: DecisionTelemetryReason;
      stage: DecisionFailureStage;
    };

export type DecisionTurnContext = Readonly<{
  updateId: number;
}>;

export type DecisionTurnCompletion = Readonly<{
  activeDraftId: string | null;
  assistantText: string;
  pendingQuestion: "clear" | "preserve" | "replace";
  status: "active" | "closed" | "expired" | "ignored" | "unchanged";
  updateId: number;
}>;

export interface DecisionEngine {
  completeTurn?(completion: DecisionTurnCompletion): Promise<void>;
  decide(
    input: DecisionInput,
    context?: DecisionTurnContext,
  ): Promise<DecisionOutcome>;
}

type OpenAIDecisionEngineOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  model: string;
  now?: () => Date;
  promptVersion: string;
};

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DECISION_TIMEOUT_MS = 30_000;

function stageForFailure(
  failure: DecisionFailureClass,
): DecisionFailureStage {
  switch (failure) {
    case "http":
    case "timeout":
      return "request";
    case "provider_error":
      return "provider";
    case "incomplete":
    case "missing_output":
    case "refusal":
      return "completion";
    case "non_json":
    case "schema":
      return "schema";
    case "semantic":
      return "semantic";
  }
}

function failed(
  failure: DecisionFailureClass,
  attemptCount: DecisionAttemptCount,
  reason: DecisionTelemetryReason = failure,
): DecisionOutcome {
  return {
    attemptCount,
    failure,
    ok: false,
    reason,
    stage: stageForFailure(failure),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputItems(body: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(body.output)) {
    return [];
  }

  return body.output.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function contentItems(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  return messages.flatMap((item) => {
    if (!Array.isArray(item.content)) {
      return [];
    }
    return item.content.flatMap((content) => {
      const record = asRecord(content);
      return record ? [record] : [];
    });
  });
}

function containsRefusal(
  body: Record<string, unknown>,
  messages: Record<string, unknown>[],
): boolean {
  return (
    typeof body.refusal === "string" ||
    contentItems(messages).some(
      (content) =>
        content.type === "refusal" &&
        typeof content.refusal === "string",
    )
  );
}

function readOutputText(
  body: Record<string, unknown>,
  messages: Record<string, unknown>[],
): string | undefined {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  const texts = contentItems(messages)
    .filter(
      (content) =>
        content.type === "output_text" &&
        typeof content.text === "string",
    )
    .map((content) => content.text as string);

  return texts.length > 0 ? texts.join("") : undefined;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name)
  );
}

function completionState(
  body: Record<string, unknown>,
): { failure: DecisionFailureClass } | { messages: Record<string, unknown>[] } {
  if (["incomplete", "in_progress", "queued"].includes(String(body.status))) {
    return { failure: "incomplete" };
  }
  if (body.status !== "completed") {
    return { failure: "provider_error" };
  }
  if (
    body.incomplete_details !== undefined &&
    body.incomplete_details !== null
  ) {
    return { failure: "incomplete" };
  }

  const messages = outputItems(body).filter(
    (item) => item.type === "message",
  );
  if (messages.length === 0) {
    return { failure: "provider_error" };
  }
  if (
    messages.some((message) =>
      ["incomplete", "in_progress", "queued"].includes(String(message.status)),
    )
  ) {
    return { failure: "incomplete" };
  }
  if (messages.some((message) => message.status !== "completed")) {
    return { failure: "provider_error" };
  }

  return { messages };
}

function instructions(
  promptVersion: string,
  referenceTime: string,
): string {
  return [
    `Shiori decision contract ${promptVersion}.`,
    `The immutable decision reference time is ${referenceTime}.`,
    "The input is a JSON string encoding exactly {ownerText, context: {phase, fields}, referenceNow, timeZone}; ownerText is the current owner turn, context is authoritative bounded structured state, referenceNow is the only decision clock, and timeZone is Asia/Singapore.",
    "Apply context phase and relation rules before classifying or extracting the current owner turn; classify ownerText relative to context, not in isolation.",
    "Classify exactly one input as explicit_commitment, implied_intention, or ordinary_question.",
    "Return only the strict schema's semantic fields. Never authorize, confirm, persist, schedule, call tools, or claim an action occurred.",
    "Use an absolute RFC3339 targetAt with +08:00, or null when unsupported, unknown, or absent.",
    "Resolve relative and partial dates only against the immutable decision reference time in Singapore.",
    "Tomorrow means the next Singapore calendar day.",
    "When the owner omits a year, use the current Singapore year only when the resulting instant is future.",
    "Never silently roll an explicitly or presumptively past date into a later year.",
    "Use commitmentMode unresolved while definitionOfDone or targetAt is missing. For a complete candidate the field is descriptive only: application code deterministically materializes every newly complete promise as preparation-eligible and preserves an existing complete draft's mode during correction.",
    "Use response only for a useful ordinary-question answer; otherwise return null because workflow replies are application-controlled.",
    "turnRelation is descriptive and never authorizes a transition.",
    "With phase none, turnRelation is ignored and materialized deterministically by the application.",
    "With awaiting_permission, use permission_accepted for a clear yes, permission_declined for a clear no, clarification_continuation for an unclear on-topic response, separate_request for a separate explicit or implied request, and none only for an unrelated ordinary question.",
    "With awaiting_definition or awaiting_target, use clarification_continuation only when filling null semantic candidate fields while preserving every populated field exactly; use correction only for fields the owner explicitly corrects; use separate_request for a separate explicit or implied request; use none for an unrelated ordinary question.",
    "With complete, use correction only for populated fields the owner explicitly corrects or clears; use separate_request for a separate explicit or implied request; use none for an unrelated ordinary question.",
    "For permission_accepted, use inputClass explicit_commitment and copy definitionOfDone, targetAt, commitmentMode, durationMinutes, and timingConstraints exactly from context, including every null and timingConstraints item order; do not fill, change, clear, normalize, reorder, or infer them.",
    "A separate request never overwrites context, and an ordinary question never changes context.",
  ].join(" ");
}

const correctiveInstructions = {
  clarification_context_mutation:
    "Preserve every populated context candidate field exactly.",
  clarification_filled_nothing:
    "A clarification must fill at least one null context candidate field.",
  complete_mode_unresolved:
    "Resolve a complete candidate to simple_action or possible_work_session.",
  correction_changed_nothing:
    "Use correction only when a populated context candidate field changes.",
  definition_blank:
    "Use a non-blank definitionOfDone or null.",
  implied_payload_conflict:
    "For implied_intention, keep duration null and use ask_permission.",
  incomplete_mode_resolved:
    "Use unresolved commitmentMode whenever either core field is missing.",
  input_invalid:
    "Follow the supplied bounded phase and context exactly.",
  missing_fields_invalid:
    "Derive missingFields only from absent core fields in canonical order.",
  next_action_invalid:
    "Choose the nextAction implied by class, core fields, mode, and duration.",
  ordinary_payload_conflict:
    "For ordinary_question, return no commitment candidate fields.",
  permission_candidate_mismatch:
    "For permission_accepted, copy every context candidate field exactly.",
  response_blank:
    "Return a non-blank response.",
  simple_work_fields:
    "Do not attach duration or work-help fields to simple_action.",
  target_format_invalid:
    "Use a real calendar date in absolute RFC3339 format.",
  target_not_future:
    "Use a target strictly after the immutable decision reference time.",
  target_pair_invalid:
    "Return an absolute targetAt or null.",
  target_timezone_invalid:
    "Use the exact +08:00 offset in targetAt.",
  timing_constraint_invalid:
    "Use only non-blank bounded timing constraints.",
  unsafe_relation:
    "Choose only the relation allowed for the supplied phase and class.",
  unresolved_work_help:
    "Keep work-help false until the candidate mode is resolved.",
} as const satisfies Record<DecisionSemanticFailureReason, string>;

function requestInstructions(
  promptVersion: string,
  referenceTime: string,
  correctiveReason?: DecisionSemanticFailureReason,
): string {
  const base = instructions(promptVersion, referenceTime);
  return correctiveReason === undefined
    ? base
    : `${base} Retry correction: ${correctiveInstructions[correctiveReason]}`;
}

function singaporeReferenceTime(value: Date): string {
  return new Date(value.getTime() + 8 * 60 * 60 * 1_000)
    .toISOString()
    .replace("Z", "+08:00");
}

export class OpenAIDecisionEngine implements DecisionEngine {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #now: () => Date;
  readonly #promptVersion: string;

  constructor(options: OpenAIDecisionEngineOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#model = options.model;
    this.#now = options.now ?? (() => new Date());
    this.#promptVersion = options.promptVersion;
  }

  async decide(input: DecisionInput): Promise<DecisionOutcome> {
    const structuredInput = parseDecisionInputStructure(input);
    const validationNow = this.#now();
    if (
      !structuredInput ||
      !validateDecisionInputSemantics(structuredInput, validationNow)
    ) {
      return failed("semantic", 0, "input_invalid");
    }

    const signal = AbortSignal.timeout(DECISION_TIMEOUT_MS);
    const referenceTime = singaporeReferenceTime(validationNow);
    const providerInput = JSON.stringify({
      ...structuredInput,
      referenceNow: referenceTime,
      timeZone: "Asia/Singapore",
    });
    const first = await this.#requestDecision(
      structuredInput,
      providerInput,
      signal,
      validationNow,
      referenceTime,
      1,
    );
    if (
      first.ok ||
      first.failure !== "semantic"
    ) {
      return first;
    }
    if (signal.aborted) {
      return failed("timeout", 1);
    }
    const second = await this.#requestDecision(
      structuredInput,
      providerInput,
      signal,
      validationNow,
      referenceTime,
      2,
      first.reason as DecisionSemanticFailureReason,
    );
    return second.ok
      ? {
          ...second,
          recovery: {
            attemptCount: 2,
            reason: first.reason as DecisionSemanticFailureReason,
          },
        }
      : second;
  }

  async #requestDecision(
    structuredInput: DecisionInput,
    providerInput: string,
    signal: AbortSignal,
    validationNow: Date,
    referenceTime: string,
    attemptCount: 1 | 2,
    correctiveReason?: DecisionSemanticFailureReason,
  ): Promise<DecisionOutcome> {
    let response: Response;
    const fail = (failure: DecisionFailureClass) =>
      failed(failure, attemptCount);

    try {
      response = await this.#fetch(RESPONSES_URL, {
        body: JSON.stringify({
          input: providerInput,
          instructions: requestInstructions(
            this.#promptVersion,
            referenceTime,
            correctiveReason,
          ),
          model: this.#model,
          store: false,
          text: {
            format: {
              name: "shiori_decision",
              schema: decisionJsonSchema,
              strict: true,
              type: "json_schema",
            },
          },
          tools: [],
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });
    } catch (error) {
      return fail(isTimeout(error) ? "timeout" : "http");
    }

    if (!response.ok) {
      return fail("http");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return fail(isTimeout(error) ? "timeout" : "provider_error");
    }

    const record = asRecord(body);
    if (
      !record ||
      (record.error !== undefined && record.error !== null)
    ) {
      return fail("provider_error");
    }
    const completion = completionState(record);
    if ("failure" in completion) {
      return fail(completion.failure);
    }
    if (containsRefusal(record, completion.messages)) {
      return fail("refusal");
    }

    const outputText = readOutputText(record, completion.messages);
    if (outputText === undefined || outputText.length === 0) {
      return fail("missing_output");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      return fail("non_json");
    }

    const providerDecision = parseProviderDecisionStructure(parsed);
    if (!providerDecision) {
      return fail("schema");
    }
    const decision = materializeProviderDecision(
      providerDecision,
      structuredInput,
    );
    const semantic = evaluateDecisionSemantics(
      decision,
      structuredInput,
      validationNow,
      decision,
    );
    if (!semantic.ok) {
      return failed("semantic", attemptCount, semantic.reason);
    }

    return { decision, ok: true };
  }
}
