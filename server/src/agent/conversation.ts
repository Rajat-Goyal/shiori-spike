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
  AgentSdkSession,
  AgentSessionRepository,
} from "./session.js";

type SessionBackedAgentDecisionEngineOptions = Readonly<{
  chatId: number;
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
): AgentExecutionAuthority {
  const snapshot = session.currentSnapshot();
  return {
    chatId,
    draftId: snapshot.activeDraftId,
    draftVersion: null,
    sessionId: session.sessionId,
    updateId,
  };
}

/**
 * Connects the provider-neutral decision contract to an application-owned
 * Agents SDK session. The SDK persists bounded working history during the
 * model run; this adapter appends only the deterministic application reply and
 * its pending-question/domain focus after the transition completes.
 */
export class SessionBackedAgentDecisionEngine implements DecisionEngine {
  readonly #chatId: number;
  readonly #onContinuityFailure:
    | ((event: AgentSessionContinuityFailureEvent) => void)
    | undefined;
  readonly #pendingTurns = new Map<number, PendingTurn>();
  readonly #repository: AgentSessionRepository;
  readonly #runtime: AgentRuntime;

  constructor(options: SessionBackedAgentDecisionEngineOptions) {
    this.#chatId = options.chatId;
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
    const result = await this.#runtime.run({
      authority: authority(this.#chatId, context.updateId, session),
      input,
      session,
    });
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
