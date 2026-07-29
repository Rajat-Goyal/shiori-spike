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
  AgentSessionReadResult,
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
  operation: "clear" | "record_turn";
  reason: "repository_error" | "stale";
}>;

type PendingTurn = Readonly<{
  ownerText: string;
  sessionRead: AgentSessionReadResult;
}>;

function expectedSession(read: AgentSessionReadResult) {
  return read.kind === "active"
    ? {
        id: read.session.id,
        kind: "active" as const,
        version: read.session.version,
      }
    : { kind: "none" as const };
}

function authority(
  chatId: number,
  updateId: number,
  read: AgentSessionReadResult,
): AgentExecutionAuthority {
  return {
    chatId,
    draftId:
      read.kind === "active" ? read.session.activeDraftId : null,
    draftVersion: null,
    sessionId: read.kind === "active" ? read.session.id : null,
    updateId,
  };
}

/**
 * Adds bounded, application-owned continuity to the provider-neutral decision
 * contract. The runtime never owns persistence: this adapter reads recent
 * turns before a run and records only the final application reply after the
 * deterministic conversation transition completes.
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
    const sessionRead = await this.#repository.read(this.#chatId);
    this.#pendingTurns.set(context.updateId, {
      ownerText: input.ownerText,
      sessionRead,
    });
    const result = await this.#runtime.run({
      authority: authority(this.#chatId, context.updateId, sessionRead),
      input,
      recentTurns:
        sessionRead.kind === "active" ? sessionRead.session.turns : [],
    });
    return result.outcome;
  }

  async completeTurn(
    completion: DecisionTurnCompletion,
  ): Promise<void> {
    const pending = this.#pendingTurns.get(completion.updateId);
    this.#pendingTurns.delete(completion.updateId);

    if (completion.status === "expired") {
      if (pending?.sessionRead.kind === "active") {
        await this.#clearSession(
          pending.sessionRead.session.id,
          "expired",
          completion.updateId,
        );
      }
      return;
    }
    if (pending === undefined) {
      return;
    }
    if (completion.status === "closed") {
      if (pending.sessionRead.kind === "active") {
        await this.#clearSession(
          pending.sessionRead.session.id,
          "cancelled",
          completion.updateId,
        );
      }
      return;
    }
    if (completion.status !== "active") {
      return;
    }
    try {
      const recorded = await this.#repository.recordTurn({
        activeDraftId: completion.activeDraftId,
        assistantText: completion.assistantText,
        chatId: this.#chatId,
        expected: expectedSession(pending.sessionRead),
        ownerText: pending.ownerText,
        updateId: completion.updateId,
      });
      if (recorded.kind === "stale") {
        this.#reportContinuityFailure("record_turn", "stale");
      }
    } catch {
      this.#reportContinuityFailure("record_turn", "repository_error");
    }
  }

  async #clearSession(
    expectedSessionId: string,
    reason: "cancelled" | "expired",
    updateId: number,
  ): Promise<void> {
    try {
      await this.#repository.clear({
        chatId: this.#chatId,
        expectedSessionId,
        reason,
        updateId,
      });
    } catch {
      this.#reportContinuityFailure("clear", "repository_error");
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
