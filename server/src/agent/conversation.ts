import type {
  DecisionEngine,
  DecisionOutcome,
  DecisionTurnCompletion,
  DecisionTurnContext,
} from "../decision/engine.js";
import type { DecisionInput } from "../decision/schema.js";
import type {
  ConversationDraftAuthority,
  ConversationDraftRepository,
  ConversationDraftResolution,
  ConversationDraftSummary,
} from "../conversation/repository.js";
import type {
  AgentExecutionAuthority,
  AgentRuntime,
} from "./runtime.js";
import type {
  AgentAmbiguityCandidate,
  AgentContextReader,
  AgentProductContext,
} from "./context-reader.js";
import type {
  AgentSdkSession,
  AgentSessionRepository,
} from "./session.js";

type SessionBackedAgentDecisionEngineOptions = Readonly<{
  chatId: number;
  contextReader: AgentContextReader;
  draftRepository: Pick<
    ConversationDraftRepository,
    "resolveDraftReference"
  >;
  onContinuityFailure?: (event: AgentSessionContinuityFailureEvent) => void;
  repository: AgentSessionRepository;
  runtime: AgentRuntime;
}>;

export type AgentSessionContinuityFailureEvent = Readonly<{
  event: "agent_session_continuity_dropped";
  operation: "record_reply";
  reason: "repository_error" | "stale";
}>;

type PendingTurn = Readonly<{
  session: AgentSdkSession;
}>;

function authority(
  chatId: number,
  updateId: number,
  session: AgentSdkSession,
  product: AgentProductContext,
): AgentExecutionAuthority {
  const focusedDraft =
    product.focusedEntity?.kind === "draft"
      ? product.focusedEntity.entity
      : product.drafts.find((draft) => draft.focused) ?? null;
  return {
    chatId,
    draftId: focusedDraft?.id ?? null,
    draftVersion: focusedDraft?.version ?? null,
    sessionId: session.sessionId,
    updateId,
  };
}

function ambiguityQuestion(
  candidates: readonly AgentAmbiguityCandidate[],
): string {
  const labels = candidates
    .map((candidate) => `“${candidate.label}”`)
    .join(", ");
  return `Nothing was changed. Which one did you mean: ${labels}?`;
}

function candidateFields(
  draft: ConversationDraftSummary,
): DecisionInput["context"] {
  return {
    fields: {
      commitmentMode: draft.fields.simpleAction
        ? "simple_action"
        : draft.fields.possibleWorkSession
          ? "possible_work_session"
          : "unresolved",
      definitionOfDone: draft.fields.definitionOfDone,
      durationMinutes: draft.fields.durationMinutes,
      offerWorkWindowHelp: draft.fields.offerWorkWindowHelp,
      targetAt: draft.fields.targetAt,
      targetTimeZone: draft.fields.targetTimeZone,
      timingConstraints: draft.fields.timingConstraints,
    },
    phase: draft.phase,
  };
}

function fallbackDraftTarget(
  input: DecisionInput,
  authorityValue: AgentExecutionAuthority,
): Extract<DecisionOutcome, { ok: true }>["draftTarget"] {
  if (
    input.context.phase === "none" ||
    input.context.phase === "awaiting_permission" ||
    input.context.fields === null ||
    authorityValue.draftId === null ||
    authorityValue.draftVersion === null
  ) {
    return undefined;
  }
  return {
    authority: {
      expectedVersion: authorityValue.draftVersion,
      id: authorityValue.draftId,
      kind: "draft",
    },
    fields: {
      definitionOfDone: input.context.fields.definitionOfDone,
      durationMinutes: input.context.fields.durationMinutes,
      offerWorkWindowHelp: input.context.fields.offerWorkWindowHelp,
      possibleWorkSession:
        input.context.fields.commitmentMode === "possible_work_session",
      simpleAction:
        input.context.fields.commitmentMode === "simple_action",
      targetAt: input.context.fields.targetAt,
      targetTimeZone: input.context.fields.targetTimeZone,
      timingConstraints: input.context.fields.timingConstraints,
    },
    phase: input.context.phase,
  };
}

function draftResolutionContext(
  resolution: ConversationDraftResolution,
) {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" as const };
    case "exact":
      return {
        authority: resolution.authority,
        kind: "exact" as const,
      };
    case "ambiguous":
      return {
        candidates: resolution.candidates.map(
          (candidate) => candidate.authority,
        ),
        kind: "ambiguous" as const,
      };
  }
}

/**
 * Connects the provider-neutral decision contract to an application-owned
 * Agents SDK session. The SDK persists bounded working history during the
 * model run; this adapter appends only the deterministic application reply and
 * its pending-question/domain focus after the transition completes.
 */
export class SessionBackedAgentDecisionEngine implements DecisionEngine {
  readonly #chatId: number;
  readonly #contextReader: AgentContextReader;
  readonly #draftRepository: Pick<
    ConversationDraftRepository,
    "resolveDraftReference"
  >;
  readonly #onContinuityFailure:
    | ((event: AgentSessionContinuityFailureEvent) => void)
    | undefined;
  readonly #pendingTurns = new Map<number, PendingTurn>();
  readonly #repository: AgentSessionRepository;
  readonly #runtime: AgentRuntime;

  constructor(options: SessionBackedAgentDecisionEngineOptions) {
    this.#chatId = options.chatId;
    this.#contextReader = options.contextReader;
    this.#draftRepository = options.draftRepository;
    this.#onContinuityFailure = options.onContinuityFailure;
    this.#repository = options.repository;
    this.#runtime = options.runtime;
  }

  async decide(
    input: DecisionInput,
    context?: DecisionTurnContext,
  ): Promise<DecisionOutcome> {
    if (context === undefined) {
      throw new Error("Agent decision turn context is required");
    }
    const session = await this.#repository.open(this.#chatId);
    this.#pendingTurns.set(context.updateId, { session });
    const snapshot = session.currentSnapshot();
    const resolution =
      await this.#draftRepository.resolveDraftReference(input.ownerText);
    const runtimeInput =
      resolution.kind === "exact"
        ? { ...input, context: candidateFields(resolution.draft) }
        : input;
    const product = await this.#contextReader.readProductContext({
      chatId: this.#chatId,
      focusedEntityId:
        resolution.kind === "exact"
          ? resolution.authority.id
          : snapshot.activeDraftId,
      query: input.ownerText,
    });
    const executionAuthority = authority(
      this.#chatId,
      context.updateId,
      session,
      product,
    );
    const result = await this.#runtime.run({
      authority: executionAuthority,
      conversation: {
        draftResolution: draftResolutionContext(resolution),
        interaction: structuredClone(snapshot.interaction),
        olderHistoryAvailable:
          snapshot.itemCount > snapshot.items.length,
        product,
      },
      input: runtimeInput,
      session,
    });
    const resolutionAmbiguity =
      resolution.kind === "ambiguous"
        ? resolution.candidates.map(({ authority: target, draft }) => ({
            id: target.id,
            kind: "draft" as const,
            label: draft.fields.definitionOfDone ?? "Unnamed draft",
            version: target.expectedVersion,
          }))
        : null;
    const ambiguityCandidates =
      resolutionAmbiguity ?? product.ambiguity?.candidates ?? null;
    if (result.outcome.ok && ambiguityCandidates !== null) {
      return {
        ...result.outcome,
        draftTarget: undefined,
        decision: {
          ...result.outcome.decision,
          inputClass: "ordinary_question",
          response: ambiguityQuestion(ambiguityCandidates),
          turnRelation: "none",
        },
      };
    }
    if (!result.outcome.ok) {
      return result.outcome;
    }
    const draftTarget =
      resolution.kind === "exact"
        ? {
            authority: resolution.authority,
            fields: resolution.draft.fields,
            phase: resolution.draft.phase,
          }
        : fallbackDraftTarget(runtimeInput, executionAuthority);
    return {
      ...result.outcome,
      ...(draftTarget ? { draftTarget } : {}),
    };
  }

  async completeTurn(
    completion: DecisionTurnCompletion,
  ): Promise<void> {
    const pending = this.#pendingTurns.get(completion.updateId);
    this.#pendingTurns.delete(completion.updateId);

    if (pending === undefined) {
      return;
    }
    if (completion.status === "expired") {
      return;
    }
    try {
      const recorded = await pending.session.recordApplicationReply({
        activeDraftId: completion.activeDraftId,
        assistantText: completion.assistantText,
        pendingQuestion: completion.pendingQuestion,
        updateId: completion.updateId,
      });
      if (recorded.kind === "stale") {
        this.#reportContinuityFailure("record_reply", "stale");
      }
    } catch {
      this.#reportContinuityFailure(
        "record_reply",
        "repository_error",
      );
    }
  }

  #reportContinuityFailure(
    operation: AgentSessionContinuityFailureEvent["operation"],
    reason: AgentSessionContinuityFailureEvent["reason"],
  ): void {
    try {
      this.#onContinuityFailure?.({
        event: "agent_session_continuity_dropped",
        operation,
        reason,
      });
    } catch {
      // Operational telemetry must never suppress an already-applied reply.
    }
  }
}
