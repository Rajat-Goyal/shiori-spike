import {
  Agent,
  OpenAIProvider,
  RunContext,
  Runner,
  RunState,
  tool,
  type AgentInputItem,
  type FunctionTool,
  type ModelProvider,
} from "@openai/agents";
import { z } from "zod";
import { failureChain, failureFrames } from "../failure-chain.js";
import {
  AGENT_PROMPT_NAMES,
  type AgentPrompts,
  FALLBACK_AGENT_PROMPTS,
  renderPrompt,
} from "./instructions.js";

import type { TelegramReply } from "../confirmation.js";
import {
  commitmentEditSchema,
  type CommitmentEditProposal,
} from "../commitments/approved-change.js";
import {
  type DecisionOutcome,
  type DecisionTelemetryReason,
} from "../decision/engine.js";
import {
  type DecisionInput,
  type DecisionResult,
  parseDecisionInputStructure,
  parseDecisionStructure,
  parseProviderDecisionStructure,
} from "../decision/schema.js";
import {
  evaluateDecisionSemantics,
  materializeProviderDecision,
  validateDecisionInputSemantics,
} from "../decision/semantic.js";
import type {
  AgentContextReader,
  AgentProductContext,
} from "./context-reader.js";
import type {
  AgentSdkSession,
  AgentSessionInteractionContext,
} from "./session.js";
import {
  MAX_WORK_SESSION_DURATION_MINUTES,
  MIN_WORK_SESSION_DURATION_MINUTES,
} from "../work-sessions/duration.js";
import type {
  InitialWorkSessionConversationInput,
  WorkSessionConversationInput,
} from "../work-sessions/conversation-input.js";
import { normalizeTimingConstraints } from "../work-sessions/availability-integration.js";
import type { WorkSessionContinuationConversationInput } from "../work-sessions/continuation.js";

export const AGENT_RUNTIME_MAX_TURNS = 4;
export const AGENT_RUNTIME_TIMEOUT_MS = 30_000;
export const AGENT_RUNTIME_TOOL_NAMES = [
  "read_context",
  "read_history",
  "list_commitments",
  "propose_draft_update",
  "propose_work_session_input",
  "propose_continuation_duration",
  "propose_initial_preparation",
  "request_sanitized_availability",
  "execute_commitment",
  "update_commitment",
] as const;

const CREATION_CONTINUATION_INPUT: readonly AgentInputItem[] = [
  {
    content:
      "Continue the active application-owned conversation using only the exact bound creation tool.",
    role: "system",
  },
];

export type AgentRuntimeToolName =
  (typeof AGENT_RUNTIME_TOOL_NAMES)[number];

export type AgentExecutionAuthority = Readonly<{
  chatId: number;
  draftId: string | null;
  draftVersion: number | null;
  entityKind?: "commitment" | "draft";
  sessionId: string | null;
  updateId: number | null;
}>;

export type ApprovedAgentExecutionAuthority = Readonly<{
  chatId: number;
  draftId: string;
  draftVersion: number;
  entityKind?: "commitment" | "draft";
  sessionId: string;
  updateId: number;
}>;

type BoundAgentExecutionAuthority = Omit<
  ApprovedAgentExecutionAuthority,
  "updateId"
>;

export type SanitizedAvailabilityRequest = Readonly<{
  endAt: string;
  startAt: string;
  timeZone: "Asia/Singapore";
}>;

export type SanitizedAvailabilitySlot = Readonly<{
  endAt: string;
  startAt: string;
  status: "busy" | "free";
}>;

export type AgentCommitmentExecutionResult = Readonly<{
  reply?: TelegramReply;
  status: "executed" | "rejected" | "replay";
}>;

export type AgentRuntimeResult = Readonly<{
  approval?:
    | Readonly<{
        proposal: DecisionResult;
        target: Readonly<{ id: string; version: number }>;
        toolName: "execute_commitment";
      }>
    | Readonly<{
        proposal: CommitmentEditProposal;
        target: Readonly<{ id: string; version: number }>;
        toolName: "update_commitment";
      }>;
  execution?: AgentCommitmentExecutionResult;
  outcome: DecisionOutcome;
  pendingApprovalState?: string;
}>;

export type AgentRuntimeConversationContext = Readonly<{
  draftResolution:
    | Readonly<{
        authority: Readonly<{
          expectedVersion: number;
          id: string;
          kind: "draft";
        }>;
        kind: "exact";
      }>
    | Readonly<{
        candidates: readonly Readonly<{
          expectedVersion: number;
          id: string;
          kind: "draft";
        }>[];
        kind: "ambiguous";
      }>
    | Readonly<{ kind: "none" }>;
  interaction: AgentSessionInteractionContext;
  olderHistoryAvailable: boolean;
  product: AgentProductContext;
}>;

export type AgentRuntimeRunRequest = Readonly<{
  authority: AgentExecutionAuthority;
  conversation: AgentRuntimeConversationContext;
  input: DecisionInput;
  session: AgentSdkSession;
}>;

export type AgentRuntimeContinueCreationRequest = Readonly<{
  authority: ApprovedAgentExecutionAuthority;
  conversation: AgentRuntimeConversationContext;
  decision: DecisionResult;
  session: AgentSdkSession;
}>;

export type AgentRuntimeResumeRequest = Readonly<{
  approval: "approve" | "reject";
  authority: AgentExecutionAuthority;
  pendingApprovalState: string;
}>;

type RuntimeContext = {
  authority: AgentExecutionAuthority;
  conversation: AgentRuntimeConversationContext | null;
  continuationInput?: WorkSessionContinuationConversationInput;
  editProposal?: CommitmentEditProposal;
  executionApproved: boolean;
  execution?: AgentCommitmentExecutionResult;
  input: DecisionInput | null;
  initialWorkSessionInput?: InitialWorkSessionConversationInput;
  lastSemanticFailure?: DecisionTelemetryReason;
  mode: "decision" | "execution";
  proposal?: DecisionResult;
  workSessionInput?: WorkSessionConversationInput;
  resumeToolName?: "execute_commitment" | "update_commitment";
  proposalTarget?: Readonly<{
    expectedVersion: number;
    id: string;
    kind: "draft";
  }> | null;
};

export type AgentRunnerInterruption = Readonly<{
  arguments: string | undefined;
  toolName: string | undefined;
}>;

export type AgentRunnerResult = Readonly<{
  finalOutput?: unknown;
  interruptions: readonly AgentRunnerInterruption[];
  serializedState: string;
}>;

export type AgentRunnerRequest = Readonly<{
  agent: Agent<RuntimeContext, "text">;
  context: RuntimeContext;
  input: readonly AgentInputItem[];
  maxTurns: number;
  safety: AgentRunnerSafetySettings;
  session?: AgentSdkSession;
  signal: AbortSignal;
}>;

export type AgentRunnerResumeRequest = Readonly<{
  agent: Agent<RuntimeContext, "text">;
  approval: "approve" | "reject";
  context: RuntimeContext;
  maxTurns: number;
  safety: AgentRunnerSafetySettings;
  serializedState: string;
  signal: AbortSignal;
}>;

export type AgentRunnerSafetySettings = Readonly<{
  /** Provider-side storage is a hard boundary and is never enabled. */
  modelStore: false;
  traceIncludeSensitiveData: boolean;
  tracingDisabled: boolean;
}>;

export interface AgentRunner {
  resume(request: AgentRunnerResumeRequest): Promise<AgentRunnerResult>;
  run(request: AgentRunnerRequest): Promise<AgentRunnerResult>;
}

export type AgentRuntimeOptions = Readonly<{
  apiKey: string;
  contextReader: AgentContextReader;
  executeCommitment: (
    authority: ApprovedAgentExecutionAuthority,
    proposal: DecisionResult,
  ) => Promise<AgentCommitmentExecutionResult>;
  model: string;
  now?: () => Date;
  requestSanitizedAvailability: (
    request: SanitizedAvailabilityRequest,
  ) => Promise<readonly SanitizedAvailabilitySlot[]>;
  onRuntimeFailure?: (event: AgentRuntimeFailureEvent) => void;
  /**
   * Instruction templates resolved at boot. Defaults to the in-code
   * fallbacks so the runtime works with Langfuse absent.
   */
  prompts?: AgentPrompts;
  /**
   * Enables the Agents SDK trace pipeline so registered processors receive the
   * run. Off by default: with no processor attached, tracing is pure overhead.
   */
  tracingEnabled?: boolean;
  runner?: AgentRunner;
  updateCommitment?: (
    authority: ApprovedAgentExecutionAuthority,
    proposal: CommitmentEditProposal,
  ) => Promise<AgentCommitmentExecutionResult>;
}>;

/**
 * Reports the concrete error behind a mapped runtime failure class. Without it a
 * thrown Supabase error, a bug in a tool `execute` body, and a genuine provider
 * outage are all indistinguishable `provider_error`.
 */
export type AgentRuntimeFailureEvent = Readonly<{
  event: "agent_runtime_failure";
  failure: Extract<DecisionOutcome, { ok: false }>["failure"];
  failureChain: readonly string[];
  failureFrames: readonly string[];
  operation: "continue_creation" | "resume" | "run";
}>;

export interface AgentRuntime {
  continueCreation(
    request: AgentRuntimeContinueCreationRequest,
  ): Promise<AgentRuntimeResult>;
  resume(request: AgentRuntimeResumeRequest): Promise<AgentRuntimeResult>;
  run(request: AgentRuntimeRunRequest): Promise<AgentRuntimeResult>;
}

type PendingApprovalEnvelope = Readonly<{
  authority: BoundAgentExecutionAuthority;
  editProposal: CommitmentEditProposal | null;
  input: DecisionInput | null;
  mode: "decision" | "execution";
  proposal: DecisionResult | null;
  sdkRunState: string;
  toolName: "execute_commitment" | "update_commitment";
  version: 1 | 2;
}>;

const proposalSchema = z
  .object({
    commitmentMode: z.enum([
      "unresolved",
      "simple_action",
      "possible_work_session",
    ]),
    definitionOfDone: z.string().min(1).max(500).nullable(),
    durationMinutes: z.number().int()
      .min(MIN_WORK_SESSION_DURATION_MINUTES)
      .max(MAX_WORK_SESSION_DURATION_MINUTES)
      .nullable(),
    inputClass: z.enum([
      "explicit_commitment",
      "implied_intention",
      "ordinary_question",
    ]),
    response: z.string().min(1).max(1_000).nullable(),
    targetAt: z.string().min(1).max(64).nullable(),
    target: z
      .object({
        expectedVersion: z.number().int().positive(),
        id: z.string().uuid(),
        kind: z.literal("draft"),
      })
      .strict()
      .nullable(),
    timingConstraints: z.array(z.string().min(1).max(200)).max(4),
    turnRelation: z.enum([
      "none",
      "new_request",
      "clarification_continuation",
      "correction",
      "separate_request",
      "permission_accepted",
      "permission_declined",
    ]),
  })
  .strict();

const availabilitySchema = z
  .object({
    endAt: z.string().min(1).max(64),
    startAt: z.string().min(1).max(64),
    timeZone: z.literal("Asia/Singapore"),
  })
  .strict();

const workSessionInputSchema = z
  .object({
    draftId: z.string().uuid(),
    draftVersion: z.number().int().positive(),
    durationMinutes: z.number().int()
      .min(MIN_WORK_SESSION_DURATION_MINUTES)
      .max(MAX_WORK_SESSION_DURATION_MINUTES)
      .nullable(),
    followUpQuestion: z.string().trim().min(1).max(300).nullable(),
    nextInput: z.enum([
      "duration",
      "owner_time",
      "timing_constraints",
    ]).nullable(),
    preparationRequired: z.boolean().nullable(),
    startAt: z.string().min(1).max(64).nullable(),
    timingConstraints: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

const continuationDurationSchema = z
  .object({
    durationMinutes: z.number().int()
      .min(MIN_WORK_SESSION_DURATION_MINUTES)
      .max(MAX_WORK_SESSION_DURATION_MINUTES),
    intentId: z.string().uuid(),
    intentVersion: z.number().int().positive(),
  })
  .strict();

const initialPreparationSchema = workSessionInputSchema.omit({
  draftId: true,
  draftVersion: true,
}).extend({
  preparationRequired: z.boolean(),
}).strict();

const executionSchema = z
  .object({
    draftId: z.string().min(1).max(128),
    draftVersion: z.number().int().positive(),
  })
  .strict();

const noArgumentsSchema = z.object({}).strict();
const historySchema = z
  .object({
    cursor: z.string().min(1).max(4_096).nullable(),
    limit: z.number().int().min(1).max(40),
  })
  .strict();
const listSchema = z
  .object({
    limit: z.number().int().min(1).max(10),
  })
  .strict();

function fail(
  failure: Extract<
    DecisionOutcome,
    { ok: false }
  >["failure"],
  reason: DecisionTelemetryReason = failure,
): DecisionOutcome {
  const stage =
    failure === "timeout" || failure === "http"
      ? "request"
      : failure === "schema" || failure === "non_json"
        ? "schema"
        : failure === "semantic"
          ? "semantic"
          : failure === "provider_error"
            ? "provider"
            : "completion";
  return {
    attemptCount: 1,
    failure,
    ok: false,
    reason,
    stage,
  };
}

/**
 * Agent run safety settings.
 *
 * `traceIncludeSensitiveData` follows tracing: the owner chose full-content
 * traces, and a trace without the prompt or completion cannot explain why a
 * proposal failed validation. Provider-side storage stays disabled regardless.
 */
function agentSafety(tracingEnabled: boolean): AgentRunnerSafetySettings {
  return {
    modelStore: false,
    traceIncludeSensitiveData: tracingEnabled,
    tracingDisabled: !tracingEnabled,
  };
}

function sameAuthority(
  left: BoundAgentExecutionAuthority,
  right: AgentExecutionAuthority,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.draftId === right.draftId &&
    left.draftVersion === right.draftVersion &&
    (left.entityKind ?? "draft") ===
      (right.entityKind ?? "draft") &&
    left.sessionId === right.sessionId
  );
}

function approvedAuthority(
  authority: AgentExecutionAuthority,
): ApprovedAgentExecutionAuthority | null {
  return (
    Number.isSafeInteger(authority.chatId) &&
    authority.chatId !== 0 &&
    authority.draftId !== null &&
    authority.draftId.length > 0 &&
    authority.draftVersion !== null &&
    Number.isSafeInteger(authority.draftVersion) &&
    authority.draftVersion > 0 &&
    authority.sessionId !== null &&
    authority.sessionId.length > 0 &&
    authority.updateId !== null &&
    Number.isSafeInteger(authority.updateId) &&
    authority.updateId > 0
  )
      ? {
        chatId: authority.chatId,
        draftId: authority.draftId,
        draftVersion: authority.draftVersion,
        ...(authority.entityKind === undefined
          ? {}
          : { entityKind: authority.entityKind }),
        sessionId: authority.sessionId,
        updateId: authority.updateId,
      }
    : null;
}

function isCompleteProposal(
  proposal: DecisionResult | undefined,
): proposal is DecisionResult {
  return (
    proposal !== undefined &&
    proposal.inputClass === "explicit_commitment" &&
    proposal.definitionOfDone !== null &&
    proposal.targetAt !== null
  );
}

function parseMaterializedDecision(value: unknown): DecisionResult | null {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).response === ""
  ) {
    const parsed = parseDecisionStructure({
      ...(value as Record<string, unknown>),
      response: "_",
    });
    return parsed === null ? null : { ...parsed, response: "" };
  }
  return parseDecisionStructure(value);
}

function parsePendingEnvelope(value: string): PendingApprovalEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const authority = record.authority;
  if (
    ![1, 2].includes(Number(record.version)) ||
    !["execute_commitment", "update_commitment"].includes(
      String(record.toolName),
    ) ||
    typeof record.sdkRunState !== "string" ||
    authority === null ||
    typeof authority !== "object" ||
    Array.isArray(authority)
  ) {
    return null;
  }
  const authorityRecord = authority as Record<string, unknown>;
  const normalizedAuthority: BoundAgentExecutionAuthority = {
    chatId: Number(authorityRecord.chatId),
    draftId: String(authorityRecord.draftId ?? ""),
    draftVersion: Number(authorityRecord.draftVersion),
    ...(authorityRecord.entityKind === "commitment"
      ? { entityKind: "commitment" as const }
      : {}),
    sessionId: String(authorityRecord.sessionId ?? ""),
  };
  const input =
    record.input === null
      ? null
      : parseDecisionInputStructure(record.input);
  const proposal = parseMaterializedDecision(record.proposal);
  const editProposal =
    record.editProposal === null || record.editProposal === undefined
      ? null
      : commitmentEditSchema.safeParse(record.editProposal);
  const toolName = record.toolName as PendingApprovalEnvelope["toolName"];
  if (
    !Number.isSafeInteger(normalizedAuthority.chatId) ||
    normalizedAuthority.chatId === 0 ||
    normalizedAuthority.draftId.length === 0 ||
    !Number.isSafeInteger(normalizedAuthority.draftVersion) ||
    normalizedAuthority.draftVersion <= 0 ||
    normalizedAuthority.sessionId.length === 0 ||
    !["decision", "execution"].includes(String(record.mode)) ||
    (record.mode === "decision" && input === null) ||
    (
      toolName === "execute_commitment" &&
      (proposal === null || !isCompleteProposal(proposal))
    ) ||
    (
      toolName === "update_commitment" &&
      (
        record.mode !== "decision" ||
        editProposal === null ||
        !editProposal.success ||
        normalizedAuthority.entityKind !== "commitment" ||
        editProposal.data.commitmentId !==
          normalizedAuthority.draftId ||
        editProposal.data.expectedVersion !==
          normalizedAuthority.draftVersion
      )
    )
  ) {
    return null;
  }
  return {
    authority: normalizedAuthority,
    editProposal:
      editProposal !== null && editProposal.success
        ? editProposal.data
        : null,
    input,
    mode: record.mode as "decision" | "execution",
    proposal,
    sdkRunState: record.sdkRunState,
    toolName,
    version: Number(record.version) as 1 | 2,
  };
}

function sanitizeAvailability(
  slots: readonly SanitizedAvailabilitySlot[],
): SanitizedAvailabilitySlot[] {
  return slots.map((slot) => ({
    endAt: slot.endAt,
    startAt: slot.startAt,
    status: slot.status,
  }));
}

function expectedDraftAuthority(
  context: RuntimeContext,
): Readonly<{
  expectedVersion: number;
  id: string;
  kind: "draft";
}> | null {
  if (context.conversation?.draftResolution.kind === "exact") {
    return context.conversation.draftResolution.authority;
  }
  if (context.conversation?.draftResolution.kind === "ambiguous") {
    return null;
  }
  return context.authority.draftId !== null &&
    context.authority.draftVersion !== null
    ? {
        expectedVersion: context.authority.draftVersion,
        id: context.authority.draftId,
        kind: "draft",
      }
    : null;
}

function workSessionDecision(
  input: DecisionInput | null,
): DecisionResult | null {
  const fields = input?.context.fields;
  if (
    input?.context.phase !== "complete" ||
    fields == null ||
    fields.definitionOfDone === null ||
    fields.targetAt === null ||
    fields.commitmentMode !== "possible_work_session"
  ) {
    return null;
  }
  return {
    commitmentMode: "possible_work_session",
    definitionOfDone: fields.definitionOfDone,
    durationMinutes: fields.durationMinutes,
    inputClass: "ordinary_question",
    missingFields: [],
    nextAction: "answer",
    offerWorkWindowHelp: false,
    response: "",
    targetAt: fields.targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: fields.timingConstraints,
    turnRelation: "none",
  };
}

function continuationDecision(): DecisionResult {
  return {
    commitmentMode: "unresolved",
    definitionOfDone: null,
    durationMinutes: null,
    inputClass: "ordinary_question",
    missingFields: [],
    nextAction: "answer",
    offerWorkWindowHelp: false,
    response: "",
    targetAt: null,
    targetTimeZone: null,
    timingConstraints: [],
    turnRelation: "none",
  };
}

function explicitlySupportsInitialPreparation(
  ownerText: string | undefined,
  value: InitialWorkSessionConversationInput,
): boolean {
  if (ownerText === undefined) {
    return false;
  }
  const normalized = ownerText.toLocaleLowerCase("en");
  if (!value.preparationRequired) {
    return /\b(?:no|without|don['’]?t need)\s+(?:any\s+)?(?:prep|preparation|preparing)\b/.test(
      normalized,
    );
  }
  const explicitWork =
    /\b(?:prep|preparation|prepare|preparing|focus(?:ed)?\s+(?:time|work)|work\s+session)\b/;
  if (value.durationMinutes === null) {
    return explicitWork.test(normalized);
  }

  const duration = String(value.durationMinutes);
  const durationOccurrence = new RegExp(
    `\\b${duration}\\s*(?:minutes?|mins?|m)\\b`,
    "g",
  );
  const prepOnlyDuration = new RegExp(
    `^(?:(?:yes|yeah|yep|sure)[,.!?]?\\s+)?(?:(?:i\\s+)?(?:need|want|would\\s+need)\\s+)?${duration}\\s*(?:minutes?|mins?|m)(?:\\s+(?:please))?[.!?]?$`,
  );
  if (prepOnlyDuration.test(normalized.trim())) {
    return true;
  }

  for (const occurrence of normalized.matchAll(durationOccurrence)) {
    const start = occurrence.index;
    const end = start + occurrence[0].length;
    if (
      /\b(?:in|within|after)\s*$/.test(normalized.slice(0, start))
    ) {
      continue;
    }
    const localContext = normalized.slice(
      Math.max(0, start - 48),
      Math.min(normalized.length, end + 48),
    );
    if (explicitWork.test(localContext)) {
      return true;
    }
  }
  return false;
}

function hasAmbiguousDraftResolution(context: RuntimeContext): boolean {
  return context.conversation?.draftResolution.kind === "ambiguous";
}

function singaporeReferenceTimestamp(now: Date): string {
  const singaporeWallClock = new Date(
    now.getTime() + 8 * 60 * 60 * 1_000,
  );
  return singaporeWallClock
    .toISOString()
    .replace(/Z$/, "+08:00");
}

function runtimeInstructions(
  input: DecisionInput,
  now: Date,
  conversation: AgentRuntimeConversationContext | null,
  prompts: AgentPrompts,
): string {
  return renderPrompt(prompts[AGENT_PROMPT_NAMES.decision].template, {
    conversationContext: JSON.stringify(conversation),
    decisionInput: JSON.stringify(input),
    referenceTimestamp: singaporeReferenceTimestamp(now),
  });
}

function executionInstructions(
  authority: ApprovedAgentExecutionAuthority,
  prompts: AgentPrompts,
): string {
  return renderPrompt(prompts[AGENT_PROMPT_NAMES.execution].template, {
    draftId: JSON.stringify(authority.draftId),
    draftVersion: String(authority.draftVersion),
  });
}

function editExecutionInstructions(
  authority: ApprovedAgentExecutionAuthority,
  prompts: AgentPrompts,
): string {
  return renderPrompt(
    prompts[AGENT_PROMPT_NAMES.commitmentEdit].template,
    {
      commitmentId: JSON.stringify(authority.draftId),
      expectedVersion: String(authority.draftVersion),
    },
  );
}

function exactCreationProposal(context: RuntimeContext): boolean {
  if (!isCompleteProposal(context.proposal)) {
    return false;
  }
  if (context.mode === "execution") {
    return true;
  }
  if (
    context.resumeToolName === "execute_commitment" &&
    context.conversation === null
  ) {
    return true;
  }
  const authority = approvedAuthority(context.authority);
  const draft =
    authority === null
      ? null
      : context.conversation?.product.drafts.find(
          (candidate) =>
            candidate.id === authority.draftId &&
            candidate.version === authority.draftVersion,
        ) ?? null;
  return (
    authority?.entityKind !== "commitment" &&
    draft !== null &&
    draft.phase === "complete" &&
    draft.mode !== "unresolved" &&
    draft.definitionOfDone === context.proposal.definitionOfDone &&
    draft.targetAt === context.proposal.targetAt &&
    draft.mode === context.proposal.commitmentMode
  );
}

function buildTools(
  context: RuntimeContext,
  options: AgentRuntimeOptions,
  now: Date,
  session?: AgentSdkSession,
): FunctionTool<RuntimeContext, never, unknown>[] {
  const readContext = tool({
    description:
      "Read bounded, sanitized, application-owned conversational and product context. This tool cannot mutate it.",
    name: "read_context",
    parameters: noArgumentsSchema,
    strict: true,
    isEnabled: context.conversation !== null,
    execute: () => structuredClone(context.conversation),
  });
  const readHistory = tool({
    description:
      "Read one bounded page of older application-encrypted conversation items using an opaque cursor. This tool cannot mutate state.",
    name: "read_history",
    parameters: historySchema,
    strict: true,
    isEnabled: context.conversation !== null && session !== undefined,
    execute: async ({ cursor, limit }) => {
      if (session === undefined) {
        throw new Error("history_session_unavailable");
      }
      return options.contextReader.readHistory(
        session,
        cursor ?? undefined,
        limit,
      );
    },
  });
  const listCommitments = tool({
    description:
      "List a bounded set of the owner's sanitized authoritative commitments. This tool cannot mutate state.",
    name: "list_commitments",
    parameters: listSchema,
    strict: true,
    isEnabled: context.conversation !== null,
    execute: ({ limit }) => ({
      commitments:
        context.conversation?.product.commitments.slice(0, limit) ?? [],
      truncated:
        context.conversation?.product.truncated.commitments ?? false,
    }),
  });
  const proposeDraftUpdate = tool({
    description:
      "Submit the one bounded semantic decision proposal. The application materializes and validates it before accepting it.",
    name: "propose_draft_update",
    parameters: proposalSchema,
    strict: true,
    execute: (value) => {
      if (context.input === null) {
        context.lastSemanticFailure = "input_invalid";
        return { accepted: false, reason: "input_invalid" };
      }
      const { target, ...providerValue } = value;
      const providerDecision = parseProviderDecisionStructure(providerValue);
      if (providerDecision === null) {
        context.lastSemanticFailure = "schema";
        return { accepted: false, reason: "schema" };
      }
      const proposal = materializeProviderDecision(
        providerDecision,
        context.input,
      );
      const semantic = evaluateDecisionSemantics(
        proposal,
        context.input,
        now,
        proposal,
      );
      if (!semantic.ok) {
        context.lastSemanticFailure = semantic.reason;
        return { accepted: false, reason: semantic.reason };
      }
      const patchesDraft = [
        "clarification_continuation",
        "correction",
      ].includes(proposal.turnRelation);
      const expectedTarget = expectedDraftAuthority(context);
      if (
        patchesDraft &&
        (
          target === null ||
          expectedTarget === null ||
          target.kind !== expectedTarget.kind ||
          target.id !== expectedTarget.id ||
          target.expectedVersion !== expectedTarget.expectedVersion
        )
      ) {
        context.lastSemanticFailure = "draft_target_invalid";
        return { accepted: false, reason: "draft_target_invalid" };
      }
      if (!patchesDraft && target !== null) {
        context.lastSemanticFailure = "draft_target_invalid";
        return { accepted: false, reason: "draft_target_invalid" };
      }
      context.proposal = proposal;
      context.proposalTarget = target;
      context.lastSemanticFailure = undefined;
      return { accepted: true, decision: proposal };
    },
  });
  const proposeWorkSessionInput = tool({
    description:
      "Submit the current owner's natural preparation answer for the exact focused draft. This validates interpretation only; deterministic application code owns all state and Calendar decisions.",
    name: "propose_work_session_input",
    parameters: workSessionInputSchema,
    strict: true,
    isEnabled:
      !hasAmbiguousDraftResolution(context) &&
      context.conversation?.product.drafts.some(
        (draft) =>
          draft.id === context.authority.draftId &&
          draft.version === context.authority.draftVersion &&
          draft.preparation !== null &&
          draft.preparation !== undefined,
      ) === true,
    execute: (value) => {
      const expected = expectedDraftAuthority(context);
      const draft = context.conversation?.product.drafts.find(
        (candidate) =>
          candidate.id === value.draftId &&
          candidate.version === value.draftVersion,
      );
      const stage = draft?.preparation?.stage;
      const decision = workSessionDecision(context.input);
      const normalizedTiming =
        value.timingConstraints === null
          ? null
          : normalizeTimingConstraints(value.timingConstraints, []);
      const startMillis =
        value.startAt === null ? null : Date.parse(value.startAt);
      const exactStart =
        value.startAt === null ||
        (
          /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|30):00\+08:00$/.test(
            value.startAt,
          ) &&
          Number.isFinite(startMillis) &&
          startMillis! > now.getTime()
        );
      const followUpMatches =
        value.nextInput === null
          ? value.followUpQuestion === null
          : value.followUpQuestion !== null &&
            value.followUpQuestion.endsWith("?");
      const commonValid =
        expected !== null &&
        expected.id === value.draftId &&
        expected.expectedVersion === value.draftVersion &&
        draft?.focused === true &&
        stage !== undefined &&
        decision !== null &&
        exactStart &&
        followUpMatches &&
        !(
          value.startAt !== null &&
          value.timingConstraints !== null
        ) &&
        (
          normalizedTiming === null ||
          normalizedTiming.status === "ok"
        );
      let stageValid = false;
      if (commonValid && stage === "offer_help") {
        stageValid =
          value.preparationRequired === false
            ? value.durationMinutes === null &&
              value.startAt === null &&
              value.timingConstraints === null &&
              value.nextInput === null
            : value.preparationRequired === true &&
              (
                value.durationMinutes === null
                  ? value.startAt === null &&
                    value.timingConstraints === null &&
                    value.nextInput === "duration"
                  : value.startAt !== null ||
                      value.timingConstraints !== null
                    ? value.nextInput === null
                    : value.nextInput === "owner_time" ||
                      value.nextInput === "timing_constraints"
              );
      } else if (
        commonValid &&
        stage === "awaiting_duration_help"
      ) {
        stageValid =
          value.preparationRequired === null &&
          value.durationMinutes !== null &&
          (
            value.startAt !== null ||
              value.timingConstraints !== null
              ? value.nextInput === null
            : draft.preparation?.timingConstraints !== null
              ? value.nextInput === null
              : value.nextInput === "timing_constraints"
          );
      } else if (
        commonValid &&
        stage === "awaiting_duration_owner"
      ) {
        stageValid =
          value.preparationRequired === null &&
          value.durationMinutes !== null &&
          value.timingConstraints === null &&
          (
            value.startAt !== null
              ? value.nextInput === null
              : value.nextInput === "owner_time"
          );
      } else if (
        commonValid &&
        stage === "awaiting_constraints"
      ) {
        stageValid =
          value.preparationRequired === null &&
          value.durationMinutes === null &&
          value.startAt === null &&
          value.timingConstraints !== null &&
          value.nextInput === null;
      } else if (
        commonValid &&
        stage === "awaiting_owner_time"
      ) {
        stageValid =
          value.preparationRequired === null &&
          value.durationMinutes === null &&
          value.startAt !== null &&
          value.timingConstraints === null &&
          value.nextInput === null;
      }
      if (!stageValid || normalizedTiming?.status === "invalid") {
        context.lastSemanticFailure = "input_invalid";
        return { accepted: false, reason: "input_invalid" };
      }
      context.workSessionInput = {
        ...value,
        timingConstraints:
          normalizedTiming?.status === "ok"
            ? normalizedTiming.canonical
            : null,
      };
      context.lastSemanticFailure = undefined;
      return { accepted: true };
    },
  });
  const proposeContinuationDuration = tool({
    description:
      "Submit a natural remaining-work duration for the one exact application-owned continuation awaiting duration.",
    name: "propose_continuation_duration",
    parameters: continuationDurationSchema,
    strict: true,
    isEnabled:
      !hasAmbiguousDraftResolution(context) &&
      expectedDraftAuthority(context) === null &&
      (
        context.conversation?.product.continuations?.filter(
          (continuation) =>
            continuation.stage === "awaiting_duration",
        ).length ?? 0
      ) === 1,
    execute: (value) => {
      const awaiting =
        context.conversation?.product.continuations?.filter(
          (continuation) =>
            continuation.stage === "awaiting_duration",
        ) ?? [];
      if (
        awaiting.length !== 1 ||
        awaiting[0]!.id !== value.intentId ||
        awaiting[0]!.version !== value.intentVersion
      ) {
        context.lastSemanticFailure = "input_invalid";
        return { accepted: false, reason: "input_invalid" };
      }
      context.continuationInput = value;
      context.lastSemanticFailure = undefined;
      return { accepted: true };
    },
  });
  const proposeInitialPreparation = tool({
    description:
      "Submit an explicit preparation decision and any preparation duration, natural timing constraints, or exact owner start supplied while this message completes a promise.",
    name: "propose_initial_preparation",
    parameters: initialPreparationSchema,
    strict: true,
    isEnabled:
      !hasAmbiguousDraftResolution(context) &&
      context.conversation !== null &&
      context.conversation.product.drafts.every(
        (draft) =>
          draft.id !== context.authority.draftId ||
          draft.preparation === null ||
          draft.preparation === undefined,
      ),
    execute: (value) => {
      const normalizedTiming =
        value.timingConstraints === null
          ? null
          : normalizeTimingConstraints(value.timingConstraints, []);
      const startMillis =
        value.startAt === null ? null : Date.parse(value.startAt);
      const exactStart =
        value.startAt === null ||
        (
          /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|30):00\+08:00$/.test(
            value.startAt,
          ) &&
          Number.isFinite(startMillis) &&
          startMillis! > now.getTime()
        );
      const followUpMatches =
        value.nextInput === null
          ? value.followUpQuestion === null
          : value.followUpQuestion !== null &&
            value.followUpQuestion.endsWith("?");
      const noPreparation =
        !value.preparationRequired &&
        value.durationMinutes === null &&
        value.startAt === null &&
        value.timingConstraints === null &&
        value.nextInput === null;
      const preparation =
        value.preparationRequired &&
        exactStart &&
        followUpMatches &&
        !(value.startAt !== null && value.timingConstraints !== null) &&
        (
          normalizedTiming === null ||
          normalizedTiming.status === "ok"
        ) &&
        (
          value.durationMinutes === null
            ? value.startAt === null &&
              value.nextInput === "duration"
            : value.startAt !== null ||
                value.timingConstraints !== null
              ? value.nextInput === null
              : value.nextInput === "owner_time" ||
                value.nextInput === "timing_constraints"
        );
      if (
        (!noPreparation && !preparation) ||
        normalizedTiming?.status === "invalid" ||
        !explicitlySupportsInitialPreparation(
          context.input?.ownerText,
          value,
        )
      ) {
        context.lastSemanticFailure = "input_invalid";
        return { accepted: false, reason: "input_invalid" };
      }
      context.initialWorkSessionInput = {
        ...value,
        timingConstraints:
          normalizedTiming?.status === "ok"
            ? normalizedTiming.canonical
            : null,
      };
      context.lastSemanticFailure = undefined;
      return { accepted: true };
    },
  });
  const requestAvailability = tool({
    description:
      "Request sanitized free/busy intervals. Calendar titles, descriptions, attendees, locations, and event identifiers are unavailable.",
    name: "request_sanitized_availability",
    parameters: availabilitySchema,
    strict: true,
    isEnabled: !hasAmbiguousDraftResolution(context),
    execute: async (request) =>
      sanitizeAvailability(
        await options.requestSanitizedAvailability(request),
      ),
  });
  const executeCommitment = tool({
    description:
      "Execute the exact application-owned commitment draft after a human approves this call.",
    name: "execute_commitment",
    needsApproval: true,
    isEnabled:
      !hasAmbiguousDraftResolution(context) &&
      approvedAuthority(context.authority) !== null &&
      (
        context.resumeToolName === "execute_commitment" ||
        context.mode === "execution" ||
        context.conversation?.product.drafts.some(
          (draft) =>
            draft.id === context.authority.draftId &&
            draft.version === context.authority.draftVersion &&
            draft.phase === "complete" &&
            draft.mode !== "unresolved",
        ) === true
      ),
    parameters: executionSchema,
    strict: true,
    execute: async ({ draftId, draftVersion }) => {
      const authority = approvedAuthority(context.authority);
      const proposal = context.proposal;
      if (
        !context.executionApproved ||
        authority === null ||
        draftId !== context.authority.draftId ||
        draftVersion !== context.authority.draftVersion ||
        !isCompleteProposal(proposal) ||
        !exactCreationProposal(context)
      ) {
        throw new Error("execution_authority_mismatch");
      }
      const result = await options.executeCommitment(
        authority,
        proposal,
      );
      context.execution = result;
      return { status: result.status };
    },
  });
  const updateCommitment = tool({
    description:
      "Request one exact versioned material edit to an active commitment. The complete desired state and Calendar policies are application-validated and require owner approval.",
    name: "update_commitment",
    needsApproval: true,
    isEnabled:
      !hasAmbiguousDraftResolution(context) &&
      options.updateCommitment !== undefined &&
      approvedAuthority(context.authority)?.entityKind ===
        "commitment" &&
      (
        context.resumeToolName === "update_commitment" ||
        context.editProposal !== undefined ||
        context.conversation?.product.commitments.some(
          (commitment) =>
            commitment.id === context.authority.draftId &&
            commitment.version === context.authority.draftVersion &&
            commitment.status === "active",
        ) === true
      ),
    parameters: commitmentEditSchema,
    strict: true,
    execute: async (value) => {
      const authority = approvedAuthority(context.authority);
      const proposal = commitmentEditSchema.safeParse(value);
      if (
        !context.executionApproved ||
        authority === null ||
        authority.entityKind !== "commitment" ||
        proposal.success === false ||
        proposal.data.commitmentId !== authority.draftId ||
        proposal.data.expectedVersion !== authority.draftVersion ||
        context.editProposal === undefined ||
        JSON.stringify(proposal.data) !==
          JSON.stringify(context.editProposal) ||
        options.updateCommitment === undefined
      ) {
        throw new Error("commitment_edit_authority_mismatch");
      }
      const result = await options.updateCommitment(
        authority,
        proposal.data,
      );
      context.execution = result;
      return { status: result.status };
    },
  });
  return [
    readContext,
    readHistory,
    listCommitments,
    proposeDraftUpdate,
    proposeWorkSessionInput,
    proposeContinuationDuration,
    proposeInitialPreparation,
    requestAvailability,
    executeCommitment,
    updateCommitment,
  ] as FunctionTool<RuntimeContext, never, unknown>[];
}

export class OpenAIAgentsRunner implements AgentRunner {
  readonly #provider: ModelProvider;

  constructor(apiKey: string, provider?: ModelProvider) {
    this.#provider =
      provider ??
      new OpenAIProvider({
        apiKey,
        useResponses: true,
      });
  }

  async run(request: AgentRunnerRequest): Promise<AgentRunnerResult> {
    const runner = this.#runner(request.safety);
    const result = await runner.run(request.agent, [...request.input], {
      context: request.context,
      maxTurns: request.maxTurns,
      session: request.session,
      signal: request.signal,
    });
    const interruptions = result.interruptions.map((item) => ({
      arguments: item.arguments,
      toolName: item.name,
    }));
    return {
      ...(interruptions.length === 0
        ? { finalOutput: result.finalOutput }
        : {}),
      interruptions,
      serializedState: result.state.toString(),
    };
  }

  async resume(
    request: AgentRunnerResumeRequest,
  ): Promise<AgentRunnerResult> {
    const runContext = new RunContext(request.context);
    const state = await RunState.fromStringWithContext(
      request.agent,
      request.serializedState,
      runContext,
      { contextStrategy: "replace" },
    );
    const interruptions = state.getInterruptions();
    const executionInterruption = interruptions.find(
      (item) =>
        item.name === "execute_commitment" ||
        item.name === "update_commitment",
    );
    if (
      executionInterruption === undefined ||
      interruptions.length !== 1
    ) {
      throw new Error("pending_approval_invalid");
    }
    if (request.approval === "approve") {
      state.approve(executionInterruption);
    } else {
      state.reject(executionInterruption, {
        message: "The owner rejected commitment execution.",
      });
    }
    const result = await this.#runner(request.safety).run(request.agent, state, {
      maxTurns: request.maxTurns,
      signal: request.signal,
    });
    return {
      finalOutput: result.finalOutput,
      interruptions: result.interruptions.map((item) => ({
        arguments: item.arguments,
        toolName: item.name,
      })),
      serializedState: result.state.toString(),
    };
  }

  #runner(safety: AgentRunnerSafetySettings): Runner {
    return new Runner({
      modelProvider: this.#provider,
      modelSettings: { store: safety.modelStore },
      traceIncludeSensitiveData: safety.traceIncludeSensitiveData,
      tracingDisabled: safety.tracingDisabled,
      workflowName: "shiori-bounded-decision",
    });
  }
}

function executionArgumentsMatch(
  interruption: AgentRunnerInterruption,
  authority: AgentExecutionAuthority,
): boolean {
  if (
    interruption.toolName !== "execute_commitment" ||
    interruption.arguments === undefined
  ) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(interruption.arguments);
  } catch {
    return false;
  }
  const checked = executionSchema.safeParse(parsed);
  return (
    checked.success &&
    checked.data.draftId === authority.draftId &&
    checked.data.draftVersion === authority.draftVersion
  );
}

function commitmentEditFromInterruption(
  interruption: AgentRunnerInterruption,
  context: RuntimeContext,
): CommitmentEditProposal | null {
  if (
    interruption.toolName !== "update_commitment" ||
    interruption.arguments === undefined
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(interruption.arguments);
  } catch {
    return null;
  }
  const checked = commitmentEditSchema.safeParse(parsed);
  const authority = approvedAuthority(context.authority);
  if (
    !checked.success ||
    authority === null ||
    authority.entityKind !== "commitment" ||
    checked.data.commitmentId !== authority.draftId ||
    checked.data.expectedVersion !== authority.draftVersion
  ) {
    return null;
  }
  const current =
    context.conversation?.product.commitments.find(
      (commitment) =>
        commitment.id === checked.data.commitmentId &&
        commitment.version === checked.data.expectedVersion,
    ) ?? null;
  if (
    context.conversation !== null &&
    (current === null || current.status !== "active")
  ) {
    return null;
  }
  return checked.data;
}

function editDecision(
  proposal: CommitmentEditProposal,
): DecisionResult {
  return {
    commitmentMode: proposal.preparation.required
      ? "possible_work_session"
      : "simple_action",
    definitionOfDone: proposal.definitionOfDone,
    durationMinutes:
      proposal.preparation.nextWorkSession?.durationMinutes ?? null,
    inputClass: "ordinary_question",
    missingFields: [],
    nextAction: "answer",
    offerWorkWindowHelp: false,
    response: "",
    targetAt: proposal.targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints:
      proposal.preparation.nextWorkSession === null
        ? []
        : [proposal.preparation.nextWorkSession.timingConstraints],
    turnRelation: "none",
  };
}

function resultFromRunner(
  result: AgentRunnerResult,
  context: RuntimeContext,
): AgentRuntimeResult {
  if (result.interruptions.length > 0) {
    const authority = approvedAuthority(context.authority);
    const interruption = result.interruptions[0];
    if (authority === null || result.interruptions.length !== 1) {
      return { outcome: fail("semantic", "input_invalid") };
    }
    const isCreation =
      executionArgumentsMatch(interruption!, authority) &&
      exactCreationProposal(context);
    const edit = commitmentEditFromInterruption(
      interruption!,
      context,
    );
    if (!isCreation && edit === null) {
      return { outcome: fail("semantic", "input_invalid") };
    }
    const decision = edit === null
      ? context.proposal!
      : editDecision(edit);
    const envelope: PendingApprovalEnvelope = {
      authority: {
        chatId: authority.chatId,
        draftId: authority.draftId,
        draftVersion: authority.draftVersion,
        ...(authority.entityKind === undefined
          ? {}
          : { entityKind: authority.entityKind }),
        sessionId: authority.sessionId,
      },
      editProposal: edit,
      input: context.input,
      mode: context.mode,
      proposal: edit === null ? context.proposal! : null,
      sdkRunState: result.serializedState,
      toolName:
        edit === null
          ? "execute_commitment"
          : "update_commitment",
      version: 2,
    };
    return {
      ...(edit === null
        ? {
            approval: {
              proposal: decision,
              target: {
                id: authority.draftId,
                version: authority.draftVersion,
              },
              toolName: "execute_commitment" as const,
            },
          }
        : {
            approval: {
              proposal: edit,
              target: {
                id: edit.commitmentId,
                version: edit.expectedVersion,
              },
              toolName: "update_commitment" as const,
            },
          }),
      outcome: { decision, ok: true },
      pendingApprovalState: JSON.stringify(envelope),
    };
  }
  if (context.workSessionInput !== undefined) {
    const decision = workSessionDecision(context.input);
    if (decision === null) {
      return { outcome: fail("semantic", "input_invalid") };
    }
    return {
      outcome: {
        decision,
        ok: true,
        workSessionInput: context.workSessionInput,
      },
    };
  }
  if (context.continuationInput !== undefined) {
    return {
      outcome: {
        continuationInput: context.continuationInput,
        decision: continuationDecision(),
        ok: true,
      },
    };
  }
  if (context.proposal !== undefined) {
    return {
      execution: context.execution,
      outcome: {
        decision: context.proposal,
        ...(context.initialWorkSessionInput === undefined
          ? {}
          : {
              initialWorkSessionInput:
                context.initialWorkSessionInput,
            }),
        ok: true,
      },
    };
  }
  if (context.editProposal !== undefined) {
    return {
      execution: context.execution,
      outcome: {
        decision: editDecision(context.editProposal),
        ok: true,
      },
    };
  }
  if (context.lastSemanticFailure !== undefined) {
    return {
      outcome: fail("semantic", context.lastSemanticFailure),
    };
  }
  return { outcome: fail("missing_output") };
}

function caughtFailure(
  error: unknown,
  signal: AbortSignal,
): Extract<DecisionOutcome, { ok: false }>["failure"] {
  const name = error instanceof Error ? error.name : "";
  if (
    signal.aborted ||
    name === "AbortError" ||
    name === "TimeoutError"
  ) {
    return "timeout";
  }
  return name === "MaxTurnsExceeded" ? "incomplete" : "provider_error";
}

function caught(
  error: unknown,
  signal: AbortSignal,
  operation: AgentRuntimeFailureEvent["operation"],
  onRuntimeFailure?: (event: AgentRuntimeFailureEvent) => void,
): AgentRuntimeResult {
  const failure = caughtFailure(error, signal);
  try {
    onRuntimeFailure?.({
      event: "agent_runtime_failure",
      failure,
      failureChain: failureChain(error),
      failureFrames: failureFrames(error),
      operation,
    });
  } catch {
    // Operational telemetry must never change the fail-closed outcome.
  }
  return { outcome: fail(failure) };
}

export function createAgentRuntime(
  options: AgentRuntimeOptions,
): AgentRuntime {
  const runner =
    options.runner ?? new OpenAIAgentsRunner(options.apiKey);
  const now = options.now ?? (() => new Date());
  const prompts = options.prompts ?? FALLBACK_AGENT_PROMPTS;

  function prepare(
    input: DecisionInput,
    authority: AgentExecutionAuthority,
    conversation: AgentRuntimeConversationContext | null,
    session?: AgentSdkSession,
    proposal?: DecisionResult,
  ): {
    agent: Agent<RuntimeContext, "text">;
    context: RuntimeContext;
    validationNow: Date;
  } | null {
    const structured = parseDecisionInputStructure(input);
    const validationNow = now();
    if (
      structured === null ||
      !validateDecisionInputSemantics(structured, validationNow)
    ) {
      return null;
    }
    const context: RuntimeContext = {
      authority,
      conversation,
      executionApproved: false,
      input: structured,
      mode: "decision",
      proposal,
    };
    const agent = new Agent<RuntimeContext, "text">({
      instructions: runtimeInstructions(
        structured,
        validationNow,
        conversation,
        prompts,
      ),
      model: options.model,
      modelSettings: {
        store: false,
      },
      name: "Shiori bounded decision",
      tools: buildTools(context, options, validationNow, session),
    });
    return { agent, context, validationNow };
  }

  function prepareCreationContinuation(
    decision: DecisionResult,
    authority: ApprovedAgentExecutionAuthority,
    conversation: AgentRuntimeConversationContext,
    session: AgentSdkSession,
  ): {
    agent: Agent<RuntimeContext, "text">;
    context: RuntimeContext;
  } | null {
    const structured = parseMaterializedDecision(decision);
    if (
      structured === null ||
      !isCompleteProposal(structured) ||
      authority.entityKind === "commitment"
    ) {
      return null;
    }
    const context: RuntimeContext = {
      authority,
      conversation,
      executionApproved: false,
      input: {
        context: {
          fields: {
            commitmentMode: structured.commitmentMode,
            definitionOfDone: structured.definitionOfDone,
            durationMinutes: structured.durationMinutes,
            offerWorkWindowHelp: structured.offerWorkWindowHelp,
            targetAt: structured.targetAt,
            targetTimeZone: structured.targetTimeZone,
            timingConstraints: structured.timingConstraints,
          },
          phase: "complete",
        },
        ownerText: "Continue exact creation approval",
      },
      mode: "decision",
      proposal: structured,
    };
    if (!exactCreationProposal(context)) {
      return null;
    }
    const executionTool = buildTools(
      context,
      options,
      now(),
      session,
    ).find((candidate) => candidate.name === "execute_commitment");
    if (executionTool === undefined) {
      return null;
    }
    const agent = new Agent<RuntimeContext, "text">({
      instructions: executionInstructions(authority, prompts),
      model: options.model,
      modelSettings: { store: false },
      name: "Shiori bounded decision",
      tools: [executionTool],
    });
    return { agent, context };
  }

  function prepareResumeRun(
    envelope: PendingApprovalEnvelope,
    authority: ApprovedAgentExecutionAuthority,
    approval: "approve" | "reject",
  ): {
    agent: Agent<RuntimeContext, "text">;
    context: RuntimeContext;
  } | null {
    if (
      (
        envelope.toolName === "execute_commitment" &&
        (
          envelope.proposal === null ||
          !isCompleteProposal(envelope.proposal) ||
          authority.entityKind === "commitment"
        )
      ) ||
      (
        envelope.toolName === "update_commitment" &&
        (
          envelope.editProposal === null ||
          authority.entityKind !== "commitment" ||
          options.updateCommitment === undefined
        )
      )
    ) {
      return null;
    }
    const context: RuntimeContext = {
      authority,
      conversation: null,
      ...(envelope.editProposal === null
        ? {}
        : { editProposal: envelope.editProposal }),
      executionApproved: approval === "approve",
      input: envelope.input,
      mode: envelope.mode,
      ...(envelope.proposal === null
        ? {}
        : { proposal: envelope.proposal }),
      resumeToolName: envelope.toolName,
    };
    const interruptedTool = buildTools(
      context,
      options,
      now(),
    ).find((candidate) => candidate.name === envelope.toolName);
    if (interruptedTool === undefined) {
      return null;
    }
    const agent = new Agent<RuntimeContext, "text">({
      instructions:
        envelope.toolName === "update_commitment"
          ? editExecutionInstructions(authority, prompts)
          : executionInstructions(authority, prompts),
      model: options.model,
      modelSettings: { store: false },
      name:
        envelope.mode === "execution"
          ? "Shiori approved commitment execution"
          : "Shiori bounded decision",
      tools: [interruptedTool],
    });
    return { agent, context };
  }

  return {
    async continueCreation(request) {
      const authority = approvedAuthority(request.authority);
      if (authority === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const prepared = prepareCreationContinuation(
        request.decision,
        authority,
        request.conversation,
        request.session,
      );
      if (prepared === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const signal = AbortSignal.timeout(AGENT_RUNTIME_TIMEOUT_MS);
      try {
        const result = await runner.run({
          agent: prepared.agent,
          context: prepared.context,
          input: CREATION_CONTINUATION_INPUT,
          maxTurns: AGENT_RUNTIME_MAX_TURNS,
          safety: agentSafety(options.tracingEnabled === true),
          session: request.session,
          signal,
        });
        return resultFromRunner(result, prepared.context);
      } catch (error) {
        return caught(
          error,
          signal,
          "continue_creation",
          options.onRuntimeFailure,
        );
      }
    },

    async run(request) {
      const prepared = prepare(
        request.input,
        request.authority,
        request.conversation,
        request.session,
      );
      if (prepared === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const signal = AbortSignal.timeout(AGENT_RUNTIME_TIMEOUT_MS);
      try {
        const result = await runner.run({
          agent: prepared.agent,
          context: prepared.context,
          input: [{
            content: request.input.ownerText,
            role: "user",
          }],
          maxTurns: AGENT_RUNTIME_MAX_TURNS,
          safety: agentSafety(options.tracingEnabled === true),
          session: request.session,
          signal,
        });
        return resultFromRunner(result, prepared.context);
      } catch (error) {
        return caught(error, signal, "run", options.onRuntimeFailure);
      }
    },

    async resume(request) {
      const envelope = parsePendingEnvelope(
        request.pendingApprovalState,
      );
      if (
        envelope === null ||
        !sameAuthority(envelope.authority, request.authority) ||
        approvedAuthority(request.authority) === null
      ) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const resumed = prepareResumeRun(
        envelope,
        approvedAuthority(request.authority)!,
        request.approval,
      );
      if (resumed === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const signal = AbortSignal.timeout(AGENT_RUNTIME_TIMEOUT_MS);
      try {
        const result = await runner.resume({
          agent: resumed.agent,
          approval: request.approval,
          context: resumed.context,
          maxTurns: AGENT_RUNTIME_MAX_TURNS,
          safety: agentSafety(options.tracingEnabled === true),
          serializedState: envelope.sdkRunState,
          signal,
        });
        return resultFromRunner(result, resumed.context);
      } catch (error) {
        return caught(error, signal, "resume", options.onRuntimeFailure);
      }
    },
  };
}
