import type {
  DecisionAttemptCount,
  DecisionEngine,
  DecisionOutcome,
  DecisionTurnCompletion,
  DecisionTelemetryReason,
} from "../decision/engine.js";
import type {
  DecisionCandidateFields,
  DecisionContextFields,
  DecisionInput,
  DecisionResult,
} from "../decision/schema.js";
import {
  confirmationCopy,
  confirmationSummary,
  type ConfirmationApprovalPreparation,
  type TelegramReply,
} from "../confirmation.js";
import {
  collectedDraftCopy,
  conversationCopy,
  correctionCopy,
  ordinaryWithDraftCopy,
} from "./copy.js";
import {
  type ActiveDraft,
  type ConversationApplyResult,
  type ConversationCommand,
  type ConversationDraftRepository,
  type ConversationPhase,
  type ConversationRepository,
  type ConversationSnapshot,
  type DecisionAudit,
  type PermissionCandidate,
  type PatchFocusedDraftCommand,
} from "./repository.js";
import {
  isEligibleWorkSessionCandidate,
  workSessionPlanningOffer,
} from "../work-sessions/flow.js";
import type {
  InitialWorkSessionConversationInput,
  WorkSessionConversationInput,
} from "../work-sessions/conversation-input.js";
import type { WorkSessionContinuationConversationInput } from "../work-sessions/continuation.js";
import { failureChain, failureFrames } from "../failure-chain.js";

type ConversationServiceOptions = {
  decisionEngine: DecisionEngine;
  modelId: string;
  onDecisionFailure?: (event: DecisionFailureEvent) => void;
  onDecisionRetryRecovered?: (event: DecisionRetryRecoveredEvent) => void;
  onEngineFailure?: (event: ConversationEngineFailureEvent) => void;
  ownerChatId?: number;
  prepareApproval?: (
    request: ConfirmationApprovalPreparation,
  ) => Promise<boolean>;
  promptVersion: string;
  repository: ConversationRepository &
    Pick<ConversationDraftRepository, "patchFocusedDraft"> &
    Partial<Pick<ConversationDraftRepository, "listDrafts">>;
  statusService?: {
    read(): Promise<readonly TelegramReply[]>;
  };
  workSessionConversation?: {
    handleConversationInput(
      updateId: number,
      chatId: number,
      input: WorkSessionConversationInput,
    ): Promise<TelegramReply | null>;
  };
  continuationConversation?: {
    handleDurationInput(
      updateId: number,
      chatId: number,
      input: WorkSessionContinuationConversationInput,
    ): Promise<TelegramReply | null>;
  };
};

export type DecisionFailureEvent = {
  attemptCount: DecisionAttemptCount;
  event: "decision_failure";
  reason: DecisionTelemetryReason;
};

export type DecisionRetryRecoveredEvent = {
  attemptCount: 2;
  event: "decision_retry_recovered";
  reason: DecisionTelemetryReason;
};

/**
 * Reports the concrete error behind a decision-engine throw. The outcome is
 * still classified `http` to keep the fail-closed reply identical, so this event
 * is the only way to tell a database outage from a provider outage.
 */
export type ConversationEngineFailureEvent = {
  event: "conversation_engine_threw";
  failureChain: readonly string[];
  failureFrames: readonly string[];
};

type CompleteReply = {
  completeFields: DecisionContextFields;
  prefix?: string;
};

type DecisionDraftTarget = NonNullable<
  Extract<DecisionOutcome, { ok: true }>["draftTarget"]
>;

type ConversationReply = string | TelegramReply;
export type ConversationHandleReply =
  | ConversationReply
  | readonly TelegramReply[];

function candidateFields(decision: DecisionResult): DecisionContextFields {
  return {
    definitionOfDone: decision.definitionOfDone,
    durationMinutes: decision.durationMinutes,
    offerWorkWindowHelp: decision.offerWorkWindowHelp,
    possibleWorkSession:
      decision.commitmentMode === "possible_work_session",
    simpleAction: decision.commitmentMode === "simple_action",
    targetAt: decision.targetAt,
    targetTimeZone: decision.targetTimeZone,
    timingConstraints: decision.timingConstraints,
  };
}

function withInitialPreparation(
  decision: DecisionResult,
  input: InitialWorkSessionConversationInput | undefined,
): DecisionResult {
  if (input === undefined) {
    return decision;
  }
  if (!input.preparationRequired) {
    return {
      ...decision,
      commitmentMode: "simple_action",
      durationMinutes: null,
      nextAction: "ready",
      timingConstraints: [],
    };
  }
  return {
    ...decision,
    commitmentMode: "possible_work_session",
    durationMinutes: input.durationMinutes,
    nextAction:
      input.durationMinutes === null ? "ask_duration" : "ready",
    timingConstraints:
      input.timingConstraints === null
        ? []
        : [input.timingConstraints],
  };
}

function preparationFields(
  fields: DecisionContextFields,
): DecisionContextFields {
  return {
    ...fields,
    offerWorkWindowHelp: false,
    possibleWorkSession: true,
    simpleAction: false,
  };
}

function retainCommitmentMode(
  fields: DecisionContextFields,
  authoritative: DecisionContextFields,
): DecisionContextFields {
  return {
    ...fields,
    durationMinutes: authoritative.simpleAction
      ? null
      : fields.durationMinutes,
    offerWorkWindowHelp: false,
    possibleWorkSession: authoritative.possibleWorkSession,
    simpleAction: authoritative.simpleAction,
  };
}

function decisionCandidateFields(
  fields: DecisionContextFields,
): DecisionCandidateFields {
  return {
    commitmentMode: fields.simpleAction
      ? "simple_action"
      : fields.possibleWorkSession
        ? "possible_work_session"
        : "unresolved",
    definitionOfDone: fields.definitionOfDone,
    durationMinutes: fields.durationMinutes,
    offerWorkWindowHelp: fields.offerWorkWindowHelp,
    targetAt: fields.targetAt,
    targetTimeZone: fields.targetTimeZone,
    timingConstraints: fields.timingConstraints,
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
  return fields.simpleAction !== fields.possibleWorkSession
    ? "complete"
    : undefined;
}

function draftable(fields: DecisionContextFields): boolean {
  const phase = phaseFor(fields);
  if (phase === undefined || fields.offerWorkWindowHelp) {
    return false;
  }
  if (phase !== "complete") {
    return (
      !fields.simpleAction &&
      !fields.possibleWorkSession
    );
  }
  return fields.simpleAction
    ? !fields.possibleWorkSession && fields.durationMinutes === null
    : isEligibleWorkSessionCandidate(fields);
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
          fields: decisionCandidateFields(snapshot.fields),
          phase: snapshot.phase,
        },
        ownerText,
      };
    case "permission":
      return {
        context: {
          fields: decisionCandidateFields(snapshot.fields),
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

function targetFailureCopy(
  snapshot: ConversationSnapshot,
  outcome: Extract<DecisionOutcome, { ok: false }>,
): string | undefined {
  if (outcome.failure !== "semantic") {
    return undefined;
  }
  const targetReason = [
    "target_format_invalid",
    "target_not_future",
    "target_pair_invalid",
    "target_timezone_invalid",
  ].includes(outcome.reason);
  if (
    snapshot.kind === "draft" &&
    snapshot.phase === "complete" &&
    outcome.reason === "target_not_future"
  ) {
    return conversationCopy.overdueTarget;
  }
  if (snapshot.kind === "none" && targetReason) {
    return conversationCopy.targetFailureNoDraft;
  }
  if (
    snapshot.kind === "draft" &&
    snapshot.phase === "awaiting_target" &&
    (targetReason || outcome.reason === "clarification_filled_nothing")
  ) {
    return conversationCopy.targetFailureWithDraft;
  }
  return undefined;
}

function responseText(decision: DecisionResult): string | undefined {
  return decision.response.trim() ? decision.response : undefined;
}

function collectedReply(
  phase: ConversationPhase,
  fields: DecisionContextFields,
  prefix?: string,
): string | CompleteReply {
  return phase === "complete"
    ? {
        completeFields: fields,
        ...(prefix ? { prefix } : {}),
      }
    : collectedDraftCopy(phase);
}

function isCompleteReply(
  value: ConversationReply | CompleteReply,
): value is CompleteReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "completeFields" in value
  );
}

export class ConversationService {
  readonly #decisionEngine: DecisionEngine;
  readonly #continuationConversation:
    | ConversationServiceOptions["continuationConversation"]
    | undefined;
  readonly #modelId: string;
  readonly #onDecisionFailure:
    | ((event: DecisionFailureEvent) => void)
    | undefined;
  readonly #onDecisionRetryRecovered:
    | ((event: DecisionRetryRecoveredEvent) => void)
    | undefined;
  readonly #onEngineFailure:
    | ((event: ConversationEngineFailureEvent) => void)
    | undefined;
  readonly #ownerChatId: number | undefined;
  readonly #prepareApproval:
    | ConversationServiceOptions["prepareApproval"]
    | undefined;
  readonly #promptVersion: string;
  readonly #repository: ConversationServiceOptions["repository"];
  readonly #statusService: ConversationServiceOptions["statusService"];
  readonly #workSessionConversation:
    | ConversationServiceOptions["workSessionConversation"]
    | undefined;

  constructor(options: ConversationServiceOptions) {
    this.#decisionEngine = options.decisionEngine;
    this.#continuationConversation = options.continuationConversation;
    this.#modelId = options.modelId;
    this.#onDecisionFailure = options.onDecisionFailure;
    this.#onDecisionRetryRecovered = options.onDecisionRetryRecovered;
    this.#onEngineFailure = options.onEngineFailure;
    this.#ownerChatId = options.ownerChatId;
    this.#prepareApproval = options.prepareApproval;
    this.#promptVersion = options.promptVersion;
    this.#repository = options.repository;
    this.#statusService = options.statusService;
    this.#workSessionConversation = options.workSessionConversation;
  }

  async handle(
    updateId: number,
    ownerText: string,
  ): Promise<ConversationHandleReply> {
    if (ownerText === "/reset") {
      return conversationCopy.reset;
    }
    const read = await this.#repository.readTurn(updateId);
    if (read.kind === "expired") {
      await this.#decisionEngine.completeTurn?.({
        activeDraftId: null,
        assistantText: conversationCopy.expired,
        pendingQuestion: "clear",
        status: "expired",
        updateId,
      });
      return conversationCopy.expired;
    }
    if (read.kind === "interrupted") {
      await this.#decisionEngine.completeTurn?.({
        activeDraftId: read.draftReference?.id ?? null,
        assistantText: conversationCopy.interrupted,
        pendingQuestion: "clear",
        status: read.draftReference ? "active" : "closed",
        updateId,
      });
      return conversationCopy.interrupted;
    }
    if (read.kind === "busy") {
      return conversationCopy.permissionCollision;
    }

    const snapshot: ConversationSnapshot = read;
    if (ownerText.trim() === "/status") {
      return this.#status(updateId, snapshot);
    }
    let outcome: DecisionOutcome;
    try {
      outcome = await this.#decisionEngine.decide(
        decisionInput(ownerText, snapshot),
        { updateId },
      );
    } catch (error) {
      // The synthesized class stays "http" so the fail-closed response is
      // unchanged, but the real cause is reported: a Supabase outage, a session
      // decryption failure, and a provider outage all arrive here.
      this.#reportEngineFailure(error);
      outcome = {
        attemptCount: 0,
        failure: "http",
        ok: false,
        reason: "http",
        stage: "request",
      };
    }

    if (!outcome.ok) {
      try {
        this.#onDecisionFailure?.({
          event: "decision_failure",
          attemptCount: outcome.attemptCount,
          reason: outcome.reason,
        });
      } catch {
        // Operational logging must never change the fail-closed response.
      }
      const targetedCopy = targetFailureCopy(snapshot, outcome);
      if (targetedCopy) {
        return this.#finish(
          {
            action: "preserve",
            expected: expectedSnapshot(snapshot),
            processingResult: "conversation_failed",
            updateId,
          },
          snapshot,
          targetedCopy,
        );
      }
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

    if (outcome.recovery) {
      try {
        this.#onDecisionRetryRecovered?.({
          event: "decision_retry_recovered",
          attemptCount: outcome.recovery.attemptCount,
          reason: outcome.recovery.reason,
        });
      } catch {
        // Operational logging must never change the recovered decision.
      }
    }

    if (outcome.clarification === "ambiguous_reference") {
      return this.#finish(
        {
          action: "preserve",
          audit: this.#audit(outcome.decision),
          expected: expectedSnapshot(snapshot),
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        responseText(outcome.decision) ?? safeFailure(snapshot),
      );
    }

    if (outcome.continuationInput !== undefined) {
      if (
        this.#continuationConversation === undefined ||
        this.#ownerChatId === undefined ||
        snapshot.kind !== "none"
      ) {
        return this.#preserveFailure(updateId, snapshot);
      }
      await this.#repository.recordDecision?.({
        audit: this.#audit(outcome.decision),
        draftReference: null,
        updateId,
      });
      const reply =
        await this.#continuationConversation.handleDurationInput(
          updateId,
          this.#ownerChatId,
          outcome.continuationInput,
        ) ?? { text: conversationCopy.failureNoDraft };
      const expectsOwnerReply =
        (reply.actions?.length ?? 0) > 0 ||
        reply.text.trimEnd().endsWith("?");
      await this.#decisionEngine.completeTurn?.({
        activeDraftId: null,
        assistantText: reply.text,
        pendingQuestion: expectsOwnerReply ? "replace" : "clear",
        status: "active",
        updateId,
      });
      return reply;
    }

    if (outcome.workSessionInput !== undefined) {
      if (
        this.#workSessionConversation === undefined ||
        this.#ownerChatId === undefined ||
        snapshot.kind !== "draft" ||
        snapshot.id !== outcome.workSessionInput.draftId ||
        snapshot.version !== outcome.workSessionInput.draftVersion
      ) {
        return this.#preserveFailure(
          updateId,
          snapshot,
        );
      }
      await this.#repository.recordDecision?.({
        audit: this.#audit(outcome.decision),
        draftReference: {
          id: outcome.workSessionInput.draftId,
          version: outcome.workSessionInput.draftVersion,
        },
        updateId,
      });
      const reply =
        await this.#workSessionConversation.handleConversationInput(
          updateId,
          this.#ownerChatId,
          outcome.workSessionInput,
        ) ?? { text: safeFailure(snapshot) };
      const expectsOwnerReply =
        (reply.actions?.length ?? 0) > 0 ||
        reply.text.trimEnd().endsWith("?");
      await this.#decisionEngine.completeTurn?.({
        activeDraftId: outcome.workSessionInput.draftId,
        assistantText: reply.text,
        pendingQuestion: expectsOwnerReply ? "replace" : "clear",
        status: "active",
        updateId,
      });
      return reply;
    }

    if (outcome.approval) {
      return this.#finish(
        {
          action: "preserve",
          audit: this.#audit(outcome.decision),
          expected: expectedSnapshot(snapshot),
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        outcome.approval.reply,
      );
    }

    if (
      outcome.initialWorkSessionInput !== undefined &&
      (
        outcome.decision.inputClass !== "explicit_commitment" ||
        outcome.decision.definitionOfDone === null ||
        outcome.decision.targetAt === null
      )
    ) {
      return this.#preserveFailure(updateId, snapshot);
    }
    const effectiveDecision = withInitialPreparation(
      outcome.decision,
      outcome.initialWorkSessionInput,
    );
    switch (snapshot.kind) {
      case "none":
        return this.#withoutState(
          updateId,
          snapshot,
          effectiveDecision,
          outcome.initialWorkSessionInput,
        );
      case "permission":
        return this.#withPermission(
          updateId,
          snapshot,
          effectiveDecision,
          outcome.initialWorkSessionInput,
        );
      case "draft":
        return this.#withDraft(
          updateId,
          snapshot,
          effectiveDecision,
          outcome.draftTarget,
          outcome.initialWorkSessionInput,
        );
    }
  }

  async #status(
    updateId: number,
    snapshot: ConversationSnapshot,
  ): Promise<readonly TelegramReply[]> {
    if (this.#statusService === undefined) {
      throw new Error("Status service is unavailable");
    }
    const statuses = await this.#statusService.read();
    const hasUnconfirmedDraft =
      this.#repository.listDrafts === undefined
        ? snapshot.kind === "draft"
        : (await this.#repository.listDrafts({ limit: 1 })).drafts.length > 0;
    const replies =
      statuses.length > 0
        ? statuses
        : [{
            text: hasUnconfirmedDraft
              ? "No active promises. You have an unconfirmed draft in progress."
              : "No active promises.",
          }];
    const result = await this.#repository.applyTurn({
      action: "preserve",
      expected: expectedSnapshot(snapshot),
      processingResult:
        statuses.length > 0 ? "status_listed" : "status_empty",
      updateId,
    });
    if (!result.completed) {
      throw new Error("Conversation update was not completed");
    }
    if (result.status !== "applied") {
      return [{ text: safeFailure(snapshot) }];
    }
    const activeDraftId =
      result.draftReference?.id ??
      (snapshot.kind === "draft" ? snapshot.id : null);
    await this.#decisionEngine.completeTurn?.({
      activeDraftId,
      assistantText: replies.map((reply) => reply.text).join("\n\n"),
      pendingQuestion:
        snapshot.kind === "none" ? "clear" : "preserve",
      status: snapshot.kind === "none" ? "ignored" : "unchanged",
      updateId,
    });
    return replies;
  }

  async #withoutState(
    updateId: number,
    snapshot: Extract<ConversationSnapshot, { kind: "none" }>,
    decision: DecisionResult,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
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

    const extractedFields = candidateFields(decision);
    if (decision.inputClass === "implied_intention") {
      return this.#finish(
        {
          action: "create_permission",
          audit: this.#audit(decision),
          expected: snapshot,
          fields: extractedFields,
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        conversationCopy.impliedPermission,
      );
    }

    const extractedPhase = phaseFor(extractedFields);
    const fields =
      extractedPhase === "complete" &&
        initialPreparation === undefined
        ? preparationFields(extractedFields)
        : extractedFields;
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
      collectedReply(phase, fields),
      false,
      initialPreparation,
    );
  }

  async #withPermission(
    updateId: number,
    snapshot: PermissionCandidate,
    decision: DecisionResult,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    switch (decision.turnRelation) {
      case "permission_accepted": {
        const accepted =
          decision.inputClass === "explicit_commitment" &&
          this.#sameCandidate(snapshot.fields, candidateFields(decision));
        if (!accepted) {
          return this.#preserveFailure(updateId, snapshot);
        }
        const phase = phaseFor(snapshot.fields);
        const fields =
          phase === "complete" &&
            initialPreparation === undefined
            ? preparationFields(snapshot.fields)
            : initialPreparation === undefined
              ? snapshot.fields
              : candidateFields(decision);
        const draftIsAllowed =
          draftable(fields) && phase !== undefined;
        const command: ConversationCommand =
          fields.possibleWorkSession
            ? {
                action: "accept_work_permission",
                audit: this.#audit(decision),
                expected: expectedSnapshot(snapshot),
                fields,
                phase: "complete",
                processingResult: "conversation",
                updateId,
              }
            : {
                action: "accept_permission",
                audit: this.#audit(decision),
                expected: expectedSnapshot(snapshot),
                processingResult: "conversation",
                updateId,
              };
        return this.#finish(
          command,
          snapshot,
          draftIsAllowed
            ? collectedReply(phase, fields)
            : conversationCopy.failureNoDraft,
          draftIsAllowed,
          initialPreparation,
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
            action: "preserve",
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
    draftTarget?: DecisionDraftTarget,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
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
      if (
        !["explicit_commitment", "implied_intention"].includes(
          decision.inputClass,
        ) ||
        draftTarget === undefined ||
        draftTarget.authority.id !== snapshot.id ||
        draftTarget.authority.expectedVersion !== snapshot.version
      ) {
        return this.#preserveFailure(updateId, snapshot);
      }
      const extractedFields = candidateFields(decision);
      if (decision.inputClass === "implied_intention") {
        return this.#finish(
          {
            action: "create_permission",
            audit: this.#audit(decision),
            expected: expectedSnapshot(snapshot),
            fields: extractedFields,
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          conversationCopy.impliedPermission,
        );
      }
      const extractedPhase = phaseFor(extractedFields);
      const fields =
        extractedPhase === "complete" &&
          initialPreparation === undefined
          ? preparationFields(extractedFields)
          : extractedFields;
      const phase = phaseFor(fields);
      if (!draftable(fields) || phase === undefined) {
        return this.#preserveRejected(updateId, snapshot, decision);
      }
      return this.#finish(
        {
          action: "create_separate_draft",
          audit: this.#audit(decision),
          expected: expectedSnapshot(snapshot),
          fields,
          phase,
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        collectedReply(phase, fields),
        false,
        initialPreparation,
      );
    }

    if (
      !["clarification_continuation", "correction"].includes(
        decision.turnRelation,
      ) ||
      decision.inputClass !== "explicit_commitment"
    ) {
      return this.#preserveFailure(updateId, snapshot);
    }

    if (draftTarget === undefined) {
      return this.#preserveFailure(updateId, snapshot);
    }
    const selectedSnapshot: ActiveDraft = {
      expiresAt: snapshot.expiresAt,
      fields: draftTarget.fields,
      id: draftTarget.authority.id,
      kind: "draft",
      phase: draftTarget.phase,
      version: draftTarget.authority.expectedVersion,
    };
    if (
      decision.turnRelation === "clarification_continuation" &&
      selectedSnapshot.phase === "complete"
    ) {
      return this.#preserveFailure(updateId, snapshot);
    }
    const extractedFields = candidateFields(decision);
    const extractedPhase = phaseFor(extractedFields);
    const fields =
      selectedSnapshot.phase === "complete" &&
        extractedPhase === "complete"
        ? retainCommitmentMode(extractedFields, selectedSnapshot.fields)
        : selectedSnapshot.phase !== "complete" &&
            extractedPhase === "complete" &&
            initialPreparation === undefined
        ? preparationFields(extractedFields)
        : extractedFields;
    const phase = phaseFor(fields);
    if (
      selectedSnapshot.phase === "complete" &&
      decision.turnRelation === "correction" &&
      phase !== "complete"
    ) {
      return this.#finish(
        {
          action: "preserve",
          audit: this.#audit(decision),
          expected: expectedSnapshot(snapshot),
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        confirmationSummary(
          selectedSnapshot.fields,
          selectedSnapshot,
          confirmationCopy.correctionIncomplete,
        ),
      );
    }
    if (!draftable(fields) || phase === undefined) {
      return this.#preserveRejected(updateId, snapshot, decision);
    }

    return this.#finishPatch(
      {
        audit: this.#audit(decision),
        expectedFocus: {
          id: snapshot.id,
          kind: "draft",
          version: snapshot.version,
        },
        fields,
        phase,
        processingResult: "conversation",
        target: draftTarget.authority,
        updateId,
      },
      selectedSnapshot,
      decision.turnRelation === "correction"
        ? phase === "complete"
          ? collectedReply(phase, fields, confirmationCopy.updated)
          : correctionCopy(phase)
        : collectedReply(phase, fields),
      initialPreparation,
    );
  }

  #reportEngineFailure(error: unknown): void {
    try {
      this.#onEngineFailure?.({
        event: "conversation_engine_threw",
        failureChain: failureChain(error),
        failureFrames: failureFrames(error),
      });
    } catch {
      // Operational logging must never change the fail-closed response.
    }
  }

  async #preserveFailure(
    updateId: number,
    snapshot: ConversationSnapshot,
  ): Promise<ConversationReply> {
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
  ): Promise<ConversationReply> {
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
    copy: ConversationReply | CompleteReply,
    expectDraft = false,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    const result = await this.#repository.applyTurn(command);
    const preparationReply = await this.#applyInitialPreparation(
      command,
      result,
      snapshot,
      initialPreparation,
    );
    if (preparationReply !== undefined) {
      return preparationReply;
    }
    return this.#finishResult(
      command,
      result,
      snapshot,
      copy,
      expectDraft,
    );
  }

  async #finishPatch(
    command: PatchFocusedDraftCommand,
    snapshot: ActiveDraft,
    copy: ConversationReply | CompleteReply,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    const result = await this.#repository.patchFocusedDraft(command);
    const conversationCommand: ConversationCommand = {
      action: "update_draft",
      audit: command.audit,
      expected: command.expectedFocus,
      fields: command.fields,
      phase: command.phase,
      processingResult: command.processingResult,
      updateId: command.updateId,
    };
    const preparationReply = await this.#applyInitialPreparation(
      conversationCommand,
      result,
      snapshot,
      initialPreparation,
    );
    if (preparationReply !== undefined) {
      return preparationReply;
    }
    return this.#finishResult(
      conversationCommand,
      result,
      snapshot,
      copy,
      false,
    );
  }

  async #applyInitialPreparation(
    command: ConversationCommand,
    result: ConversationApplyResult,
    snapshot: ConversationSnapshot,
    input: InitialWorkSessionConversationInput | undefined,
  ): Promise<ConversationReply | undefined> {
    if (input === undefined || !input.preparationRequired) {
      return undefined;
    }
    if (result.status !== "applied") {
      return undefined;
    }
    if (
      !result.draftReference ||
      this.#ownerChatId === undefined ||
      this.#workSessionConversation === undefined
    ) {
      const reply = { text: confirmationCopy.approvalUnavailable };
      await this.#decisionEngine.completeTurn?.(
        this.#turnCompletion(command, result, snapshot, reply),
      );
      return reply;
    }
    const reply =
      await this.#workSessionConversation.handleConversationInput(
        command.updateId,
        this.#ownerChatId,
        {
          draftId: result.draftReference.id,
          draftVersion: result.draftReference.version,
          ...input,
        },
      ) ?? { text: confirmationCopy.approvalUnavailable };
    await this.#decisionEngine.completeTurn?.(
      this.#turnCompletion(command, result, snapshot, reply),
    );
    return reply;
  }

  async #finishResult(
    command: ConversationCommand,
    result: ConversationApplyResult,
    snapshot: ConversationSnapshot,
    copy: ConversationReply | CompleteReply,
    expectDraft: boolean,
  ): Promise<ConversationReply> {
    const reply = this.#copyForApply(
      command,
      result,
      snapshot,
      copy,
      expectDraft,
    );
    await this.#decisionEngine.completeTurn?.(
      this.#turnCompletion(command, result, snapshot, reply),
    );
    if (
      isCompleteReply(copy) &&
      result.status === "applied" &&
      typeof reply !== "string" &&
      (
        this.#prepareApproval !== undefined ||
        this.#ownerChatId !== undefined
      ) &&
      reply.actions?.some((item) =>
        item.callbackData.startsWith("d:")
      )
    ) {
      if (
        !this.#prepareApproval ||
        this.#ownerChatId === undefined ||
        !result.draftReference
      ) {
        return { text: confirmationCopy.approvalUnavailable };
      }
      let prepared = false;
      try {
        prepared = await this.#prepareApproval({
          chatId: this.#ownerChatId,
          decision: {
            commitmentMode: "simple_action",
            definitionOfDone: copy.completeFields.definitionOfDone,
            durationMinutes: null,
            inputClass: "explicit_commitment",
            missingFields: [],
            nextAction: "ready",
            offerWorkWindowHelp: false,
            response: "",
            targetAt: copy.completeFields.targetAt,
            targetTimeZone: "Asia/Singapore",
            timingConstraints: [],
            turnRelation: "new_request",
          },
          draft: result.draftReference,
          updateId: command.updateId,
        });
      } catch {
        prepared = false;
      }
      if (!prepared) {
        return { text: confirmationCopy.approvalUnavailable };
      }
    }
    return reply;
  }

  #turnCompletion(
    command: ConversationCommand,
    result: ConversationApplyResult,
    snapshot: ConversationSnapshot,
    reply: ConversationReply,
  ): DecisionTurnCompletion {
    const assistantText =
      typeof reply === "string" ? reply : reply.text;
    const expectsOwnerReply =
      typeof reply === "object" &&
        (reply.actions?.length ?? 0) > 0 ||
      assistantText.trimEnd().endsWith("?");
    const pendingQuestion =
      command.action === "preserve" && snapshot.kind !== "none"
        ? "preserve" as const
        : expectsOwnerReply
          ? "replace" as const
          : "clear" as const;
    const activeDraftId =
      result.draftReference?.id ??
      (snapshot.kind === "none" ? null : snapshot.id);
    if (result.status === "expired") {
      return {
        activeDraftId: null,
        assistantText,
        pendingQuestion: "clear",
        status: "expired",
        updateId: command.updateId,
      };
    }
    if (result.status === "interrupted") {
      return {
        activeDraftId: result.draftReference?.id ?? null,
        assistantText,
        pendingQuestion: "clear",
        status: result.draftReference ? "active" : "closed",
        updateId: command.updateId,
      };
    }
    if (result.status !== "applied") {
      return {
        activeDraftId,
        assistantText,
        pendingQuestion: "preserve",
        status: "unchanged",
        updateId: command.updateId,
      };
    }
    if (command.action === "terminate_permission") {
      return {
        activeDraftId: result.draftReference?.id ?? null,
        assistantText,
        pendingQuestion: "clear",
        status: result.draftReference ? "active" : "closed",
        updateId: command.updateId,
      };
    }
    const opensState = [
      "accept_permission",
      "accept_work_permission",
      "create_draft",
      "create_separate_draft",
      "create_permission",
      "rearm_permission",
      "update_draft",
    ].includes(command.action);
    const keepsState = snapshot.kind !== "none";
    return {
      activeDraftId,
      assistantText,
      pendingQuestion,
      status: opensState || keepsState ? "active" : "ignored",
      updateId: command.updateId,
    };
  }

  #copyForApply(
    command: ConversationCommand,
    result: ConversationApplyResult,
    snapshot: ConversationSnapshot,
    copy: ConversationReply | CompleteReply,
    expectDraft: boolean,
  ): ConversationReply {
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
      case "applied": {
        if (expectDraft && !result.draftCreated) {
          return conversationCopy.failureNoDraft;
        }
        if (isCompleteReply(copy)) {
          if (!result.draftReference) {
            throw new Error("Complete draft reference is missing");
          }
          return isEligibleWorkSessionCandidate(copy.completeFields)
            ? workSessionPlanningOffer(
                copy.completeFields,
                result.draftReference,
                copy.prefix,
              )
            : confirmationSummary(
                copy.completeFields,
                result.draftReference,
                copy.prefix,
              );
        }
        return copy;
      }
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
    const {
      commitmentMode,
      inputClass,
      response: _response,
      ...fields
    } = decision;
    return {
      inputClass,
      modelId: this.#modelId,
      payload: {
        ...fields,
        possibleWorkSession:
          commitmentMode === "possible_work_session",
        simpleAction: commitmentMode === "simple_action",
      },
      promptVersion: this.#promptVersion,
    };
  }
}
