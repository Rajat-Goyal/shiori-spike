import type { DecisionResult } from "../decision/schema.js";
import type { AgentApprovalGate } from "./approval.js";
import type { AgentContextReader } from "./context-reader.js";
import type { AgentRuntime } from "./runtime.js";
import type { AgentSessionRepository } from "./session.js";

export type CreationApprovalPreparation = Readonly<{
  chatId: number;
  decision: DecisionResult;
  draft: Readonly<{ id: string; version: number }>;
  updateId: number;
}>;

type CreationApprovalPreparerOptions = Readonly<{
  contextReader: AgentContextReader;
  gate: Pick<AgentApprovalGate, "stagePaused">;
  runtime: Pick<AgentRuntime, "continueCreation">;
  sessions: AgentSessionRepository;
}>;

/**
 * Continue the active durable conversation until its exact creation tool
 * interruption, then persist only that interruption for a human decision.
 */
export function createCreationApprovalPreparer(
  options: CreationApprovalPreparerOptions,
): (request: CreationApprovalPreparation) => Promise<boolean> {
  return async (request) => {
    const session = await options.sessions.open(request.chatId);
    const snapshot = session.currentSnapshot();
    if (snapshot.activeDraftId !== request.draft.id) {
      return false;
    }
    const product = await options.contextReader.readProductContext({
      chatId: request.chatId,
      focusedEntityId: request.draft.id,
      query: null,
    });
    const result = await options.runtime.continueCreation({
      authority: {
        chatId: request.chatId,
        draftId: request.draft.id,
        draftVersion: request.draft.version,
        sessionId: session.sessionId,
        updateId: request.updateId,
      },
      conversation: {
        draftResolution: {
          authority: {
            expectedVersion: request.draft.version,
            id: request.draft.id,
            kind: "draft",
          },
          kind: "exact",
        },
        interaction: structuredClone(snapshot.interaction),
        olderHistoryAvailable:
          snapshot.itemCount > snapshot.items.length,
        product,
      },
      decision: request.decision,
      session,
    });
    if (
      !result.outcome.ok ||
      result.approval?.toolName !== "execute_commitment" ||
      result.approval.target.id !== request.draft.id ||
      result.approval.target.version !== request.draft.version ||
      result.pendingApprovalState === undefined
    ) {
      return false;
    }
    const staged = await options.gate.stagePaused({
      chatId: request.chatId,
      draft: request.draft,
      pendingApprovalState: result.pendingApprovalState,
      sessionId: session.sessionId,
      toolName: "execute_commitment",
      updateId: request.updateId,
    });
    return staged.kind === "prepared" || staged.kind === "replay";
  };
}
