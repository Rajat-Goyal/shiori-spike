import type { DecisionContextFields } from "../decision/schema.js";
import {
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

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTION_PATTERN = new RegExp(
  `^w:(${UUID_PATTERN}):([1-9][0-9]*):([a-z0-9_]+)$`,
);
const SINGAPORE_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|30):00\+08:00$/;
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
  durationMinutes: 30 | 60 | 90 | 120 | null;
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
  durationMinutes?: 30 | 60 | 90 | 120;
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

export interface WorkSessionFlowRepository {
  cancel(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    expectedStage: WorkSessionFlowStage,
  ): Promise<WorkSessionFlowTransitionResult>;
  read(reference: DraftReference): Promise<
    | Readonly<{ kind: "expired" | "missing" | "stale" }>
    | Readonly<{ kind: "current"; snapshot: WorkSessionDraftSnapshot }>
  >;
  transition(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult>;
}

export type WorkSessionCommitRequest = Readonly<{
  calendar: Readonly<{
    attemptedAt: string;
    checkedAt: string | null;
    conflictConsent: boolean;
    finalObservation: "conflict" | "free" | "unavailable";
    status: "conflict_kept" | "free" | "unverified";
  }>;
  definitionOfDone: string;
  draft: DraftReference;
  durationMinutes: 30 | 60 | 90 | 120;
  selectedWindow: WorkWindow;
  targetAt: string;
  timingConstraints: string;
}>;

export interface WorkSessionCommitter {
  commit(request: WorkSessionCommitRequest): Promise<void>;
}

export type WorkSessionAvailabilityChecker = (
  request: CalendarAvailabilityRequest,
) => Promise<CalendarAvailabilityResult>;

type WorkSessionFlowOptions = Readonly<{
  availability: WorkSessionAvailabilityChecker;
  committer: WorkSessionCommitter;
  now?: () => Date;
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
    "Would you like help finding time for this promise? Nothing has been saved yet.",
  reconnect:
    "Reconnect Google Calendar from the protected dashboard, then press Check again.",
  replay: "",
  saved: "The version-current work-session request was accepted.",
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

function formatWindow(window: WorkWindow): string {
  return `${formatSingaporeTarget(window.startAt)} to ${formatSingaporeTarget(window.endAt)}`;
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
  if (!SINGAPORE_INSTANT_PATTERN.test(startAt)) {
    return undefined;
  }
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) {
    return undefined;
  }
  const end = new Date(start + durationMinutes * 60_000);
  const local = new Date(end.getTime() + 8 * 60 * 60_000);
  const dateTime = local.toISOString().slice(0, 19);
  const result = `${dateTime}+08:00`;
  return result.slice(0, 10) === startAt.slice(0, 10)
    ? result
    : undefined;
}

export class WorkSessionFlow {
  readonly #availability: WorkSessionAvailabilityChecker;
  readonly #committer: WorkSessionCommitter;
  readonly #now: () => Date;
  readonly #repository: WorkSessionFlowRepository;

  constructor(options: WorkSessionFlowOptions) {
    this.#availability = options.availability;
    this.#committer = options.committer;
    this.#now = options.now ?? (() => new Date());
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
      return transitioned(result, confirmationReply);
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
      return transitioned(result, (current) =>
        confirmationReply(
          current,
          "You chose to keep the conflicting time.",
        )
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
        "unavailable",
        null,
      );
    }

    return { text: workSessionFlowCopy.invalidAction };
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
    const snapshot = read.snapshot;
    const durationMinutes = snapshot.durationMinutes;
    if (!durationMinutes) {
      return { text: workSessionFlowCopy.stale };
    }
    const endAt = endFor(startAt, durationMinutes);
    if (!endAt || Date.parse(startAt) <= this.#now().getTime()) {
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
        const transitionedResult = await this.#repository.transition({
          calendarAttemptedAt: attemptedAt,
          calendarCheckedAt: result.checkedAt,
          chatId,
          conflictConsent: false,
          expectedStage: snapshot.stage,
          nextStage: "confirming",
          options: [],
          reference: draftReference,
          selectedWindow,
          timingConstraints,
          updateId,
        });
        return transitioned(transitionedResult, confirmationReply);
      }
      const transitionedResult = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: result.checkedAt,
        chatId,
        conflictConsent: false,
        expectedStage: snapshot.stage,
        nextStage: "conflict_choice",
        options: result.alternatives.slice(0, 2),
        reference: draftReference,
        selectedWindow,
        timingConstraints,
        updateId,
      });
      return transitioned(transitionedResult, (current) =>
        conflictReply(current, false)
      );
    }
    if (
      result.status === "authorization_expired" ||
      result.status === "provider_failure" ||
      result.status === "unavailable"
    ) {
      const transitionedResult = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: null,
        chatId,
        expectedStage: snapshot.stage,
        nextStage: "unverified_confirming",
        options: [],
        reference: draftReference,
        selectedWindow,
        timingConstraints,
        updateId,
      });
      return transitioned(transitionedResult, (current) =>
        unavailableReply(
          current,
          result.status === "authorization_expired",
        )
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
  ): Promise<TelegramReply | null> {
    if (!snapshot.durationMinutes) {
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
      const result = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: availability.checkedAt,
        chatId,
        expectedStage: snapshot.stage,
        nextStage: "choosing",
        options: availability.alternatives.slice(0, 2),
        reference: draftReference,
        selectedWindow: null,
        timingConstraints,
        updateId,
      });
      return transitioned(result, choicesReply);
    }
    if (availability.status === "no_fit") {
      const result = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: availability.checkedAt,
        chatId,
        expectedStage: snapshot.stage,
        nextStage: "awaiting_owner_time",
        options: [],
        reference: draftReference,
        selectedWindow: null,
        timingConstraints,
        updateId,
      });
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
      const result = await this.#repository.transition({
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: null,
        chatId,
        expectedStage: snapshot.stage,
        nextStage: "availability_unavailable",
        options: [],
        reference: draftReference,
        selectedWindow: null,
        timingConstraints,
        updateId,
      });
      return transitioned(result, (current) =>
        unavailableReply(
          current,
          availability.status === "authorization_expired",
        )
      );
    }
    return { text: TIMING_CONSTRAINT_FORMAT_HELP };
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
      if (
        availability.proposed.status === "free" ||
        snapshot.conflictConsent
      ) {
        return this.#prepareCommit(
          updateId,
          chatId,
          draftReference,
          snapshot,
          availability.proposed.status,
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
      return transitioned(result, (current) =>
        unavailableReply(
          current,
          availability.status === "authorization_expired",
        )
      );
    }
    return { text: workSessionFlowCopy.invalidOwnerTime };
  }

  async #prepareCommit(
    updateId: number,
    chatId: number,
    draftReference: DraftReference,
    snapshot: WorkSessionDraftSnapshot,
    observation: "conflict" | "free" | "unavailable",
    checkedAt: string | null,
  ): Promise<TelegramReply | null> {
    const attemptedAt = this.#now().toISOString();
    const result = await this.#repository.transition({
      calendarAttemptedAt: attemptedAt,
      calendarCheckedAt: checkedAt,
      chatId,
      expectedStage: snapshot.stage,
      finalObservation: observation,
      nextStage: "commit_pending",
      options: [],
      reference: draftReference,
      updateId,
    });
    if (result.kind !== "applied") {
      return transitioned(result, () => ({
        text: workSessionFlowCopy.saved,
      }));
    }
    const current = result.snapshot;
    if (
      !current.durationMinutes ||
      !current.selectedWindow ||
      !current.timingConstraints ||
      !current.calendarAttemptedAt ||
      !current.finalObservation
    ) {
      throw new Error("Incomplete work-session commit request");
    }
    await this.#committer.commit({
      calendar: {
        attemptedAt: current.calendarAttemptedAt,
        checkedAt: current.calendarCheckedAt,
        conflictConsent: current.conflictConsent,
        finalObservation: current.finalObservation,
        status:
          current.finalObservation === "unavailable"
            ? "unverified"
            : current.conflictConsent
              ? "conflict_kept"
              : "free",
      },
      definitionOfDone: current.definitionOfDone,
      draft: reference(current),
      durationMinutes: current.durationMinutes,
      selectedWindow: current.selectedWindow,
      targetAt: current.targetAt,
      timingConstraints: current.timingConstraints,
    });
    return { text: workSessionFlowCopy.saved };
  }
}
