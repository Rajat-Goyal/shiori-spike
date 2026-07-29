import type {
  DecisionEngine,
  DecisionOutcome,
  DecisionTurnCompletion,
  DecisionTurnContext,
} from "../decision/engine.js";
import type { DecisionInput } from "../decision/schema.js";
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
  return `Which one did you mean: ${labels}? Nothing was changed.`;
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
  readonly #onContinuityFailure:
    | ((event: AgentSessionContinuityFailureEvent) => void)
    | undefined;
  readonly #pendingTurns = new Map<number, PendingTurn>();
  readonly #repository: AgentSessionRepository;
  readonly #runtime: AgentRuntime;

  constructor(options: SessionBackedAgentDecisionEngineOptions) {
    this.#chatId = options.chatId;
    this.#contextReader = options.contextReader;
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
    const product = await this.#contextReader.readProductContext({
      chatId: this.#chatId,
      focusedEntityId: snapshot.activeDraftId,
      query: input.ownerText,
    });
    const result = await this.#runtime.run({
      authority: authority(
        this.#chatId,
        context.updateId,
        session,
        product,
      ),
      conversation: {
        interaction: structuredClone(snapshot.interaction),
        olderHistoryAvailable:
          snapshot.itemCount > snapshot.items.length,
        product,
      },
      input,
      session,
    });
    if (result.outcome.ok && product.ambiguity !== null) {
      return {
        ...result.outcome,
        decision: {
          ...result.outcome.decision,
          inputClass: "ordinary_question",
          response: ambiguityQuestion(product.ambiguity.candidates),
          turnRelation: "none",
        },
      };
    }
    return result.outcome;
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
        pendingQuestion: completion.status === "active",
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
