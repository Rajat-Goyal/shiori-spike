import {
  Agent,
  OpenAIProvider,
  RunContext,
  Runner,
  RunState,
  tool,
  type AgentInputItem,
  type FunctionTool,
} from "@openai/agents";
import { z } from "zod";

import type { TelegramReply } from "../confirmation.js";
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

export const AGENT_RUNTIME_MAX_TURNS = 4;
export const AGENT_RUNTIME_TIMEOUT_MS = 30_000;
export const AGENT_RUNTIME_TOOL_NAMES = [
  "read_context",
  "read_history",
  "list_commitments",
  "propose_draft_update",
  "request_sanitized_availability",
  "execute_commitment",
] as const;

const EXECUTION_RUN_INPUT: readonly AgentInputItem[] = [
  {
    content:
      "Continue the application-owned approval workflow using only the bound execution tool.",
    role: "system",
  },
];

export type AgentRuntimeToolName =
  (typeof AGENT_RUNTIME_TOOL_NAMES)[number];

export type AgentExecutionAuthority = Readonly<{
  chatId: number;
  draftId: string | null;
  draftVersion: number | null;
  sessionId: string | null;
  updateId: number | null;
}>;

export type ApprovedAgentExecutionAuthority = Readonly<{
  chatId: number;
  draftId: string;
  draftVersion: number;
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

export type AgentRuntimePrepareExecutionRequest = Readonly<{
  authority: ApprovedAgentExecutionAuthority;
  decision: DecisionResult;
}>;

export type AgentRuntimeResumeRequest = Readonly<{
  approval: "approve" | "reject";
  authority: AgentExecutionAuthority;
  pendingApprovalState: string;
}>;

type RuntimeContext = {
  authority: AgentExecutionAuthority;
  conversation: AgentRuntimeConversationContext | null;
  executionApproved: boolean;
  execution?: AgentCommitmentExecutionResult;
  input: DecisionInput | null;
  lastSemanticFailure?: DecisionTelemetryReason;
  mode: "decision" | "execution";
  proposal?: DecisionResult;
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
  modelStore: false;
  traceIncludeSensitiveData: false;
  tracingDisabled: true;
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
  runner?: AgentRunner;
}>;

export interface AgentRuntime {
  prepareExecution(
    request: AgentRuntimePrepareExecutionRequest,
  ): Promise<AgentRuntimeResult>;
  resume(request: AgentRuntimeResumeRequest): Promise<AgentRuntimeResult>;
  run(request: AgentRuntimeRunRequest): Promise<AgentRuntimeResult>;
}

type PendingApprovalEnvelope = Readonly<{
  authority: BoundAgentExecutionAuthority;
  input: DecisionInput | null;
  mode: "decision" | "execution";
  proposal: DecisionResult;
  sdkRunState: string;
  toolName: "execute_commitment";
  version: 1;
}>;

const proposalSchema = z
  .object({
    commitmentMode: z.enum([
      "unresolved",
      "simple_action",
      "possible_work_session",
    ]),
    definitionOfDone: z.string().min(1).max(500).nullable(),
    durationMinutes: z.union([
      z.literal(30),
      z.literal(60),
      z.literal(90),
      z.literal(120),
    ]).nullable(),
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

function sameAuthority(
  left: BoundAgentExecutionAuthority,
  right: AgentExecutionAuthority,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.draftId === right.draftId &&
    left.draftVersion === right.draftVersion &&
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
    record.version !== 1 ||
    record.toolName !== "execute_commitment" ||
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
    sessionId: String(authorityRecord.sessionId ?? ""),
  };
  const input =
    record.input === null
      ? null
      : parseDecisionInputStructure(record.input);
  const proposal = parseMaterializedDecision(record.proposal);
  if (
    !Number.isSafeInteger(normalizedAuthority.chatId) ||
    normalizedAuthority.chatId === 0 ||
    normalizedAuthority.draftId.length === 0 ||
    !Number.isSafeInteger(normalizedAuthority.draftVersion) ||
    normalizedAuthority.draftVersion <= 0 ||
    normalizedAuthority.sessionId.length === 0 ||
    !["decision", "execution"].includes(String(record.mode)) ||
    (record.mode === "decision" && input === null) ||
    proposal === null ||
    !isCompleteProposal(proposal)
  ) {
    return null;
  }
  return {
    authority: normalizedAuthority,
    input,
    mode: record.mode as "decision" | "execution",
    proposal,
    sdkRunState: record.sdkRunState,
    toolName: "execute_commitment",
    version: 1,
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
  return context.authority.draftId !== null &&
    context.authority.draftVersion !== null
    ? {
        expectedVersion: context.authority.draftVersion,
        id: context.authority.draftId,
        kind: "draft",
      }
    : null;
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
): string {
  const referenceTimestamp = singaporeReferenceTimestamp(now);
  return [
    "You are Shiori's single conversational agent for every typed Telegram message.",
    "You have no direct database, callback, authentication, or provider access.",
    `The current application-owned decision input is ${JSON.stringify(input)}.`,
    `The authoritative bounded conversation context is ${JSON.stringify(conversation)}.`,
    `The one immutable decision reference timestamp is ${referenceTimestamp}; its offset and decision timezone are Asia/Singapore (+08:00).`,
    "Resolve every relative or partial date only against that immutable Singapore reference timestamp.",
    "Tomorrow means the next Singapore calendar day.",
    "When the owner omits a year, use the reference timestamp's Singapore calendar year only when the resulting instant is strictly in the future.",
    "Never roll an explicitly or presumptively past date or time into a later day or year.",
    "Use read_context for the exact pending application question, sanitized callback choice, focused entity, drafts, commitments, work sessions, and outcomes.",
    "The pending question and callback choice are separate facts: interpret a choice only as an answer to the supplied pending question.",
    "Use read_history with its opaque cursor only when the bounded recent session is insufficient.",
    "Use list_commitments for a bounded view of authoritative commitments.",
    "Maintain the exact focused entity for a continuation or an ordinary question.",
    "A clearly separate promise must use turnRelation separate_request; never overwrite the current draft.",
    "If more than one entity plausibly matches a reference, ask which one the owner means and propose no mutation.",
    "Every clarification_continuation, correction, or separate_request proposal must copy the exact draft target kind, id, and expectedVersion from authoritative context; all non-draft-mutation proposals must use target null.",
    "Every decision that may affect application state, including ordinary-question responses, must be submitted through propose_draft_update.",
    "Only a structurally and semantically accepted proposal can be returned by the application; final prose is never authoritative.",
    "request_sanitized_availability returns free/busy intervals only.",
    "execute_commitment is exclusively for an exact application-owned draft id and version and always requires explicit human approval.",
    "Never claim that a draft was saved, confirmed, scheduled, or executed unless the corresponding tool reports success.",
  ].join(" ");
}

function executionInstructions(
  authority: ApprovedAgentExecutionAuthority,
): string {
  return [
    "This is an application-initiated confirmation execution run, not a new owner conversation turn.",
    "The application has already structurally and semantically validated the complete commitment decision.",
    `Request execute_commitment exactly once with draftId ${JSON.stringify(authority.draftId)} and draftVersion ${authority.draftVersion}.`,
    "Do not reinterpret, summarize, correct, or reclassify the decision.",
    "The application, not model prose, owns the final Telegram reply.",
  ].join(" ");
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
      const mutatesDraft = [
        "clarification_continuation",
        "correction",
        "separate_request",
      ].includes(proposal.turnRelation);
      const expectedTarget = expectedDraftAuthority(context);
      if (
        mutatesDraft &&
        (
          target === null ||
          expectedTarget === null ||
          target.kind !== expectedTarget.kind ||
          target.id !== expectedTarget.id ||
          target.expectedVersion !== expectedTarget.expectedVersion
        )
      ) {
        context.lastSemanticFailure = "input_invalid";
        return { accepted: false, reason: "input_invalid" };
      }
      if (!mutatesDraft && target !== null) {
        context.lastSemanticFailure = "input_invalid";
        return { accepted: false, reason: "input_invalid" };
      }
      context.proposal = proposal;
      context.proposalTarget = target;
      context.lastSemanticFailure = undefined;
      return { accepted: true, decision: proposal };
    },
  });
  const requestAvailability = tool({
    description:
      "Request sanitized free/busy intervals. Calendar titles, descriptions, attendees, locations, and event identifiers are unavailable.",
    name: "request_sanitized_availability",
    parameters: availabilitySchema,
    strict: true,
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
    isEnabled: approvedAuthority(context.authority) !== null,
    parameters: executionSchema,
    strict: true,
    execute: async ({ draftId, draftVersion }) => {
      const authority = approvedAuthority(context.authority);
      if (
        !context.executionApproved ||
        authority === null ||
        draftId !== context.authority.draftId ||
        draftVersion !== context.authority.draftVersion ||
        !isCompleteProposal(context.proposal)
      ) {
        throw new Error("execution_authority_mismatch");
      }
      const result = await options.executeCommitment(
        authority,
        context.proposal,
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
    requestAvailability,
    executeCommitment,
  ] as FunctionTool<RuntimeContext, never, unknown>[];
}

class OpenAIAgentsRunner implements AgentRunner {
  readonly #provider: OpenAIProvider;

  constructor(apiKey: string) {
    this.#provider = new OpenAIProvider({
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
    return {
      finalOutput: result.finalOutput,
      interruptions: result.interruptions.map((item) => ({
        arguments: item.arguments,
        toolName: item.name,
      })),
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
      (item) => item.name === "execute_commitment",
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

function resultFromRunner(
  result: AgentRunnerResult,
  context: RuntimeContext,
): AgentRuntimeResult {
  if (result.interruptions.length > 0) {
    const authority = approvedAuthority(context.authority);
    if (
      authority === null ||
      result.interruptions.length !== 1 ||
      !executionArgumentsMatch(
        result.interruptions[0],
        authority,
      ) ||
      !isCompleteProposal(context.proposal)
    ) {
      return { outcome: fail("semantic", "input_invalid") };
    }
    const envelope: PendingApprovalEnvelope = {
      authority: {
        chatId: authority.chatId,
        draftId: authority.draftId,
        draftVersion: authority.draftVersion,
        sessionId: authority.sessionId,
      },
      input: context.input,
      mode: context.mode,
      proposal: context.proposal,
      sdkRunState: result.serializedState,
      toolName: "execute_commitment",
      version: 1,
    };
    return {
      outcome: { decision: context.proposal, ok: true },
      pendingApprovalState: JSON.stringify(envelope),
    };
  }
  if (context.proposal !== undefined) {
    return {
      execution: context.execution,
      outcome: { decision: context.proposal, ok: true },
    };
  }
  if (context.lastSemanticFailure !== undefined) {
    return {
      outcome: fail("semantic", context.lastSemanticFailure),
    };
  }
  return { outcome: fail("missing_output") };
}

function caught(error: unknown, signal: AbortSignal): AgentRuntimeResult {
  const name = error instanceof Error ? error.name : "";
  if (
    signal.aborted ||
    name === "AbortError" ||
    name === "TimeoutError"
  ) {
    return { outcome: fail("timeout") };
  }
  if (name === "MaxTurnsExceeded") {
    return { outcome: fail("incomplete") };
  }
  return { outcome: fail("provider_error") };
}

export function createAgentRuntime(
  options: AgentRuntimeOptions,
): AgentRuntime {
  const runner =
    options.runner ?? new OpenAIAgentsRunner(options.apiKey);
  const now = options.now ?? (() => new Date());

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

  function prepareExecutionRun(
    decision: DecisionResult,
    authority: ApprovedAgentExecutionAuthority,
  ): {
    agent: Agent<RuntimeContext, "text">;
    context: RuntimeContext;
  } | null {
    const structured = parseMaterializedDecision(decision);
    if (structured === null || !isCompleteProposal(structured)) {
      return null;
    }
    const context: RuntimeContext = {
      authority,
      conversation: null,
      executionApproved: false,
      input: null,
      mode: "execution",
      proposal: structured,
    };
    const executionTool = buildTools(
      context,
      options,
      now(),
    ).find((candidate) => candidate.name === "execute_commitment");
    if (executionTool === undefined) {
      return null;
    }
    const agent = new Agent<RuntimeContext, "text">({
      instructions: executionInstructions(authority),
      model: options.model,
      modelSettings: { store: false },
      name: "Shiori approved commitment execution",
      tools: [executionTool],
    });
    return { agent, context };
  }

  return {
    async prepareExecution(request) {
      const authority = approvedAuthority(request.authority);
      if (authority === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const prepared = prepareExecutionRun(
        request.decision,
        authority,
      );
      if (prepared === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      const signal = AbortSignal.timeout(AGENT_RUNTIME_TIMEOUT_MS);
      try {
        const result = await runner.run({
          agent: prepared.agent,
          context: prepared.context,
          input: EXECUTION_RUN_INPUT,
          maxTurns: AGENT_RUNTIME_MAX_TURNS,
          safety: {
            modelStore: false,
            traceIncludeSensitiveData: false,
            tracingDisabled: true,
          },
          signal,
        });
        return resultFromRunner(result, prepared.context);
      } catch (error) {
        return caught(error, signal);
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
          safety: {
            modelStore: false,
            traceIncludeSensitiveData: false,
            tracingDisabled: true,
          },
          session: request.session,
          signal,
        });
        return resultFromRunner(result, prepared.context);
      } catch (error) {
        return caught(error, signal);
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
      const resumed =
        envelope.mode === "execution"
          ? prepareExecutionRun(
              envelope.proposal,
              approvedAuthority(request.authority)!,
            )
          : envelope.input === null
            ? null
            : prepare(
                envelope.input,
                request.authority,
                null,
                undefined,
                envelope.proposal,
              );
      if (resumed === null) {
        return { outcome: fail("semantic", "input_invalid") };
      }
      resumed.context.executionApproved =
        request.approval === "approve";
      const signal = AbortSignal.timeout(AGENT_RUNTIME_TIMEOUT_MS);
      try {
        const result = await runner.resume({
          agent: resumed.agent,
          approval: request.approval,
          context: resumed.context,
          maxTurns: AGENT_RUNTIME_MAX_TURNS,
          safety: {
            modelStore: false,
            traceIncludeSensitiveData: false,
            tracingDisabled: true,
          },
          serializedState: envelope.sdkRunState,
          signal,
        });
        return resultFromRunner(result, resumed.context);
      } catch (error) {
        return caught(error, signal);
      }
    },
  };
}
