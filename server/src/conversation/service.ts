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
  type ConversationTurnFailureRecord,
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
  failureCodes?: boolean;
  onConversationFailure?: (event: ConversationFailureEvent) => void;
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
 * still classified `http` to keep the fail-closed reply identical, so this
 * event is the only way to tell a database outage from a provider outage.
 */
export type ConversationEngineFailureEvent = {
  event: "conversation_engine_threw";
  failureChain: readonly string[];
  failureFrames: readonly string[];
};

/**
 * Every application-side route where the application cannot act on a successful
 * decision.
 *
 * Nine routes were removed when the phase-by-relation dispatch collapsed into a
 * single handler: they existed only to reject decisions that did not fit a cell
 * of the matrix, and there is no matrix left to miss.
 */
export type ConversationFailureSite =
  | "ambiguity_response_missing"
  | "apply_stale"
  | "continuation_reply_missing"
  | "continuation_route_unavailable"
  | "draft_not_created"
  | "draft_ordinary_response_missing"
  | "initial_preparation_incomplete"
  | "no_state_draft_not_draftable"
  | "no_state_relation_invalid"
  | "patched_draft_not_draftable"
  | "permission_draft_not_allowed"
  | "separate_draft_not_draftable"
  | "status_apply_not_applied"
  | "work_session_authority_mismatch"
  | "work_session_reply_missing";

export type ConversationFailureEvent = {
  event: "conversation_failure";
  phase?: ConversationPhase;
  site: ConversationFailureSite;
  snapshotKind: ConversationSnapshot["kind"];
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

/**
 * Re-asks whatever is still outstanding for the preserved snapshot.
 *
 * Every phase already has an application-owned question; a rejected turn simply
 * repeats it.
 */
function recoveryCopy(snapshot: ConversationSnapshot): string {
  switch (snapshot.kind) {
    case "draft":
      return snapshot.phase === "complete"
        ? conversationCopy.recoverComplete
        : collectedDraftCopy(snapshot.phase);
    case "permission":
      return conversationCopy.permissionUnclear;
    case "none":
      return conversationCopy.recoverNoDraft;
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
  // `target_pair_invalid` and `target_timezone_invalid` are omitted:
  // materializeProviderDecision derives targetTimeZone from targetAt, so neither
  // can fire on a materialized decision.
  const targetReason = [
    "target_format_invalid",
    "target_not_future",
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
    targetReason
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
  readonly #onConversationFailure:
    | ((event: ConversationFailureEvent) => void)
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
  readonly #failureCodes: boolean;
  #pendingFailureRecords: Promise<void>[] = [];
  #turnUpdateId = 0;
  readonly #workSessionConversation:
    | ConversationServiceOptions["workSessionConversation"]
    | undefined;

  constructor(options: ConversationServiceOptions) {
    this.#decisionEngine = options.decisionEngine;
    this.#continuationConversation = options.continuationConversation;
    this.#modelId = options.modelId;
    this.#onDecisionFailure = options.onDecisionFailure;
    this.#onDecisionRetryRecovered = options.onDecisionRetryRecovered;
    this.#failureCodes = options.failureCodes ?? false;
    this.#onConversationFailure = options.onConversationFailure;
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
    this.#turnUpdateId = updateId;
    this.#pendingFailureRecords = [];
    try {
      return await this.#handleTurn(updateId, ownerText);
    } finally {
      // Diagnostic writes are started as each failure is reported and settled
      // here, so a turn never returns before its own trace is durable. Each
      // write already swallows its own errors.
      const pending = this.#pendingFailureRecords;
      this.#pendingFailureRecords = [];
      await Promise.all(pending);
    }
  }

  async #handleTurn(
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
      this.#recordTurnFailure({
        attemptCount: outcome.attemptCount,
        ...(snapshot.kind === "draft" ? { phase: snapshot.phase } : {}),
        reason: outcome.reason,
        site: "decision_failure",
        snapshotKind: snapshot.kind,
        source: "decision",
        updateId,
      });
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
        this.#failureCopy(snapshot, `decision_${outcome.reason}`),
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
        this.#ambiguityCopy(outcome.decision, snapshot),
      );
    }

    if (outcome.continuationInput !== undefined) {
      if (
        this.#continuationConversation === undefined ||
        this.#ownerChatId === undefined ||
        snapshot.kind !== "none"
      ) {
        return this.#preserveFailure(
          updateId,
          snapshot,
          "continuation_route_unavailable",
        );
      }
      await this.#repository.recordDecision?.({
        audit: this.#audit(outcome.decision),
        draftReference: null,
        updateId,
      });
      const continuationReply =
        await this.#continuationConversation.handleDurationInput(
          updateId,
          this.#ownerChatId,
          outcome.continuationInput,
        );
      if (continuationReply === null) {
        this.#reportConversationFailure(
          "continuation_reply_missing",
          snapshot,
        );
      }
      const reply =
        continuationReply ?? {
          text: this.#failureCopy(snapshot, "continuation_reply_missing"),
        };
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
          "work_session_authority_mismatch",
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
      const workSessionReply =
        await this.#workSessionConversation.handleConversationInput(
          updateId,
          this.#ownerChatId,
          outcome.workSessionInput,
        );
      if (workSessionReply === null) {
        this.#reportConversationFailure(
          "work_session_reply_missing",
          snapshot,
        );
      }
      const reply =
        workSessionReply ?? {
          text: this.#failureCopy(snapshot, "work_session_reply_missing"),
        };
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
      return this.#preserveFailure(
        updateId,
        snapshot,
        "initial_preparation_incomplete",
      );
    }
    const effectiveDecision = withInitialPreparation(
      outcome.decision,
      outcome.initialWorkSessionInput,
    );
    return this.#applyTurn(
      updateId,
      snapshot,
      effectiveDecision,
      outcome.draftTarget,
      outcome.initialWorkSessionInput,
    );
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
      this.#reportConversationFailure(
        "status_apply_not_applied",
        snapshot,
      );
      return [
        {
          text: this.#failureCopy(snapshot, "status_apply_not_applied"),
        },
      ];
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

  /**
   * One handler for every owner turn.
   *
   * This replaces the phase-by-relation dispatch (`#withoutState`,
   * `#withPermission`, `#withDraft` and their `turnRelation` switches). That
   * shape required the model to land in a legal cell of a five-phase by
   * seven-relation matrix, and anything outside it failed the turn.
   *
   * The application owns the state, so it decides directly. Only two judgements
   * still come from the model, because only it can make them: whether a
   * permission answer was yes or no, and whether the owner started a genuinely
   * separate promise. Everything else follows from what the merge produced.
   */
  async #applyTurn(
    updateId: number,
    snapshot: ConversationSnapshot,
    decision: DecisionResult,
    draftTarget?: DecisionDraftTarget,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    const expected = expectedSnapshot(snapshot);
    const audit = this.#audit(decision);
    const answer = responseText(decision);

    // A question changes nothing, whatever else is open.
    if (decision.inputClass === "ordinary_question") {
      return this.#answerQuestion(updateId, snapshot, decision, answer);
    }

    // An implied intention is never stored without agreement.
    if (
      decision.inputClass === "implied_intention" &&
      snapshot.kind !== "draft"
    ) {
      return snapshot.kind === "permission"
        ? this.#finish(
            {
              action: "rearm_permission",
              audit,
              expected,
              processingResult: "conversation",
              updateId,
            },
            snapshot,
            conversationCopy.permissionCollision,
          )
        : this.#finish(
            {
              action: "create_permission",
              audit,
              expected,
              fields: candidateFields(decision),
              processingResult: "conversation",
              updateId,
            },
            snapshot,
            conversationCopy.impliedPermission,
          );
    }

    // A separate promise while a permission is armed is a collision: the
    // application will not silently answer one request with another.
    if (
      snapshot.kind === "permission" &&
      decision.turnRelation === "separate_request"
    ) {
      return this.#finish(
        {
          action: "rearm_permission",
          audit,
          expected,
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        conversationCopy.permissionCollision,
      );
    }

    if (snapshot.kind === "permission") {
      return this.#acceptPermission(
        updateId,
        snapshot,
        decision,
        initialPreparation,
      );
    }

    // A separate promise starts its own draft rather than overwriting the
    // focused one. This is the model's judgement; the application only acts on it.
    if (
      snapshot.kind === "draft" &&
      decision.turnRelation === "separate_request"
    ) {
      return decision.inputClass === "implied_intention"
        ? this.#finish(
            {
              action: "create_permission",
              audit,
              expected,
              fields: candidateFields(decision),
              processingResult: "conversation",
              updateId,
            },
            snapshot,
            conversationCopy.impliedPermission,
          )
        : this.#createDraft(
            updateId,
            snapshot,
            decision,
            "create_separate_draft",
            "separate_draft_not_draftable",
            initialPreparation,
          );
    }

    if (snapshot.kind === "none") {
      return this.#createDraft(
        updateId,
        snapshot,
        decision,
        "create_draft",
        "no_state_draft_not_draftable",
        initialPreparation,
      );
    }

    return this.#patchDraft(
      updateId,
      snapshot,
      decision,
      draftTarget,
      initialPreparation,
    );
  }

  /** Answers without touching state, and keeps any pending question alive. */
  async #answerQuestion(
    updateId: number,
    snapshot: ConversationSnapshot,
    decision: DecisionResult,
    answer: string | undefined,
  ): Promise<ConversationReply> {
    const audit = this.#audit(decision);
    const expected = expectedSnapshot(snapshot);

    if (snapshot.kind === "permission") {
      if (decision.turnRelation === "permission_declined") {
        return this.#finish(
          {
            action: "terminate_permission",
            audit,
            expected,
            processingResult: "conversation",
            updateId,
          },
          snapshot,
          conversationCopy.decline,
        );
      }
      // Only the model can tell an unclear on-topic reply from an unrelated
      // question, so that judgement is kept. Either way the request stays armed.
      const unclear =
        answer === undefined ||
        decision.turnRelation === "clarification_continuation";
      return this.#finish(
        {
          action: unclear ? "rearm_permission" : "preserve",
          audit,
          expected,
          processingResult: "conversation",
          updateId,
        },
        snapshot,
        unclear ? conversationCopy.permissionUnclear : answer,
      );
    }

    if (answer === undefined) {
      return this.#preserveFailure(
        updateId,
        snapshot,
        snapshot.kind === "draft"
          ? "draft_ordinary_response_missing"
          : "no_state_relation_invalid",
      );
    }
    return this.#finish(
      {
        action: "preserve",
        audit,
        expected,
        processingResult: "conversation",
        updateId,
      },
      snapshot,
      snapshot.kind === "draft"
        ? ordinaryWithDraftCopy(answer)
        : answer,
    );
  }

  /**
   * Promotes an agreed permission candidate into a draft.
   *
   * The application's own parked fields are authoritative, so the model's echo of
   * them is not compared: it merely signalled agreement.
   */
  async #acceptPermission(
    updateId: number,
    snapshot: PermissionCandidate,
    decision: DecisionResult,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    const phase = phaseFor(snapshot.fields);
    const fields =
      phase === "complete" && initialPreparation === undefined
        ? preparationFields(snapshot.fields)
        : initialPreparation === undefined
          ? snapshot.fields
          : candidateFields(decision);
    const draftIsAllowed = draftable(fields) && phase !== undefined;
    if (!draftIsAllowed) {
      this.#reportConversationFailure(
        "permission_draft_not_allowed",
        snapshot,
      );
    }
    return this.#finish(
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
          },
      snapshot,
      draftIsAllowed
        ? collectedReply(phase, fields)
        : this.#failureCopy(snapshot, "permission_draft_not_allowed"),
      draftIsAllowed,
      initialPreparation,
    );
  }

  async #createDraft(
    updateId: number,
    snapshot: ConversationSnapshot,
    decision: DecisionResult,
    action: "create_draft" | "create_separate_draft",
    site: ConversationFailureSite,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    const extracted = candidateFields(decision);
    const fields =
      phaseFor(extracted) === "complete" && initialPreparation === undefined
        ? preparationFields(extracted)
        : extracted;
    const phase = phaseFor(fields);
    if (!draftable(fields) || phase === undefined) {
      return this.#preserveRejected(updateId, snapshot, decision, site);
    }
    return this.#finish(
      {
        action,
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

  async #patchDraft(
    updateId: number,
    snapshot: ActiveDraft,
    decision: DecisionResult,
    draftTarget: DecisionDraftTarget | undefined,
    initialPreparation?: InitialWorkSessionConversationInput,
  ): Promise<ConversationReply> {
    // Without an explicit target the focused draft is the target. Failing the
    // turn for a missing target used to discard an answer the application could
    // place perfectly well.
    const target = draftTarget?.authority ?? {
      expectedVersion: snapshot.version,
      id: snapshot.id,
      kind: "draft" as const,
    };
    const selected: ActiveDraft = {
      expiresAt: snapshot.expiresAt,
      fields: draftTarget?.fields ?? snapshot.fields,
      id: target.id,
      kind: "draft",
      phase: draftTarget?.phase ?? snapshot.phase,
      version: target.expectedVersion,
    };

    const extracted = candidateFields(decision);
    const extractedPhase = phaseFor(extracted);
    const fields =
      selected.phase === "complete" && extractedPhase === "complete"
        ? retainCommitmentMode(extracted, selected.fields)
        : selected.phase !== "complete" &&
            extractedPhase === "complete" &&
            initialPreparation === undefined
          ? preparationFields(extracted)
          : extracted;
    const phase = phaseFor(fields);

    // A correction that empties a core field leaves the promise as it was.
    if (selected.phase === "complete" && phase !== "complete") {
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
          selected.fields,
          selected,
          confirmationCopy.correctionIncomplete,
        ),
      );
    }
    if (!draftable(fields) || phase === undefined) {
      return this.#preserveRejected(
        updateId,
        snapshot,
        decision,
        "patched_draft_not_draftable",
      );
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
        target,
        updateId,
      },
      selected,
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

  #ambiguityCopy(
    decision: DecisionResult,
    snapshot: ConversationSnapshot,
  ): string {
    const answer = responseText(decision);
    if (answer !== undefined) {
      return answer;
    }
    this.#reportConversationFailure(
      "ambiguity_response_missing",
      snapshot,
    );
    return this.#failureCopy(snapshot, "ambiguity_response_missing");
  }

  #reportConversationFailure(
    site: ConversationFailureSite,
    snapshot: ConversationSnapshot,
  ): void {
    const phase = snapshot.kind === "draft" ? snapshot.phase : undefined;
    try {
      this.#onConversationFailure?.({
        event: "conversation_failure",
        ...(phase ? { phase } : {}),
        site,
        snapshotKind: snapshot.kind,
      });
    } catch {
      // Operational logging must never change the fail-closed response.
    }
    this.#recordTurnFailure({
      ...(phase ? { phase } : {}),
      site,
      snapshotKind: snapshot.kind,
      source: "application",
      updateId: this.#turnUpdateId,
    });
  }

  /**
   * Owner-facing failure copy, optionally tagged with its reason code.
   *
   * Ten near-identical failure strings across five subsystems are otherwise
   * indistinguishable in a screenshot. Off by default and temporary: it goes
   * away once failures continue the conversation instead of apologizing.
   */
  /**
   * Forward-moving reply for a turn the application rejected.
   *
   * A rejected turn preserves state and changes nothing, so the owner does not
   * need an apology — they need the pending question again. The application
   * already knows what is outstanding, so it answers from its own authoritative
   * snapshot rather than dead-ending on "I couldn't safely process that".
   *
   * Refusal is reserved for the write boundary; nothing here can save, schedule,
   * or mutate.
   */
  #failureCopy(snapshot: ConversationSnapshot, code: string): string {
    const base = recoveryCopy(snapshot);
    return this.#failureCodes ? `${base} [${code}]` : base;
  }

  #recordTurnFailure(record: ConversationTurnFailureRecord): void {
    const write = this.#repository.recordTurnFailure?.(record);
    if (write !== undefined) {
      this.#pendingFailureRecords.push(write);
    }
  }

  async #preserveFailure(
    updateId: number,
    snapshot: ConversationSnapshot,
    site: ConversationFailureSite,
  ): Promise<ConversationReply> {
    this.#reportConversationFailure(site, snapshot);
    return this.#finish(
      {
        action: "preserve",
        expected: expectedSnapshot(snapshot),
        processingResult: "conversation_failed",
        updateId,
      },
      snapshot,
      this.#failureCopy(snapshot, site),
    );
  }

  async #preserveRejected(
    updateId: number,
    snapshot: ConversationSnapshot,
    decision: DecisionResult,
    site: ConversationFailureSite,
  ): Promise<ConversationReply> {
    this.#reportConversationFailure(site, snapshot);
    return this.#finish(
      {
        action: "preserve",
        audit: this.#audit(decision),
        expected: expectedSnapshot(snapshot),
        processingResult: "conversation",
        updateId,
      },
      snapshot,
      this.#failureCopy(snapshot, site),
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
        this.#reportConversationFailure("apply_stale", snapshot);
        return this.#failureCopy(snapshot, "apply_stale");
      case "applied": {
        if (expectDraft && !result.draftCreated) {
          this.#reportConversationFailure("draft_not_created", snapshot);
          return this.#failureCopy(snapshot, "draft_not_created");
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
