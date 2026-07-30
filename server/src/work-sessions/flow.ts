import type {
  DecisionContextFields,
  DecisionResult,
} from "../decision/schema.js";
import {
  confirmationSummary,
  formatSingaporeTarget,
  type DraftReference,
  type TelegramReply,
} from "../confirmation.js";
import type {
  CalendarAvailabilityRequest,
  CalendarAvailabilityResult,
} from "./availability-integration.js";
import {
  normalizeTimingConstraints,
  TIMING_CONSTRAINT_FORMAT_HELP,
} from "./availability-integration.js";
import type { WorkWindow } from "../scheduling/availability.js";
import type { WorkSessionConversationInput } from "./conversation-input.js";
import {
  isSingaporeWorkSessionStart,
  isWorkSessionDuration,
} from "./duration.js";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTION_PATTERN = new RegExp(
  `^w:(${UUID_PATTERN}):([1-9][0-9]*):([a-z0-9_]+)$`,
);
const SUPPORTED_DURATIONS = [30, 60, 90, 120] as const;

export type WorkSessionFlowAction =
  | "cancel"
  | "check_again"
  | "confirm"
  | "duration_30"
  | "duration_60"
  | "duration_90"
  | "duration_120"
  | "help"
  | "keep"
  | "no_preparation"
  | "option_1"
  | "option_2"
  | "owner_time"
  | "reconnect"
  | "save_unverified";

export type WorkSessionFlowStage =
  | "availability_unavailable"
  | "awaiting_constraints"
  | "awaiting_duration_help"
  | "awaiting_duration_owner"
  | "awaiting_owner_time"
  | "choosing"
  | "commit_pending"
  | "confirming"
  | "conflict_choice"
  | "conflict_confirming"
  | "offer_help"
  | "unverified_confirming";

export type WorkSessionDraftSnapshot = Readonly<{
  calendarAttemptedAt: string | null;
  calendarCheckedAt: string | null;
  conflictConsent: boolean;
  definitionOfDone: string;
  durationMinutes: number | null;
  finalObservation: "conflict" | "free" | "unavailable" | null;
  id: string;
  options: readonly WorkWindow[];
  selectedWindow: WorkWindow | null;
  stage: WorkSessionFlowStage;
  targetAt: string;
  timingConstraints: string | null;
  version: number;
}>;

export type WorkSessionFlowTransition = Readonly<{
  calendarAttemptedAt?: string | null;
  calendarCheckedAt?: string | null;
  chatId: number;
  conflictConsent?: boolean;
  durationMinutes?: number;
  expectedStage: WorkSessionFlowStage;
  finalObservation?: "conflict" | "free" | "unavailable" | null;
  nextStage: WorkSessionFlowStage;
  options?: readonly WorkWindow[];
  reference: DraftReference;
  selectedWindow?: WorkWindow | null;
  timingConstraints?: string;
  updateId: number;
}>;

export type WorkSessionFlowTransitionResult =
  | Readonly<{ kind: "expired" | "replay" | "stale" }>
  | Readonly<{
      kind: "applied";
      snapshot: WorkSessionDraftSnapshot;
    }>;

export type PreparationDeclineResult =
  | Readonly<{ kind: "expired" | "replay" | "stale" }>
  | Readonly<{
      draft: Readonly<{
        definitionOfDone: string;
        id: string;
        targetAt: string;
        version: number;
      }>;
      kind: "applied";
    }>;

export interface WorkSessionFlowRepository {
  cancel(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    expectedStage: WorkSessionFlowStage,
  ): Promise<WorkSessionFlowTransitionResult>;
  declinePreparation(
    updateId: number,
    chatId: number,
    reference: DraftReference,
  ): Promise<PreparationDeclineResult>;
  declinePreparationFromConversation?(
    updateId: number,
    chatId: number,
    reference: DraftReference,
  ): Promise<PreparationDeclineResult>;
  finalizeConversation(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    result: "domain_error" | "expired" | "invalid" | "stale",
  ): Promise<Readonly<{ kind: "applied" | "replay" }>>;
  read(reference: DraftReference): Promise<
    | Readonly<{ kind: "expired" | "missing" | "stale" }>
    | Readonly<{ kind: "current"; snapshot: WorkSessionDraftSnapshot }>
  >;
  transition(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult>;
  transitionFromConversation?(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult>;
}

export type WorkSessionCommitRequest = Readonly<{
  action: "confirm" | "save_unverified";
  calendar: Readonly<{
    attemptedAt: string;
    checkedAt: string | null;
    conflictConsent: boolean;
    finalObservation: "conflict" | "free" | "unavailable";
    status: "conflict_kept" | "free" | "unverified";
  }>;
  chatId: number;
  definitionOfDone: string;
  draft: DraftReference;
  durationMinutes: number;
  expectedStage:
    | "confirming"
    | "conflict_confirming"
    | "unverified_confirming";
  selectedWindow: WorkWindow;
  targetAt: string;
  timingConstraints: string;
  updateId: number;
}>;

export type WorkSessionCommitResult = Readonly<{
  kind: "applied" | "replay" | "resolved" | "stale";
}>;

export interface WorkSessionCommitter {
  commit(request: WorkSessionCommitRequest): Promise<WorkSessionCommitResult>;
}

export type WorkSessionAvailabilityChecker = (
  request: CalendarAvailabilityRequest,
) => Promise<CalendarAvailabilityResult>;

export type WorkSessionApprovalPreparation = Readonly<{
  chatId: number;
  decision: DecisionResult;
  draft: DraftReference;
  updateId: number;
}>;

type WorkSessionFlowOptions = Readonly<{
  availability: WorkSessionAvailabilityChecker;
  committer: WorkSessionCommitter;
  now?: () => Date;
  prepareApproval?: (
    request: WorkSessionApprovalPreparation,
  ) => Promise<boolean>;
  repository: WorkSessionFlowRepository;
}>;

type ParsedAction = DraftReference & {
  action: WorkSessionFlowAction;
};

const workSessionActions = new Set<WorkSessionFlowAction>([
  "cancel",
  "check_again",
  "confirm",
  "duration_30",
  "duration_60",
  "duration_90",
  "duration_120",
  "help",
  "keep",
  "no_preparation",
  "option_1",
  "option_2",
  "owner_time",
  "reconnect",
  "save_unverified",
]);

export const workSessionFlowCopy = {
  cancelled: "Draft cancelled. Nothing was saved.",
  chooseOwnerTime:
    "What exact Singapore-time start should I check? Use a 30-minute boundary.",
  constraints:
    `When can you work?\n\n${TIMING_CONSTRAINT_FORMAT_HELP}`,
  duration: "How much focused time do you need?",
  expired:
    "That draft expired after 24 hours of inactivity. Nothing was saved. Please send the promise again to start over.",
  invalidAction: "That action isn’t valid. I didn’t change anything.",
  invalidOwnerTime:
    "Use an exact future Singapore time on a 30-minute boundary. I didn’t change the draft.",
  noFit:
    "I couldn’t find a fitting window without relaxing your constraints. Choose an exact time or change the constraints.",
  offer:
    "Do you need preparation time for this promise? Nothing has been saved yet.",
  // Deliberately worded differently from confirmationCopy.approvalUnavailable.
  // The two were byte-identical, so an owner screenshot could not tell the
  // work-session flow apart from draft confirmation.
  approvalUnavailable:
    "I couldn’t safely prepare this preparation step. Nothing was saved. Send another message to continue this draft.",
  reconnect:
    "Reconnect Google Calendar from the protected dashboard, then press Check again.",
  replay: "",
  stale: "That action is stale. I didn’t change anything.",
} as const;

function isUuid(value: string): boolean {
  return new RegExp(`^${UUID_PATTERN}$`).test(value);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseWorkSessionAction(value: unknown): ParsedAction | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match = ACTION_PATTERN.exec(value);
  if (!match || !workSessionActions.has(match[3] as WorkSessionFlowAction)) {
    return null;
  }
  const version = Number(match[2]);
  if (!positiveInteger(version)) {
    return null;
  }
  return {
    action: match[3] as WorkSessionFlowAction,
    id: match[1],
    version,
  };
}

export function workSessionActionReference(
  reference: DraftReference,
  action: WorkSessionFlowAction,
): string {
  const value = `w:${reference.id}:${reference.version}:${action}`;
  const parsed = parseWorkSessionAction(value);
  if (
    !parsed ||
    parsed.id !== reference.id ||
    parsed.version !== reference.version ||
    parsed.action !== action
  ) {
    throw new Error("Invalid work-session action reference");
  }
  return value;
}

function action(
  reference: DraftReference,
  value: WorkSessionFlowAction,
  text: string,
) {
  return {
    callbackData: workSessionActionReference(reference, value),
    text,
  };
}

export function isEligibleWorkSessionCandidate(
  fields: DecisionContextFields,
  suppliedWindow: WorkWindow | null = null,
): boolean {
  return (
    suppliedWindow === null &&
    fields.definitionOfDone !== null &&
    fields.targetAt !== null &&
    fields.targetTimeZone === "Asia/Singapore" &&
    fields.possibleWorkSession &&
    !fields.simpleAction &&
    !fields.offerWorkWindowHelp
  );
}

export function workSessionPlanningOffer(
  fields: DecisionContextFields,
  reference: DraftReference,
  prefix?: string,
): TelegramReply {
  if (!isEligibleWorkSessionCandidate(fields)) {
    throw new Error("Work-session planning is not eligible");
  }
  return {
    actions: [
      action(reference, "help", "Help me find time"),
      action(reference, "owner_time", "I’ll choose a time"),
      action(reference, "no_preparation", "No preparation needed"),
      action(reference, "cancel", "Cancel"),
    ],
    text: prefix
      ? `${prefix}\n\n${workSessionFlowCopy.offer}`
      : workSessionFlowCopy.offer,
  };
}

function reference(snapshot: WorkSessionDraftSnapshot): DraftReference {
  return { id: snapshot.id, version: snapshot.version };
}

function durationReply(snapshot: WorkSessionDraftSnapshot): TelegramReply {
  const current = reference(snapshot);
  return {
    actions: SUPPORTED_DURATIONS.map((duration) =>
      action(
        current,
        `duration_${duration}` as WorkSessionFlowAction,
        `${duration} min`,
      )
    ),
    text: workSessionFlowCopy.duration,
  };
}

function constraintsReply(snapshot: WorkSessionDraftSnapshot): TelegramReply {
  return {
    actions: [
      action(reference(snapshot), "cancel", "Cancel"),
    ],
    text: workSessionFlowCopy.constraints,
  };
}

function ownerTimeReply(snapshot: WorkSessionDraftSnapshot): TelegramReply {
  return {
    actions: [
      action(reference(snapshot), "cancel", "Cancel"),
    ],
    text: workSessionFlowCopy.chooseOwnerTime,
  };
}

function naturalQuestionReply(
  snapshot: WorkSessionDraftSnapshot,
  question: string,
): TelegramReply {
  return {
    actions: [action(reference(snapshot), "cancel", "Cancel")],
    text: question,
  };
}

function formatWindow(window: WorkWindow): string {
  return `${formatSingaporeTarget(window.startAt)} to ${formatSingaporeTarget(window.endAt)}`;
}

function savedReply(
  request: WorkSessionCommitRequest,
): TelegramReply {
  const outcome =
    request.calendar.status === "conflict_kept"
      ? ["You kept the conflicting time."]
      : request.calendar.status === "unverified"
        ? ["This was saved without a Calendar check."]
        : [];
  return {
    text: [
      "Promise and work session saved.",
      `Start reminder: ${formatSingaporeTarget(request.selectedWindow.startAt)}`,
      `End check-in: ${formatSingaporeTarget(request.selectedWindow.endAt)}`,
      "Google Calendar was not changed.",
      ...outcome,
    ].join("\n"),
  };
}

function choicesReply(
  snapshot: WorkSessionDraftSnapshot,
  prefix = "I found these available work windows.",
): TelegramReply {
  const current = reference(snapshot);
  return {
    actions: [
      ...snapshot.options.map((_, index) =>
        action(
          current,
          `option_${index + 1}` as WorkSessionFlowAction,
          `Choose option ${index + 1}`,
        )
      ),
      action(current, "owner_time", "Choose my time"),
      action(current, "cancel", "Cancel"),
    ],
    text: [
      prefix,
      "",
      ...snapshot.options.map(
        (window, index) => `${index + 1}. ${formatWindow(window)}`,
      ),
      "",
      "Google Calendar will not be changed.",
      "Nothing has been saved yet.",
    ].join("\n"),
  };
}

function calendarLabel(snapshot: WorkSessionDraftSnapshot): string {
  if (snapshot.conflictConsent) {
    return `Conflict accepted; checked at ${snapshot.calendarCheckedAt ?? "the last check"}.`;
  }
  return snapshot.calendarCheckedAt
    ? `Free when checked at ${snapshot.calendarCheckedAt}.`
    : "Not verified.";
}

function confirmationReply(
  snapshot: WorkSessionDraftSnapshot,
  prefix?: string,
): TelegramReply {
  if (!snapshot.selectedWindow || !snapshot.durationMinutes) {
    throw new Error("Complete work-session selection is required");
  }
  const current = reference(snapshot);
  const text = [
    "Please confirm this promise and work session.",
    "",
    `Definition of done: ${snapshot.definitionOfDone}`,
    `Target: ${formatSingaporeTarget(snapshot.targetAt)}`,
    `Work session: ${formatWindow(snapshot.selectedWindow)}`,
    `Expected duration: ${snapshot.durationMinutes} minutes`,
    `Calendar availability: ${calendarLabel(snapshot)}`,
    "Google Calendar will not be changed.",
    "Nothing has been saved yet.",
  ].join("\n");
  return {
    actions: [
      action(current, "confirm", "Confirm"),
      action(current, "cancel", "Cancel"),
    ],
    text: prefix ? `${prefix}\n\n${text}` : text,
  };
}

function executionDecision(
  fields: Readonly<{
    definitionOfDone: string;
    durationMinutes?: number | null;
    targetAt: string;
    timingConstraints?: string | null;
  }>,
  commitmentMode: "possible_work_session" | "simple_action",
): DecisionResult {
  const durationMinutes =
    commitmentMode === "possible_work_session"
      ? fields.durationMinutes ?? null
      : null;
  return {
    commitmentMode,
    definitionOfDone: fields.definitionOfDone,
    durationMinutes,
    inputClass: "explicit_commitment",
    missingFields: [],
    nextAction:
      commitmentMode === "possible_work_session" &&
        durationMinutes === null
        ? "offer_work_window"
        : "ready",
    offerWorkWindowHelp: false,
    response: "",
    targetAt: fields.targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: fields.timingConstraints
      ? [fields.timingConstraints]
      : [],
    turnRelation: "new_request",
  };
}

function unavailableReply(
  snapshot: WorkSessionDraftSnapshot,
  authorizationExpired: boolean,
): TelegramReply {
  const current = reference(snapshot);
  const selected = snapshot.selectedWindow !== null;
  return {
    actions: [
      ...(authorizationExpired
        ? [action(current, "reconnect", "Reconnect")]
        : []),
      action(current, "check_again", "Check again"),
      ...(selected
        ? [
            action(
              current,
              "save_unverified",
              "Save without Calendar check",
            ),
          ]
        : [action(current, "owner_time", "Choose my time")]),
      action(current, "cancel", "Cancel"),
    ],
    text: selected
      ? "I couldn’t verify that selected time. You can check again or explicitly save without a Calendar check. Nothing has been saved yet."
      : "I couldn’t check Calendar availability. Reconnect or check again, or choose an exact time. Nothing has been saved yet.",
  };
}

function conflictReply(
  snapshot: WorkSessionDraftSnapshot,
  newlyDetected: boolean,
): TelegramReply {
  if (!snapshot.selectedWindow) {
    throw new Error("A conflicting selected window is required");
  }
  const current = reference(snapshot);
  return {
    actions: [
      ...snapshot.options.map((_, index) =>
        action(
          current,
          `option_${index + 1}` as WorkSessionFlowAction,
          `Choose option ${index + 1}`,
        )
      ),
      action(current, "keep", "Keep conflicting time"),
      action(current, "owner_time", "Choose my time"),
      action(current, "cancel", "Cancel"),
    ],
    text: [
      newlyDetected
        ? "That time now conflicts with your Calendar, so I did not save it."
        : "That time conflicts with your Calendar.",
      `Selected time: ${formatWindow(snapshot.selectedWindow)}`,
      ...(snapshot.options.length > 0
        ? [
            "",
            ...snapshot.options.map(
              (window, index) => `${index + 1}. ${formatWindow(window)}`,
            ),
          ]
        : []),
      "",
      "Keep conflicting time requires another explicit confirmation.",
      "Google Calendar will not be changed.",
      "Nothing has been saved yet.",
    ].join("\n"),
  };
}

function transitioned(
  result: WorkSessionFlowTransitionResult,
  reply: (snapshot: WorkSessionDraftSnapshot) => TelegramReply,
): TelegramReply | null {
  switch (result.kind) {
    case "replay":
      return null;
    case "expired":
      return { text: workSessionFlowCopy.expired };
    case "stale":
      return { text: workSessionFlowCopy.stale };
    case "applied":
      return reply(result.snapshot);
  }
}

function durationFromAction(
  actionValue: WorkSessionFlowAction,
): 30 | 60 | 90 | 120 | undefined {
  const match = /^duration_(30|60|90|120)$/.exec(actionValue);
  return match
    ? (Number(match[1]) as 30 | 60 | 90 | 120)
    : undefined;
}

function optionFromAction(
  actionValue: WorkSessionFlowAction,
): number | undefined {
  const match = /^option_([12])$/.exec(actionValue);
  return match ? Number(match[1]) - 1 : undefined;
}

function canonicalTiming(value: string): string | undefined {
  const result = normalizeTimingConstraints(value, []);
  return result.status === "ok" ? result.canonical : undefined;
}

function endFor(startAt: string, durationMinutes: number): string | undefined {
  if (
    !isSingaporeWorkSessionStart(startAt) ||
    !isWorkSessionDuration(durationMinutes)
  ) {
    return undefined;
  }
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) {
    return undefined;
  }
  const end = new Date(start + durationMinutes * 60_000);
  const local = new Date(end.getTime() + 8 * 60 * 60_000);
  const dateTime = local.toISOString().slice(0, 19);
  return `${dateTime}+08:00`;
}

export class WorkSessionFlow {
  readonly #availability: WorkSessionAvailabilityChecker;
  readonly #committer: WorkSessionCommitter;
  readonly #now: () => Date;
  readonly #prepareApproval:
    | WorkSessionFlowOptions["prepareApproval"]
    | undefined;
  readonly #repository: WorkSessionFlowRepository;

  constructor(options: WorkSessionFlowOptions) {
    this.#availability = options.availability;
    this.#committer = options.committer;
    this.#now = options.now ?? (() => new Date());
    this.#prepareApproval = options.prepareApproval;
    this.#repository = options.repository;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const parsed = parseWorkSessionAction(callbackData);
    if (!parsed) {
      return { text: workSessionFlowCopy.invalidAction };
    }
    const read = await this.#repository.read(parsed);
    if (read.kind === "expired") {
      return { text: workSessionFlowCopy.expired };
    }
    if (read.kind !== "current") {
      return { text: workSessionFlowCopy.stale };
    }
    const snapshot = read.snapshot;

    if (
      parsed.action === "no_preparation" &&
      snapshot.stage === "offer_help"
    ) {
      const result = await this.#repository.declinePreparation(
        updateId,
        chatId,
        parsed,
      );
      switch (result.kind) {
        case "replay":
          return null;
        case "expired":
          return { text: workSessionFlowCopy.expired };
        case "stale":
          return { text: workSessionFlowCopy.stale };
        case "applied":
          return this.#prepareConsequence(
            updateId,
            chatId,
            result.draft,
            executionDecision(result.draft, "simple_action"),
            confirmationSummary(result.draft, result.draft),
          );
      }
    }

    if (parsed.action === "cancel") {
      const result = await this.#repository.cancel(
        updateId,
        chatId,
        parsed,
        snapshot.stage,
      );
      return transitioned(result, () => ({
        text: workSessionFlowCopy.cancelled,
      }));
    }

    if (parsed.action === "reconnect") {
      return { text: workSessionFlowCopy.reconnect };
    }

    if (
      parsed.action === "help" &&
      snapshot.stage === "offer_help"
    ) {
      return this.#move(
        updateId,
        chatId,
        snapshot,
        snapshot.durationMinutes
          ? "awaiting_constraints"
          : "awaiting_duration_help",
        (current) =>
          current.stage === "awaiting_constraints"
            ? constraintsReply(current)
            : durationReply(current),
      );
    }

    if (
      parsed.action === "owner_time" &&
      [
        "availability_unavailable",
        "awaiting_owner_time",
        "choosing",
        "conflict_choice",
        "offer_help",
      ].includes(snapshot.stage)
    ) {
      const nextStage = snapshot.durationMinutes
        ? "awaiting_owner_time"
        : "awaiting_duration_owner";
      const result = await this.#repository.transition({
        chatId,
        expectedStage: snapshot.stage,
        nextStage,
        reference: parsed,
        timingConstraints: "default",
        updateId,
      });
      return transitioned(
        result,
        nextStage === "awaiting_owner_time"
          ? ownerTimeReply
          : durationReply,
      );
    }

    const duration = durationFromAction(parsed.action);
    if (
      duration &&
      (
        snapshot.stage === "awaiting_duration_help" ||
        snapshot.stage === "awaiting_duration_owner"
      )
    ) {
      const nextStage =
        snapshot.stage === "awaiting_duration_help"
          ? "awaiting_constraints"
          : "awaiting_owner_time";
      const result = await this.#repository.transition({
        chatId,
        durationMinutes: duration,
        expectedStage: snapshot.stage,
        nextStage,
        reference: parsed,
        ...(nextStage === "awaiting_owner_time"
          ? { timingConstraints: "default" }
          : {}),
        updateId,
      });
      return transitioned(
        result,
        nextStage === "awaiting_constraints"
          ? constraintsReply
          : ownerTimeReply,
      );
    }

    const optionIndex = optionFromAction(parsed.action);
    if (
      optionIndex !== undefined &&
      (
        snapshot.stage === "choosing" ||
        snapshot.stage === "conflict_choice"
      )
    ) {
      const selected = snapshot.options[optionIndex];
      if (!selected) {
        return { text: workSessionFlowCopy.stale };
      }
      const result = await this.#repository.transition({
        calendarCheckedAt: snapshot.calendarCheckedAt,
        chatId,
        conflictConsent: false,
        expectedStage: snapshot.stage,
        nextStage: "confirming",
        options: [],
        reference: parsed,
        selectedWindow: selected,
        updateId,
      });
      return this.#transitionConsequence(
        updateId,
        chatId,
        result,
        confirmationReply,
      );
    }

    if (
      parsed.action === "keep" &&
      snapshot.stage === "conflict_choice" &&
      snapshot.selectedWindow
    ) {
      const result = await this.#repository.transition({
        chatId,
        conflictConsent: true,
        expectedStage: snapshot.stage,
        nextStage: "conflict_confirming",
        options: [],
        reference: parsed,
        updateId,
      });
      return this.#transitionConsequence(
        updateId,
        chatId,
        result,
        (current) =>
          confirmationReply(
            current,
            "You chose to keep the conflicting time.",
          ),
      );
    }

    if (
      parsed.action === "confirm" &&
      (
        snapshot.stage === "confirming" ||
        snapshot.stage === "conflict_confirming"
      )
    ) {
      return this.#recheck(updateId, chatId, parsed, snapshot);
    }

    if (
      parsed.action === "check_again" &&
      (
        snapshot.stage === "availability_unavailable" ||
        snapshot.stage === "unverified_confirming"
      )
    ) {
      return snapshot.selectedWindow
        ? this.#recheck(updateId, chatId, parsed, snapshot)
        : this.#findOptions(updateId, chatId, parsed, snapshot);
    }

    if (
      parsed.action === "save_unverified" &&
      snapshot.stage === "unverified_confirming" &&
      snapshot.selectedWindow
    ) {
      return this.#prepareCommit(
        updateId,
        chatId,
        parsed,
        snapshot,
        "save_unverified",
        "unavailable",
        null,
      );
    }

    return { text: workSessionFlowCopy.invalidAction };
  }

  async handleConversationInput(
    updateId: number,
    chatId: number,
    input: WorkSessionConversationInput,
  ): Promise<TelegramReply | null> {
    try {
      return await this.#handleConversationInput(
        updateId,
        chatId,
        input,
      );
    } catch {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        { id: input.draftId, version: input.draftVersion },
        "domain_error",
      );
      return { text: workSessionFlowCopy.approvalUnavailable };
    }
  }

  async #handleConversationInput(
    updateId: number,
    chatId: number,
    input: WorkSessionConversationInput,
  ): Promise<TelegramReply | null> {
    const draftReference = {
      id: input.draftId,
      version: input.draftVersion,
    };
    const read = await this.#repository.read(draftReference);
    if (read.kind === "expired") {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        draftReference,
        "expired",
      );
      return { text: workSessionFlowCopy.expired };
    }
    if (read.kind !== "current") {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        draftReference,
        "stale",
      );
      return { text: workSessionFlowCopy.stale };
    }
    const snapshot = read.snapshot;

    if (
      snapshot.stage === "offer_help" &&
      input.preparationRequired === false
    ) {
      const result =
        this.#repository.declinePreparationFromConversation === undefined
          ? await this.#repository.declinePreparation(
              updateId,
              chatId,
              draftReference,
            )
          : await this.#repository.declinePreparationFromConversation(
              updateId,
              chatId,
              draftReference,
            );
      switch (result.kind) {
        case "replay":
          return null;
        case "expired":
          return { text: workSessionFlowCopy.expired };
        case "stale":
          return { text: workSessionFlowCopy.stale };
        case "applied":
          return this.#prepareConsequence(
            updateId,
            chatId,
            result.draft,
            executionDecision(result.draft, "simple_action"),
            confirmationSummary(result.draft, result.draft),
          );
      }
    }

    if (
      snapshot.stage === "offer_help" &&
      input.preparationRequired === true &&
      input.durationMinutes === null &&
      input.nextInput === "duration" &&
      input.followUpQuestion !== null
    ) {
      const result = await this.#conversationTransition({
        chatId,
        expectedStage: snapshot.stage,
        nextStage: "awaiting_duration_help",
        reference: draftReference,
        ...(input.timingConstraints === null
          ? {}
          : { timingConstraints: input.timingConstraints }),
        updateId,
      });
      return transitioned(result, (current) =>
        naturalQuestionReply(current, input.followUpQuestion!)
      );
    }

    const acceptsDuration = [
      "offer_help",
      "awaiting_duration_help",
      "awaiting_duration_owner",
    ].includes(snapshot.stage);
    if (
      acceptsDuration &&
      input.durationMinutes !== null &&
      isWorkSessionDuration(input.durationMinutes)
    ) {
      if (input.timingConstraints !== null) {
        return this.#findOptions(
          updateId,
          chatId,
          draftReference,
          { ...snapshot, durationMinutes: input.durationMinutes },
          input.timingConstraints,
          input.durationMinutes,
          true,
        );
      }
      if (input.startAt !== null) {
        return this.#selectOwnerTime(
          updateId,
          chatId,
          draftReference,
          { ...snapshot, durationMinutes: input.durationMinutes },
          input.startAt,
          input.durationMinutes,
          true,
        );
      }
      if (
        input.nextInput === null &&
        snapshot.timingConstraints !== null
      ) {
        return this.#findOptions(
          updateId,
          chatId,
          draftReference,
          { ...snapshot, durationMinutes: input.durationMinutes },
          snapshot.timingConstraints,
          input.durationMinutes,
          true,
        );
      }
      if (
        input.followUpQuestion !== null &&
        (
          input.nextInput === "timing_constraints" ||
          input.nextInput === "owner_time"
        )
      ) {
        const nextStage =
          input.nextInput === "owner_time"
            ? "awaiting_owner_time"
            : "awaiting_constraints";
        const result = await this.#conversationTransition({
          chatId,
          durationMinutes: input.durationMinutes,
          expectedStage: snapshot.stage,
          nextStage,
          reference: draftReference,
          ...(nextStage === "awaiting_owner_time"
            ? { timingConstraints: "default" }
            : {}),
          updateId,
        });
        return transitioned(result, (current) =>
          naturalQuestionReply(current, input.followUpQuestion!)
        );
      }
    }

    if (
      snapshot.stage === "awaiting_constraints" &&
      input.timingConstraints !== null
    ) {
      return this.#findOptions(
        updateId,
        chatId,
        draftReference,
        snapshot,
        input.timingConstraints,
        undefined,
        true,
      );
    }

    if (
      snapshot.stage === "awaiting_owner_time" &&
      input.startAt !== null
    ) {
      return this.#selectOwnerTime(
        updateId,
        chatId,
        draftReference,
        snapshot,
        input.startAt,
        undefined,
        true,
      );
    }

    await this.#repository.finalizeConversation(
      updateId,
      chatId,
      draftReference,
      "invalid",
    );
    return { text: workSessionFlowCopy.stale };
  }

  async submitTimingConstraints(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    timingConstraints: string,
  ): Promise<TelegramReply | null> {
    const read = await this.#repository.read(draftReference);
    if (
      read.kind !== "current" ||
      read.snapshot.stage !== "awaiting_constraints"
    ) {
      return { text: workSessionFlowCopy.stale };
    }
    const canonical = canonicalTiming(timingConstraints);
    if (!canonical) {
      return {
        text: TIMING_CONSTRAINT_FORMAT_HELP,
      };
    }
    return this.#findOptions(
      updateId,
      chatId,
      draftReference,
      read.snapshot,
      canonical,
    );
  }

  async submitOwnerTime(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    startAt: string,
  ): Promise<TelegramReply | null> {
    const read = await this.#repository.read(draftReference);
    if (
      read.kind !== "current" ||
      read.snapshot.stage !== "awaiting_owner_time" ||
      !read.snapshot.durationMinutes
    ) {
      return { text: workSessionFlowCopy.stale };
    }
    return this.#selectOwnerTime(
      updateId,
      chatId,
      draftReference,
      read.snapshot,
      startAt,
    );
  }

  async #selectOwnerTime(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    snapshot: WorkSessionDraftSnapshot,
    startAt: string,
    submittedDuration?: number,
    fromConversation = false,
  ): Promise<TelegramReply | null> {
    const durationMinutes =
      submittedDuration ?? snapshot.durationMinutes;
    if (!isWorkSessionDuration(durationMinutes)) {
      if (fromConversation) {
        await this.#repository.finalizeConversation(
          updateId,
          chatId,
          draftReference,
          "invalid",
        );
      }
      return { text: workSessionFlowCopy.stale };
    }
    const endAt = endFor(startAt, durationMinutes);
    if (!endAt || Date.parse(startAt) <= this.#now().getTime()) {
      if (fromConversation) {
        await this.#repository.finalizeConversation(
          updateId,
          chatId,
          draftReference,
          "invalid",
        );
      }
      return { text: workSessionFlowCopy.invalidOwnerTime };
    }
    const selectedWindow = { endAt, startAt };
    const timingConstraints = snapshot.timingConstraints ?? "default";
    const result = await this.#availability({
      durationMinutes,
      kind: "proposal",
      now: this.#now().toISOString(),
      proposedStartAt: startAt,
      targetAt: snapshot.targetAt,
      timingConstraints,
    });
    const attemptedAt = this.#now().toISOString();
    if (result.status === "available" && result.proposed) {
      if (result.proposed.status === "free") {
        const transitionedResult = await this.#transitionInput({
          calendarAttemptedAt: attemptedAt,
          calendarCheckedAt: result.checkedAt,
          chatId,
          conflictConsent: false,
          ...(submittedDuration === undefined
            ? {}
            : { durationMinutes: submittedDuration }),
          expectedStage: snapshot.stage,
          nextStage: "confirming",
          options: [],
          reference: draftReference,
          selectedWindow,
          timingConstraints,
          updateId,
        }, fromConversation);
        return this.#transitionConsequence(
          updateId,
          chatId,
          transitionedResult,
          confirmationReply,
        );
      }
      const transitionedResult = await this.#transitionInput({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: result.checkedAt,
        chatId,
        conflictConsent: false,
        ...(submittedDuration === undefined
          ? {}
          : { durationMinutes: submittedDuration }),
        expectedStage: snapshot.stage,
        nextStage: "conflict_choice",
        options: result.alternatives.slice(0, 2),
        reference: draftReference,
        selectedWindow,
        timingConstraints,
        updateId,
      }, fromConversation);
      return transitioned(transitionedResult, (current) =>
        conflictReply(current, false)
      );
    }
    if (
      result.status === "authorization_expired" ||
      result.status === "provider_failure" ||
      result.status === "unavailable"
    ) {
      const transitionedResult = await this.#transitionInput({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: null,
        chatId,
        ...(submittedDuration === undefined
          ? {}
          : { durationMinutes: submittedDuration }),
        expectedStage: snapshot.stage,
        nextStage: "unverified_confirming",
        options: [],
        reference: draftReference,
        selectedWindow,
        timingConstraints,
        updateId,
      }, fromConversation);
      return this.#transitionConsequence(
        updateId,
        chatId,
        transitionedResult,
        (current) =>
          unavailableReply(
            current,
            result.status === "authorization_expired",
          ),
      );
    }
    if (fromConversation) {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        draftReference,
        "invalid",
      );
    }
    return { text: workSessionFlowCopy.invalidOwnerTime };
  }

  async #move(
    updateId: number,
    chatId: number,
    snapshot: WorkSessionDraftSnapshot,
    nextStage: WorkSessionFlowStage,
    reply: (snapshot: WorkSessionDraftSnapshot) => TelegramReply,
  ): Promise<TelegramReply | null> {
    const result = await this.#repository.transition({
      chatId,
      expectedStage: snapshot.stage,
      nextStage,
      reference: reference(snapshot),
      updateId,
    });
    return transitioned(result, reply);
  }

  async #findOptions(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    snapshot: WorkSessionDraftSnapshot,
    submittedTiming?: string,
    submittedDuration?: number,
    fromConversation = false,
  ): Promise<TelegramReply | null> {
    if (!snapshot.durationMinutes) {
      if (fromConversation) {
        await this.#repository.finalizeConversation(
          updateId,
          chatId,
          draftReference,
          "invalid",
        );
      }
      return { text: workSessionFlowCopy.stale };
    }
    const timingConstraints =
      submittedTiming ?? snapshot.timingConstraints ?? "default";
    const availability = await this.#availability({
      durationMinutes: snapshot.durationMinutes,
      kind: "generated",
      now: this.#now().toISOString(),
      targetAt: snapshot.targetAt,
      timingConstraints,
    });
    const attemptedAt = this.#now().toISOString();
    if (availability.status === "available") {
      const result = await this.#transitionInput({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: availability.checkedAt,
        chatId,
        ...(submittedDuration === undefined
          ? {}
          : { durationMinutes: submittedDuration }),
        expectedStage: snapshot.stage,
        nextStage: "choosing",
        options: availability.alternatives.slice(0, 2),
        reference: draftReference,
        selectedWindow: null,
        timingConstraints,
        updateId,
      }, fromConversation);
      return transitioned(result, choicesReply);
    }
    if (availability.status === "no_fit") {
      const result = await this.#transitionInput({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: availability.checkedAt,
        chatId,
        ...(submittedDuration === undefined
          ? {}
          : { durationMinutes: submittedDuration }),
        expectedStage: snapshot.stage,
        nextStage: "awaiting_owner_time",
        options: [],
        reference: draftReference,
        selectedWindow: null,
        timingConstraints,
        updateId,
      }, fromConversation);
      return transitioned(result, (current) => ({
        ...ownerTimeReply(current),
        text: `${workSessionFlowCopy.noFit}\n\n${workSessionFlowCopy.chooseOwnerTime}`,
      }));
    }
    if (
      availability.status === "authorization_expired" ||
      availability.status === "provider_failure" ||
      availability.status === "unavailable"
    ) {
      const result = await this.#transitionInput({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: null,
        chatId,
        ...(submittedDuration === undefined
          ? {}
          : { durationMinutes: submittedDuration }),
        expectedStage: snapshot.stage,
        nextStage: "availability_unavailable",
        options: [],
        reference: draftReference,
        selectedWindow: null,
        timingConstraints,
        updateId,
      }, fromConversation);
      return transitioned(result, (current) =>
        unavailableReply(
          current,
          availability.status === "authorization_expired",
        )
      );
    }
    if (fromConversation) {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        draftReference,
        "invalid",
      );
    }
    return { text: TIMING_CONSTRAINT_FORMAT_HELP };
  }

  #conversationTransition(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult> {
    return this.#repository.transitionFromConversation === undefined
      ? this.#repository.transition(command)
      : this.#repository.transitionFromConversation(command);
  }

  #transitionInput(
    command: WorkSessionFlowTransition,
    fromConversation: boolean,
  ): Promise<WorkSessionFlowTransitionResult> {
    return fromConversation
      ? this.#conversationTransition(command)
      : this.#repository.transition(command);
  }

  async #prepareConsequence(
    updateId: number,
    chatId: number,
    draft: DraftReference,
    decision: DecisionResult,
    reply: TelegramReply,
  ): Promise<TelegramReply> {
    if (!this.#prepareApproval) {
      return reply;
    }
    try {
      const prepared = await this.#prepareApproval({
        chatId,
        decision,
        draft,
        updateId,
      });
      return prepared
        ? reply
        : { text: workSessionFlowCopy.approvalUnavailable };
    } catch {
      return { text: workSessionFlowCopy.approvalUnavailable };
    }
  }

  async #transitionConsequence(
    updateId: number,
    chatId: number,
    result: WorkSessionFlowTransitionResult,
    reply: (snapshot: WorkSessionDraftSnapshot) => TelegramReply,
  ): Promise<TelegramReply | null> {
    if (result.kind !== "applied") {
      return transitioned(result, reply);
    }
    return this.#prepareConsequence(
      updateId,
      chatId,
      reference(result.snapshot),
      executionDecision(result.snapshot, "possible_work_session"),
      reply(result.snapshot),
    );
  }

  async #recheck(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    snapshot: WorkSessionDraftSnapshot,
  ): Promise<TelegramReply | null> {
    if (
      !snapshot.durationMinutes ||
      !snapshot.selectedWindow ||
      !snapshot.timingConstraints
    ) {
      return { text: workSessionFlowCopy.stale };
    }
    const availability = await this.#availability({
      durationMinutes: snapshot.durationMinutes,
      kind: "proposal",
      now: this.#now().toISOString(),
      proposedStartAt: snapshot.selectedWindow.startAt,
      targetAt: snapshot.targetAt,
      timingConstraints: snapshot.timingConstraints,
    });
    const attemptedAt = this.#now().toISOString();
    if (availability.status === "available" && availability.proposed) {
      if (availability.proposed.status === "free") {
        return this.#prepareCommit(
          updateId,
          chatId,
          draftReference,
          snapshot,
          "confirm",
          availability.proposed.status,
          availability.checkedAt,
        );
      }
      if (snapshot.conflictConsent) {
        return this.#prepareCommit(
          updateId,
          chatId,
          draftReference,
          snapshot,
          "confirm",
          "conflict",
          availability.checkedAt,
        );
      }
      const result = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: availability.checkedAt,
        chatId,
        conflictConsent: false,
        expectedStage: snapshot.stage,
        finalObservation: "conflict",
        nextStage: "conflict_choice",
        options: availability.alternatives.slice(0, 2),
        reference: draftReference,
        updateId,
      });
      return transitioned(result, (current) =>
        conflictReply(current, true)
      );
    }
    if (
      availability.status === "authorization_expired" ||
      availability.status === "provider_failure" ||
      availability.status === "unavailable"
    ) {
      const result = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: null,
        chatId,
        expectedStage: snapshot.stage,
        finalObservation: "unavailable",
        nextStage: "unverified_confirming",
        options: [],
        reference: draftReference,
        updateId,
      });
      return this.#transitionConsequence(
        updateId,
        chatId,
        result,
        (current) =>
          unavailableReply(
            current,
            availability.status === "authorization_expired",
          ),
      );
    }
    return { text: workSessionFlowCopy.invalidOwnerTime };
  }

  async #prepareCommit(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    snapshot: WorkSessionDraftSnapshot,
    action: "confirm" | "save_unverified",
    observation: "conflict" | "free" | "unavailable",
    checkedAt: string | null,
  ): Promise<TelegramReply | null> {
    const attemptedAt =
      observation === "unavailable"
        ? snapshot.calendarAttemptedAt
        : this.#now().toISOString();
    if (
      !snapshot.durationMinutes ||
      !snapshot.selectedWindow ||
      !snapshot.timingConstraints ||
      !attemptedAt ||
      ![
        "confirming",
        "conflict_confirming",
        "unverified_confirming",
      ].includes(snapshot.stage)
    ) {
      throw new Error("Incomplete work-session commit request");
    }
    const request: WorkSessionCommitRequest = {
      action,
      calendar: {
        attemptedAt,
        checkedAt,
        conflictConsent: snapshot.conflictConsent,
        finalObservation: observation,
        status:
          observation === "unavailable"
            ? "unverified"
            : observation === "conflict"
              ? "conflict_kept"
              : "free",
      },
      chatId,
      definitionOfDone: snapshot.definitionOfDone,
      draft: draftReference,
      durationMinutes: snapshot.durationMinutes,
      expectedStage:
        snapshot.stage as WorkSessionCommitRequest["expectedStage"],
      selectedWindow: snapshot.selectedWindow,
      targetAt: snapshot.targetAt,
      timingConstraints: snapshot.timingConstraints,
      updateId,
    };
    const result = await this.#committer.commit(request);
    if (result.kind === "replay") {
      return null;
    }
    if (result.kind === "stale") {
      return { text: workSessionFlowCopy.stale };
    }
    return savedReply(request);
  }
}
