import type { DecisionEngine, DecisionOutcome } from "../decision/engine.js";
import type {
  DecisionContextFields,
  DecisionInput,
  DecisionResult,
} from "../decision/schema.js";
import {
  collectedDraftCopy,
  collisionCopy,
  conversationCopy,
  correctionCopy,
  ordinaryWithDraftCopy,
} from "./copy.js";
import {
  type ActiveDraft,
  type ConversationApplyResult,
  type ConversationCommand,
  type ConversationPhase,
  type ConversationRepository,
  type ConversationSnapshot,
  type DecisionAudit,
  type PermissionCandidate,
} from "./repository.js";

type ConversationServiceOptions = {
  decisionEngine: DecisionEngine;
  modelId: string;
  promptVersion: string;
  repository: ConversationRepository;
};

function candidateFields(decision: DecisionResult): DecisionContextFields {
  return {
    definitionOfDone: decision.definitionOfDone,
    durationMinutes: decision.durationMinutes,
    offerWorkWindowHelp: decision.offerWorkWindowHelp,
    possibleWorkSession: decision.possibleWorkSession,
    simpleAction: decision.simpleAction,
    targetAt: decision.targetAt,
    targetTimeZone: decision.targetTimeZone,
    timingConstraints: decision.timingConstraints,
  };
}

function phaseFor(
  fields: DecisionContextFields,
): ConversationPhase | undefined {
  if (fields.definitionOfDone === null) {
    return "awaiting_definition";
  }
  if (fields.targetAt === null) {
    return "awaiting_target";
  }
  return fields.simpleAction ? "complete" : undefined;
}

function draftable(fields: DecisionContextFields): boolean {
  return (
    !fields.possibleWorkSession &&
    fields.durationMinutes === null &&
    !fields.offerWorkWindowHelp &&
    phaseFor(fields) !== undefined
  );
}

function expectedSnapshot(snapshot: ConversationSnapshot) {
  switch (snapshot.kind) {
    case "none":
      return snapshot;
    case "draft":
      return {
        id: snapshot.id,
        kind: snapshot.kind,
        version: snapshot.version,
      } as const;
    case "permission":
      return {
        correlatedUpdateId: snapshot.correlatedUpdateId,
        id: snapshot.id,
        kind: snapshot.kind,
        sourceUpdateId: snapshot.sourceUpdateId,
      } as const;
  }
}

function decisionInput(
  ownerText: string,
  snapshot: ConversationSnapshot,
): DecisionInput {
  switch (snapshot.kind) {
    case "none":
      return {
        context: { fields: null, phase: "none" },
        ownerText,
      };
    case "draft":
      return {
        context: {
          fields: snapshot.fields,
          phase: snapshot.phase,
        },
        ownerText,
      };
    case "permission":
      return {
        context: {
          fields: snapshot.fields,
          phase: "awaiting_permission",
        },
        ownerText,
      };
  }
}

function safeFailure(snapshot: ConversationSnapshot): string {
  return snapshot.kind === "draft"
    ? conversationCopy.failureWithDraft
    : conversationCopy.failureNoDraft;
}

function responseText(decision: DecisionResult): string | undefined {
  const response = decision.response?.trim();
  return response ? decision.response! : undefined;
}

export class ConversationService {
  readonly #decisionEngine: DecisionEngine;
  readonly #modelId: string;
  readonly #promptVersion: string;
  readonly #repository: ConversationRepository;

  constructor(options: ConversationServiceOptions) {
    this.#decisionEngine = options.decisionEngine;
    this.#modelId = options.modelId;
    this.#promptVersion = options.promptVersion;
    this.#repository = options.repository;
  }

  async handle(updateId: number, ownerText: string): Promise<string> {
    const read = await this.#repository.readTurn(updateId);
    if (read.kind === "expired") {
      return conversationCopy.expired;
    }
    if (read.kind === "interrupted") {
      return conversationCopy.interrupted;
    }
    if (read.kind === "busy") {
      return conversationCopy.permissionCollision;
    }

    const snapshot: ConversationSnapshot = read;
    let outcome: DecisionOutcome;
    try {
      outcome = await this.#decisionEngine.decide(
        decisionInput(ownerText, snapshot),
      );
    } catch {
      outcome = { failure: "http", ok: false };
    }

    if (!outcome.ok) {
      return this.#finish(
        {
          action: "preserve",
          expected: expectedSnapshot(snapshot),
          processingResult: "conversation_failed",
          updateId,
        },
        snapshot,
        safeFailure(snapshot),
      );
    }

    switch (snapshot.kind) {
      case "none":
        return this.#withoutState(updateId, snapshot, outcome.decision);
      case "permission":
        return this.#withPermission(
          updateId,
          snapshot,
          outcome.decision,
        );
      case "draft":
        return this.#withDraft(updateId, snapshot, outcome.decision);
    }
  }

  async #withoutState(
    updateId: number,
    snapshot: Extract<ConversationSnapshot, { kind: "none" }>,
    decision: DecisionResult,
  ): Promise<string> {
    if (
      decision.turnRelation === "none" &&
      decision.inputClass === "ordinary_question" &&
      responseText(decision)
    ) {
      return this.#finish(
        {
          action: "preserve",
          audit: this.#audit(decision),
          expected: snapshot,
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        responseText(decision)!,
      );
    }

    if (
      decision.turnRelation !== "new_request" ||
      !["explicit_commitment", "implied_intention"].includes(
        decision.inputClass,
      )
    ) {
      return this.#preserveFailure(updateId, snapshot);
    }

    const fields = candidateFields(decision);
    if (decision.inputClass === "implied_intention") {
      return this.#finish(
        {
          action: "create_permission",
          audit: this.#audit(decision),
          expected: snapshot,
          fields,
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        conversationCopy.impliedPermission,
      );
    }

    const phase = phaseFor(fields);
    if (!draftable(fields) || phase === undefined) {
      return this.#preserveRejected(updateId, snapshot, decision);
    }
    return this.#finish(
      {
        action: "create_draft",
        audit: this.#audit(decision),
        expected: snapshot,
        fields,
        phase,
        processingResult: "conversation",
        updateId,
      },
      snapshot,
      collectedDraftCopy(phase),
    );
  }

  async #withPermission(
    updateId: number,
    snapshot: PermissionCandidate,
    decision: DecisionResult,
  ): Promise<string> {
    switch (decision.turnRelation) {
      case "permission_accepted": {
        const accepted =
          decision.inputClass === "explicit_commitment" &&
          this.#sameCandidate(snapshot.fields, candidateFields(decision));
        if (!accepted) {
          return this.#preserveFailure(updateId, snapshot);
        }
        const phase = phaseFor(snapshot.fields);
        const draftIsAllowed =
          draftable(snapshot.fields) && phase !== undefined;
        return this.#finish(
          {
            action: "accept_permission",
            audit: this.#audit(decision),
            expected: expectedSnapshot(snapshot),
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          draftIsAllowed
            ? collectedDraftCopy(phase)
            : conversationCopy.failureNoDraft,
          draftIsAllowed,
        );
      }
      case "permission_declined":
        if (decision.inputClass !== "ordinary_question") {
          return this.#preserveFailure(updateId, snapshot);
        }
        return this.#finish(
          {
            action: "terminate_permission",
            audit: this.#audit(decision),
            expected: expectedSnapshot(snapshot),
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          conversationCopy.decline,
        );
      case "clarification_continuation":
        if (decision.inputClass !== "ordinary_question") {
          return this.#preserveFailure(updateId, snapshot);
        }
        return this.#finish(
          {
            action: "rearm_permission",
            audit: this.#audit(decision),
            expected: expectedSnapshot(snapshot),
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          conversationCopy.permissionUnclear,
        );
      case "none":
        if (
          decision.inputClass !== "ordinary_question" ||
          !responseText(decision)
        ) {
          return this.#preserveFailure(updateId, snapshot);
        }
        return this.#finish(
          {
            action: "terminate_permission",
            audit: this.#audit(decision),
            expected: expectedSnapshot(snapshot),
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          responseText(decision)!,
        );
      case "separate_request":
        return this.#finish(
          {
            action: "rearm_permission",
            audit: this.#audit(decision),
            expected: expectedSnapshot(snapshot),
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          conversationCopy.permissionCollision,
        );
      case "correction":
      case "new_request":
        return this.#preserveFailure(updateId, snapshot);
    }
  }

  async #withDraft(
    updateId: number,
    snapshot: ActiveDraft,
    decision: DecisionResult,
  ): Promise<string> {
    if (decision.turnRelation === "none") {
      if (
        decision.inputClass !== "ordinary_question" ||
        !responseText(decision)
      ) {
        return this.#preserveFailure(updateId, snapshot);
      }
      return this.#finish(
        {
          action: "preserve",
          audit: this.#audit(decision),
          expected: expectedSnapshot(snapshot),
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        ordinaryWithDraftCopy(responseText(decision)!),
      );
    }

    if (decision.turnRelation === "separate_request") {
      return this.#finish(
        {
          action: "preserve",
          audit: this.#audit(decision),
          expected: expectedSnapshot(snapshot),
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        collisionCopy(snapshot.phase),
      );
    }

    if (
      !["clarification_continuation", "correction"].includes(
        decision.turnRelation,
      ) ||
      (decision.turnRelation === "clarification_continuation" &&
        snapshot.phase === "complete") ||
      decision.inputClass !== "explicit_commitment"
    ) {
      return this.#preserveFailure(updateId, snapshot);
    }

    const fields = candidateFields(decision);
    const phase = phaseFor(fields);
    if (!draftable(fields) || phase === undefined) {
      return this.#preserveRejected(updateId, snapshot, decision);
    }

    return this.#finish(
      {
        action: "update_draft",
        audit: this.#audit(decision),
        expected: expectedSnapshot(snapshot),
        fields,
        phase,
        processingResult: "conversation",
        updateId,
      },
      snapshot,
      decision.turnRelation === "correction"
        ? correctionCopy(phase)
        : collectedDraftCopy(phase),
    );
  }

  async #preserveFailure(
    updateId: number,
    snapshot: ConversationSnapshot,
  ): Promise<string> {
    return this.#finish(
      {
        action: "preserve",
        expected: expectedSnapshot(snapshot),
        processingResult: "conversation_failed",
        updateId,
      },
      snapshot,
      safeFailure(snapshot),
    );
  }

  async #preserveRejected(
    updateId: number,
    snapshot: ConversationSnapshot,
    decision: DecisionResult,
  ): Promise<string> {
    return this.#finish(
      {
        action: "preserve",
        audit: this.#audit(decision),
        expected: expectedSnapshot(snapshot),
        processingResult: "conversation",
        updateId,
      },
      snapshot,
      safeFailure(snapshot),
    );
  }

  async #finish(
    command: ConversationCommand,
    snapshot: ConversationSnapshot,
    copy: string,
    expectDraft = false,
  ): Promise<string> {
    const result = await this.#repository.applyTurn(command);
    return this.#copyForApply(result, snapshot, copy, expectDraft);
  }

  #copyForApply(
    result: ConversationApplyResult,
    snapshot: ConversationSnapshot,
    copy: string,
    expectDraft: boolean,
  ): string {
    if (!result.completed) {
      throw new Error("Conversation update was not completed");
    }
    switch (result.status) {
      case "expired":
        return conversationCopy.expired;
      case "interrupted":
        return conversationCopy.interrupted;
      case "stale":
        return safeFailure(snapshot);
      case "applied":
        return expectDraft && !result.draftCreated
          ? conversationCopy.failureNoDraft
          : copy;
    }
  }

  #sameCandidate(
    left: DecisionContextFields,
    right: DecisionContextFields,
  ): boolean {
    return (
      left.definitionOfDone === right.definitionOfDone &&
      left.durationMinutes === right.durationMinutes &&
      left.offerWorkWindowHelp === right.offerWorkWindowHelp &&
      left.possibleWorkSession === right.possibleWorkSession &&
      left.simpleAction === right.simpleAction &&
      left.targetAt === right.targetAt &&
      left.targetTimeZone === right.targetTimeZone &&
      left.timingConstraints.length === right.timingConstraints.length &&
      left.timingConstraints.every(
        (item, index) => item === right.timingConstraints[index],
      )
    );
  }

  #audit(decision: DecisionResult): DecisionAudit {
    const { inputClass, response: _response, ...payload } = decision;
    return {
      inputClass,
      modelId: this.#modelId,
      payload,
      promptVersion: this.#promptVersion,
    };
  }
}
