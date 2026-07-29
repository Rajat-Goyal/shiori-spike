import {
  formatSingaporeTarget,
  type TelegramReply,
} from "../confirmation.js";
import { supabaseHeaders } from "../supabase.js";
import type { WorkWindow } from "../scheduling/availability.js";
import type {
  CalendarAvailabilityRequest,
  CalendarAvailabilityResult,
} from "./availability-integration.js";
import { isWorkSessionDuration } from "./duration.js";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTION_PATTERN = new RegExp(
  `^c:(${UUID_PATTERN}):([1-9][0-9]*):([a-z0-9_]+)$`,
);
const SUGGESTED_DURATIONS = [30, 60, 90, 120] as const;

export type WorkSessionContinuationAction =
  | "another"
  | "check_again"
  | "confirm"
  | "decline"
  | "duration_30"
  | "duration_60"
  | "duration_90"
  | "duration_120"
  | "natural_duration"
  | "option_1"
  | "option_2"
  | "reconnect"
  | "save_unverified";

export type WorkSessionContinuationStage =
  | "awaiting_duration"
  | "conflict_choice"
  | "offer"
  | "choosing"
  | "confirming"
  | "unverified_confirming";

export type WorkSessionContinuationSnapshot = Readonly<{
  calendarAttemptedAt: string | null;
  calendarCheckedAt: string | null;
  commitmentId: string;
  commitmentStatus: "active";
  definitionOfDone: string;
  durationMinutes: number | null;
  finalObservation: "conflict" | "free" | "unavailable" | null;
  id: string;
  isRecovery: boolean;
  options: readonly WorkWindow[];
  selectedWindow: WorkWindow | null;
  sourceSessionId: string;
  stage: WorkSessionContinuationStage;
  targetAt: string;
  timingConstraints: string;
  version: number;
}>;

type ParsedContinuationAction = Readonly<{
  action: WorkSessionContinuationAction;
  id: string;
  version: number;
}>;

export type WorkSessionContinuationTransition = Readonly<{
  action: WorkSessionContinuationAction;
  calendarAttemptedAt?: string | null;
  calendarCheckedAt?: string | null;
  chatId: number;
  durationMinutes?: number;
  expectedStage: WorkSessionContinuationStage;
  finalObservation?: "conflict" | "free" | "unavailable" | null;
  isRecovery?: boolean;
  nextStage:
    | "choosing"
    | "confirming"
    | "conflict_choice"
    | "declined"
    | "offer"
    | "unverified_confirming";
  options?: readonly WorkWindow[];
  reference: Readonly<{ id: string; version: number }>;
  selectedWindow?: WorkWindow;
  updateId: number;
}>;

export interface WorkSessionContinuationRepository {
  confirm(
    command: Readonly<{
      attemptedAt: string;
      chatId: number;
      checkedAt: string | null;
      expectedStage: WorkSessionContinuationStage;
      finalObservation: "free" | "unavailable";
      reference: Readonly<{ id: string; version: number }>;
      status: "free" | "unverified";
      updateId: number;
    }>,
  ): Promise<
    | Readonly<{ kind: "applied"; workSessionId: string }>
    | Readonly<{ kind: "expired" | "replay" | "stale" }>
  >;
  finalizeConversation(
    updateId: number,
    chatId: number,
    reference: Readonly<{ id: string; version: number }>,
    result: "domain_error" | "expired" | "invalid" | "stale",
  ): Promise<Readonly<{ kind: "applied" | "replay" }>>;
  read(reference: Readonly<{ id: string; version: number }>): Promise<
    | Readonly<{ kind: "current"; snapshot: WorkSessionContinuationSnapshot }>
    | Readonly<{ kind: "expired" | "missing" | "stale" }>
  >;
  transition(command: WorkSessionContinuationTransition): Promise<
    | Readonly<{
        kind: "applied";
        snapshot: WorkSessionContinuationSnapshot;
      }>
    | Readonly<{ kind: "expired" | "replay" | "stale" }>
  >;
  transitionFromConversation?(
    command: WorkSessionContinuationTransition,
  ): ReturnType<WorkSessionContinuationRepository["transition"]>;
}

export type WorkSessionContinuationConversationInput = Readonly<{
  durationMinutes: number;
  intentId: string;
  intentVersion: number;
}>;

export type WorkSessionContinuationAvailability = (
  request: CalendarAvailabilityRequest,
) => Promise<CalendarAvailabilityResult>;

type WorkSessionContinuationServiceOptions = Readonly<{
  availability: WorkSessionContinuationAvailability;
  now?: () => Date;
  repository: WorkSessionContinuationRepository;
}>;

const actions = new Set<WorkSessionContinuationAction>([
  "another",
  "check_again",
  "confirm",
  "decline",
  "duration_30",
  "duration_60",
  "duration_90",
  "duration_120",
  "option_1",
  "option_2",
  "reconnect",
  "save_unverified",
]);

export const workSessionContinuationCopy = {
  calendarUnavailable:
    "I couldn’t verify Calendar availability. Nothing was scheduled.",
  conflict:
    "That time now conflicts with your Calendar, so nothing was scheduled.",
  confirmed:
    "Next work session scheduled. I’ll send a start reminder and an end check-in. Google Calendar was not changed.",
  declined: "No next work session was scheduled.",
  expired:
    "That continuation expired after 24 hours. Nothing was changed.",
  noFit:
    "I couldn’t find a fitting work window. Nothing was scheduled.",
  reconnect:
    "Reconnect Google Calendar from the protected dashboard, then press Check again.",
  remainingDuration:
    "Remaining focus time recorded. Find a time now?",
  recovery:
    "No pre-target window fits. I found a recovery window after the original target.",
  stale: "That continuation action is stale. Nothing was changed.",
  uncertain:
    "I couldn’t confirm whether that continuation was recorded. Please check /status before trying again.",
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function validWindow(value: unknown): WorkWindow | undefined {
  const item = record(value);
  if (
    !item ||
    typeof item.startAt !== "string" ||
    typeof item.endAt !== "string" ||
    !Number.isFinite(Date.parse(item.startAt)) ||
    !Number.isFinite(Date.parse(item.endAt)) ||
    Date.parse(item.endAt) <= Date.parse(item.startAt)
  ) {
    return undefined;
  }
  return { endAt: item.endAt, startAt: item.startAt };
}

function parseSnapshot(value: unknown): WorkSessionContinuationSnapshot {
  const item = record(value);
  const parsedOptions = Array.isArray(item?.options)
    ? item.options.map(validWindow)
    : [];
  const selectedWindow =
    item?.selectedWindow === null
      ? null
      : validWindow(item?.selectedWindow);
  if (
    !item ||
    typeof item.id !== "string" ||
    !new RegExp(`^${UUID_PATTERN}$`).test(item.id) ||
    !positiveInteger(item.version) ||
    ![
      "awaiting_duration",
      "conflict_choice",
      "offer",
      "choosing",
      "confirming",
      "unverified_confirming",
    ].includes(
      String(item.stage),
    ) ||
    typeof item.commitmentId !== "string" ||
    typeof item.sourceSessionId !== "string" ||
    !(
      item.calendarAttemptedAt === null ||
      (
        typeof item.calendarAttemptedAt === "string" &&
        Number.isFinite(Date.parse(item.calendarAttemptedAt))
      )
    ) ||
    !(
      item.calendarCheckedAt === null ||
      (
        typeof item.calendarCheckedAt === "string" &&
        Number.isFinite(Date.parse(item.calendarCheckedAt))
      )
    ) ||
    ![null, "conflict", "free", "unavailable"].includes(
      item.finalObservation as null | string,
    ) ||
    item.commitmentStatus !== "active" ||
    typeof item.definitionOfDone !== "string" ||
    typeof item.targetAt !== "string" ||
    !Number.isFinite(Date.parse(item.targetAt)) ||
    !(
      item.durationMinutes === null ||
      isWorkSessionDuration(item.durationMinutes)
    ) ||
    typeof item.timingConstraints !== "string" ||
    typeof item.isRecovery !== "boolean" ||
    parsedOptions.length > 2 ||
    parsedOptions.some((window) => window === undefined) ||
    (item.selectedWindow !== null && selectedWindow === undefined)
  ) {
    throw new Error("Continuation snapshot returned invalid data");
  }
  return {
    calendarAttemptedAt: item.calendarAttemptedAt as string | null,
    calendarCheckedAt: item.calendarCheckedAt as string | null,
    commitmentId: item.commitmentId,
    commitmentStatus: "active",
    definitionOfDone: item.definitionOfDone,
    durationMinutes: item.durationMinutes as number | null,
    finalObservation: item.finalObservation as
      | "conflict"
      | "free"
      | "unavailable"
      | null,
    id: item.id,
    isRecovery: item.isRecovery,
    options: parsedOptions as WorkWindow[],
    selectedWindow: selectedWindow ?? null,
    sourceSessionId: item.sourceSessionId,
    stage: item.stage as WorkSessionContinuationStage,
    targetAt: item.targetAt,
    timingConstraints: item.timingConstraints,
    version: item.version,
  };
}

function parseRead(value: unknown) {
  const item = record(value);
  if (
    !item ||
    !["current", "expired", "missing", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Continuation read returned invalid data");
  }
  return item.kind === "current"
    ? { kind: "current" as const, snapshot: parseSnapshot(item.snapshot) }
    : { kind: item.kind as "expired" | "missing" | "stale" };
}

function parseTransition(value: unknown) {
  const item = record(value);
  if (
    !item ||
    !["applied", "expired", "replay", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Continuation transition returned invalid data");
  }
  return item.kind === "applied"
    ? { kind: "applied" as const, snapshot: parseSnapshot(item.snapshot) }
    : { kind: item.kind as "expired" | "replay" | "stale" };
}

export function parseWorkSessionContinuationAction(
  value: unknown,
): ParsedContinuationAction | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match = ACTION_PATTERN.exec(value);
  const version = Number(match?.[2]);
  if (
    !match ||
    !actions.has(match[3] as WorkSessionContinuationAction) ||
    !positiveInteger(version)
  ) {
    return null;
  }
  return {
    action: match[3] as WorkSessionContinuationAction,
    id: match[1],
    version,
  };
}

export function workSessionContinuationActionReference(
  snapshot: Pick<WorkSessionContinuationSnapshot, "id" | "version">,
  action: WorkSessionContinuationAction,
): string {
  const value = `c:${snapshot.id}:${snapshot.version}:${action}`;
  if (!parseWorkSessionContinuationAction(value)) {
    throw new Error("Invalid continuation reference");
  }
  return value;
}

type SupabaseWorkSessionContinuationRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

export class SupabaseWorkSessionContinuationRepository
  implements WorkSessionContinuationRepository
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseWorkSessionContinuationRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async read(reference: Readonly<{ id: string; version: number }>) {
    return parseRead(
      await this.#rpc("read_work_session_continuation", {
        p_intent_id: reference.id,
        p_version: reference.version,
      }),
    );
  }

  async transition(command: WorkSessionContinuationTransition) {
    return parseTransition(
      await this.#rpc("transition_work_session_continuation", {
        p_action: command.action,
        p_calendar_attempted_at:
          command.calendarAttemptedAt ?? null,
        p_calendar_checked_at:
          command.calendarCheckedAt ?? null,
        p_duration_minutes: command.durationMinutes ?? null,
        p_expected_stage: command.expectedStage,
        p_final_observation:
          command.finalObservation ?? null,
        p_intent_id: command.reference.id,
        p_is_recovery: command.isRecovery ?? null,
        p_next_stage: command.nextStage,
        p_options: command.options ?? null,
        p_owner_chat_id: command.chatId,
        p_owner_id: this.#ownerId,
        p_selected_end_at: command.selectedWindow?.endAt ?? null,
        p_selected_start_at: command.selectedWindow?.startAt ?? null,
        p_update_id: command.updateId,
        p_version: command.reference.version,
      }),
    );
  }

  async transitionFromConversation(
    command: WorkSessionContinuationTransition,
  ) {
    return parseTransition(
      await this.#transitionRpc(
        "transition_work_session_continuation_from_conversation",
        command,
      ),
    );
  }

  async finalizeConversation(
    updateId: number,
    chatId: number,
    reference: Readonly<{ id: string; version: number }>,
    result: "domain_error" | "expired" | "invalid" | "stale",
  ) {
    const value = record(
      await this.#rpc(
        "finalize_work_session_continuation_conversation_turn",
        {
          p_intent_id: reference.id,
          p_owner_chat_id: chatId,
          p_owner_id: this.#ownerId,
          p_result: result,
          p_update_id: updateId,
          p_version: reference.version,
        },
      ),
    );
    if (
      !value ||
      !["applied", "replay"].includes(String(value.kind))
    ) {
      throw new Error("Continuation finalization failed");
    }
    return { kind: value.kind as "applied" | "replay" };
  }

  async #transitionRpc(
    name: string,
    command: WorkSessionContinuationTransition,
  ): Promise<unknown> {
    return this.#rpc(name, {
      p_action: command.action,
      p_calendar_attempted_at:
        command.calendarAttemptedAt ?? null,
      p_calendar_checked_at:
        command.calendarCheckedAt ?? null,
      p_duration_minutes: command.durationMinutes ?? null,
      p_expected_stage: command.expectedStage,
      p_final_observation:
        command.finalObservation ?? null,
      p_intent_id: command.reference.id,
      p_is_recovery: command.isRecovery ?? null,
      p_next_stage: command.nextStage,
      p_options: command.options ?? null,
      p_owner_chat_id: command.chatId,
      p_owner_id: this.#ownerId,
      p_selected_end_at: command.selectedWindow?.endAt ?? null,
      p_selected_start_at: command.selectedWindow?.startAt ?? null,
      p_update_id: command.updateId,
      p_version: command.reference.version,
    });
  }

  async confirm(command: {
    attemptedAt: string;
    chatId: number;
    checkedAt: string | null;
    expectedStage: WorkSessionContinuationStage;
    finalObservation: "free" | "unavailable";
    reference: Readonly<{ id: string; version: number }>;
    status: "free" | "unverified";
    updateId: number;
  }) {
    const value = record(
      await this.#rpc("confirm_work_session_continuation_final_state", {
        p_calendar_attempted_at: command.attemptedAt,
        p_calendar_checked_at: command.checkedAt,
        p_calendar_status: command.status,
        p_expected_stage: command.expectedStage,
        p_final_observation: command.finalObservation,
        p_intent_id: command.reference.id,
        p_owner_chat_id: command.chatId,
        p_owner_id: this.#ownerId,
        p_update_id: command.updateId,
        p_version: command.reference.version,
      }),
    );
    if (
      !value ||
      !["applied", "expired", "replay", "stale"].includes(String(value.kind))
    ) {
      throw new Error("Continuation confirmation returned invalid data");
    }
    if (
      value.kind === "applied" &&
      (
        typeof value.workSessionId !== "string" ||
        !new RegExp(`^${UUID_PATTERN}$`).test(value.workSessionId)
      )
    ) {
      throw new Error("Continuation confirmation returned invalid data");
    }
    return value.kind === "applied"
      ? {
          kind: "applied" as const,
          workSessionId: value.workSessionId as string,
        }
      : { kind: value.kind as "expired" | "replay" | "stale" };
  }

  async #rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/${name}`,
      {
        body: JSON.stringify(body),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Continuation persistence failed");
    }
    return response.json();
  }
}

function button(
  snapshot: WorkSessionContinuationSnapshot,
  action: WorkSessionContinuationAction,
  text: string,
) {
  return {
    callbackData: workSessionContinuationActionReference(snapshot, action),
    text,
  };
}

function choices(
  snapshot: WorkSessionContinuationSnapshot,
  recovery = false,
): TelegramReply {
  return {
    actions: [
      ...snapshot.options.map((_, index) =>
        button(
          snapshot,
          `option_${index + 1}` as WorkSessionContinuationAction,
          `Choose option ${index + 1}`,
        )
      ),
      button(snapshot, "decline", "Not now"),
    ],
    text: [
      recovery ? workSessionContinuationCopy.recovery : "I found these available work windows.",
      ...snapshot.options.map(
        (window, index) =>
          `${index + 1}. ${formatSingaporeTarget(window.startAt)} to ${formatSingaporeTarget(window.endAt)}`,
      ),
      "Google Calendar will not be changed.",
    ].join("\n"),
  };
}

function findTimeOffer(
  snapshot: WorkSessionContinuationSnapshot,
): TelegramReply {
  return {
    actions: [
      button(snapshot, "another", "Find a time"),
      button(snapshot, "decline", "Not now"),
    ],
    text: workSessionContinuationCopy.remainingDuration,
  };
}

function finalConflictReply(
  snapshot: WorkSessionContinuationSnapshot,
): TelegramReply {
  return {
    actions: [
      button(snapshot, "check_again", "Check again"),
      button(snapshot, "decline", "Not now"),
    ],
    text: [
      workSessionContinuationCopy.conflict,
      "Google Calendar will not be changed.",
    ].join("\n"),
  };
}

function finalUnavailableReply(
  snapshot: WorkSessionContinuationSnapshot,
  authorizationExpired: boolean,
): TelegramReply {
  return {
    actions: [
      ...(authorizationExpired
        ? [button(snapshot, "reconnect", "Reconnect")]
        : []),
      button(snapshot, "check_again", "Check again"),
      button(
        snapshot,
        "save_unverified",
        "Save without Calendar check",
      ),
      button(snapshot, "decline", "Not now"),
    ],
    text: [
      workSessionContinuationCopy.calendarUnavailable,
      "You can retry or explicitly save without a Calendar check.",
      "Google Calendar will not be changed.",
    ].join("\n"),
  };
}

export class WorkSessionContinuationService {
  readonly #availability: WorkSessionContinuationAvailability;
  readonly #now: () => Date;
  readonly #repository: WorkSessionContinuationRepository;

  constructor(options: WorkSessionContinuationServiceOptions) {
    this.#availability = options.availability;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
  }

  async handleDurationInput(
    updateId: number,
    chatId: number,
    input: WorkSessionContinuationConversationInput,
  ): Promise<TelegramReply | null> {
    const reference = {
      id: input.intentId,
      version: input.intentVersion,
    };
    if (!isWorkSessionDuration(input.durationMinutes)) {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        reference,
        "invalid",
      ).catch(() => undefined);
      return { text: workSessionContinuationCopy.stale };
    }
    let read;
    try {
      read = await this.#repository.read(reference);
    } catch {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        reference,
        "domain_error",
      ).catch(() => undefined);
      return { text: workSessionContinuationCopy.uncertain };
    }
    if (read.kind === "expired") {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        reference,
        "expired",
      );
      return { text: workSessionContinuationCopy.expired };
    }
    if (
      read.kind !== "current" ||
      read.snapshot.stage !== "awaiting_duration"
    ) {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        reference,
        "stale",
      );
      return { text: workSessionContinuationCopy.stale };
    }
    try {
      const command = {
        action: "natural_duration" as const,
        chatId,
        durationMinutes: input.durationMinutes,
        expectedStage: "awaiting_duration" as const,
        nextStage: "offer" as const,
        reference,
        updateId,
      };
      const result =
        this.#repository.transitionFromConversation === undefined
          ? await this.#repository.transition(command)
          : await this.#repository.transitionFromConversation(command);
      return result.kind === "applied"
        ? findTimeOffer(result.snapshot)
        : result.kind === "replay"
          ? null
          : result.kind === "expired"
            ? { text: workSessionContinuationCopy.expired }
            : { text: workSessionContinuationCopy.stale };
    } catch {
      await this.#repository.finalizeConversation(
        updateId,
        chatId,
        reference,
        "domain_error",
      ).catch(() => undefined);
      return { text: workSessionContinuationCopy.uncertain };
    }
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const parsed = parseWorkSessionContinuationAction(callbackData);
    if (!parsed) {
      return { text: workSessionContinuationCopy.stale };
    }
    let read;
    try {
      read = await this.#repository.read(parsed);
    } catch {
      return { text: workSessionContinuationCopy.uncertain };
    }
    if (read.kind === "expired") {
      return { text: workSessionContinuationCopy.expired };
    }
    if (read.kind !== "current") {
      return { text: workSessionContinuationCopy.stale };
    }
    const snapshot = read.snapshot;
    if (
      parsed.action === "reconnect" &&
      snapshot.stage === "unverified_confirming"
    ) {
      return { text: workSessionContinuationCopy.reconnect };
    }
    if (parsed.action === "decline") {
      const result = await this.#transition({
        action: parsed.action,
        chatId,
        expectedStage: snapshot.stage,
        nextStage: "declined",
        reference: parsed,
        updateId,
      });
      return result?.kind === "applied"
        ? { text: workSessionContinuationCopy.declined }
        : result?.kind === "replay"
          ? null
          : result?.kind === "expired"
            ? { text: workSessionContinuationCopy.expired }
          : { text: workSessionContinuationCopy.stale };
    }
    if (parsed.action.startsWith("duration_")) {
      const duration = Number(
        parsed.action.slice("duration_".length),
      );
      if (
        !SUGGESTED_DURATIONS.includes(
          duration as (typeof SUGGESTED_DURATIONS)[number],
        ) ||
        snapshot.stage !== "awaiting_duration"
      ) {
        return { text: workSessionContinuationCopy.stale };
      }
      const result = await this.#transition({
        action: parsed.action,
        chatId,
        durationMinutes: duration,
        expectedStage: "awaiting_duration",
        nextStage: "offer",
        reference: parsed,
        updateId,
      });
      return result?.kind === "applied"
        ? findTimeOffer(result.snapshot)
        : result?.kind === "replay"
          ? null
          : result?.kind === "expired"
            ? { text: workSessionContinuationCopy.expired }
            : { text: workSessionContinuationCopy.stale };
    }
    if (parsed.action === "another") {
      if (!snapshot.durationMinutes || snapshot.stage !== "offer") {
        return { text: workSessionContinuationCopy.stale };
      }
      return this.#findAndPersist(
        updateId,
        chatId,
        parsed,
        snapshot,
        snapshot.durationMinutes,
      );
    }
    if (parsed.action === "option_1" || parsed.action === "option_2") {
      if (snapshot.stage !== "choosing") {
        return { text: workSessionContinuationCopy.stale };
      }
      const selected = snapshot.options[Number(parsed.action.at(-1)) - 1];
      if (!selected) {
        return { text: workSessionContinuationCopy.stale };
      }
      const result = await this.#transition({
        action: parsed.action,
        chatId,
        expectedStage: "choosing",
        nextStage: "confirming",
        reference: parsed,
        selectedWindow: selected,
        updateId,
      });
      if (!result || result.kind !== "applied") {
        return result?.kind === "replay"
          ? null
          : result?.kind === "expired"
            ? { text: workSessionContinuationCopy.expired }
          : { text: workSessionContinuationCopy.stale };
      }
      return {
        actions: [
          button(result.snapshot, "confirm", "Confirm"),
          button(result.snapshot, "decline", "Not now"),
        ],
        text: [
          `Schedule ${formatSingaporeTarget(selected.startAt)} to ${formatSingaporeTarget(selected.endAt)}?`,
          "I’ll check Calendar again before saving.",
          "Google Calendar will not be changed.",
        ].join("\n"),
      };
    }
    if (
      parsed.action === "confirm" &&
      snapshot.stage === "confirming"
    ) {
      return this.#confirm(updateId, chatId, parsed, snapshot);
    }
    if (
      parsed.action === "check_again" &&
      (
        snapshot.stage === "conflict_choice" ||
        snapshot.stage === "unverified_confirming"
      )
    ) {
      return this.#confirm(updateId, chatId, parsed, snapshot);
    }
    if (
      parsed.action === "save_unverified" &&
      snapshot.stage === "unverified_confirming" &&
      snapshot.calendarAttemptedAt &&
      snapshot.finalObservation === "unavailable"
    ) {
      return this.#persistConfirmedSession(
        updateId,
        chatId,
        parsed,
        snapshot,
        {
          checkedAt: null,
          finalObservation: "unavailable",
          status: "unverified",
        },
      );
    }
    return { text: workSessionContinuationCopy.stale };
  }

  async #findAndPersist(
    updateId: number,
    chatId: number,
    reference: ParsedContinuationAction,
    snapshot: WorkSessionContinuationSnapshot,
    durationMinutes: number,
  ): Promise<TelegramReply | null> {
    const now = this.#now().toISOString();
    let available = await this.#availability({
      durationMinutes,
      kind: "generated",
      now,
      targetAt: snapshot.targetAt,
      timingConstraints: snapshot.timingConstraints,
    });
    let isRecovery = false;
    if (
      available.status === "no_fit" &&
      Date.parse(now) < Date.parse(snapshot.targetAt)
    ) {
      available = await this.#availability({
        durationMinutes,
        kind: "recovery",
        now,
        targetAt: snapshot.targetAt,
        timingConstraints: snapshot.timingConstraints,
      });
      isRecovery = available.status === "available";
    }
    if (available.status !== "available" || available.alternatives.length === 0) {
      const result = await this.#transition({
        action: reference.action,
        chatId,
        durationMinutes,
        expectedStage: snapshot.stage,
        nextStage: "offer",
        reference,
        updateId,
      });
      if (result?.kind === "replay") {
        return null;
      }
      if (result?.kind === "expired") {
        return { text: workSessionContinuationCopy.expired };
      }
      if (!result || result.kind !== "applied") {
        return { text: workSessionContinuationCopy.stale };
      }
      return {
        text:
          available.status === "no_fit"
            ? workSessionContinuationCopy.noFit
            : workSessionContinuationCopy.calendarUnavailable,
      };
    }
    const result = await this.#transition({
      action: reference.action,
      chatId,
      durationMinutes,
      expectedStage: snapshot.stage,
      isRecovery,
      nextStage: "choosing",
      options: available.alternatives.slice(0, 2),
      reference,
      updateId,
    });
    return result?.kind === "applied"
      ? choices(result.snapshot, isRecovery)
      : result?.kind === "replay"
        ? null
          : result?.kind === "expired"
            ? { text: workSessionContinuationCopy.expired }
            : { text: workSessionContinuationCopy.stale };
  }

  async #confirm(
    updateId: number,
    chatId: number,
    reference: ParsedContinuationAction,
    snapshot: WorkSessionContinuationSnapshot,
  ): Promise<TelegramReply | null> {
    if (
      ![
        "confirming",
        "conflict_choice",
        "unverified_confirming",
      ].includes(snapshot.stage) ||
      !snapshot.selectedWindow ||
      !snapshot.durationMinutes
    ) {
      return { text: workSessionContinuationCopy.stale };
    }
    const attemptedAt = this.#now().toISOString();
    const availability = await this.#availability({
      durationMinutes: snapshot.durationMinutes,
      kind: "proposal",
      now: attemptedAt,
      proposedStartAt: snapshot.selectedWindow.startAt,
      targetAt: snapshot.targetAt,
      timingConstraints: snapshot.timingConstraints,
    });
    if (availability.status === "available" && availability.proposed) {
      if (
        availability.proposed.status === "free" &&
        availability.checkedAt
      ) {
        return this.#persistConfirmedSession(
          updateId,
          chatId,
          reference,
          snapshot,
          {
            attemptedAt,
            checkedAt: availability.checkedAt,
            finalObservation: "free",
            status: "free",
          },
        );
      }
      const result = await this.#transition({
        action: reference.action,
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: availability.checkedAt,
        chatId,
        expectedStage: snapshot.stage,
        finalObservation: "conflict",
        nextStage: "conflict_choice",
        reference,
        updateId,
      });
      return result?.kind === "applied"
        ? finalConflictReply(result.snapshot)
        : result?.kind === "replay"
          ? null
        : result?.kind === "expired"
          ? { text: workSessionContinuationCopy.expired }
          : { text: workSessionContinuationCopy.stale };
    }
    if (
      availability.status === "authorization_expired" ||
      availability.status === "provider_failure" ||
      availability.status === "unavailable"
    ) {
      const result = await this.#transition({
        action: reference.action,
        calendarAttemptedAt: attemptedAt,
        calendarCheckedAt: null,
        chatId,
        expectedStage: snapshot.stage,
        finalObservation: "unavailable",
        nextStage: "unverified_confirming",
        reference,
        updateId,
      });
      return result?.kind === "applied"
        ? finalUnavailableReply(
            result.snapshot,
            availability.status === "authorization_expired",
          )
        : result?.kind === "replay"
          ? null
          : result?.kind === "expired"
            ? { text: workSessionContinuationCopy.expired }
            : { text: workSessionContinuationCopy.stale };
    }
    return { text: workSessionContinuationCopy.stale };
  }

  async #persistConfirmedSession(
    updateId: number,
    chatId: number,
    reference: ParsedContinuationAction,
    snapshot: WorkSessionContinuationSnapshot,
    calendar: Readonly<{
      attemptedAt?: string;
      checkedAt: string | null;
      finalObservation: "free" | "unavailable";
      status: "free" | "unverified";
    }>,
  ): Promise<TelegramReply | null> {
    try {
      const result = await this.#repository.confirm({
        attemptedAt:
          calendar.attemptedAt ??
          snapshot.calendarAttemptedAt ??
          this.#now().toISOString(),
        chatId,
        checkedAt: calendar.checkedAt,
        expectedStage: snapshot.stage,
        finalObservation: calendar.finalObservation,
        reference,
        status: calendar.status,
        updateId,
      });
      if (result.kind === "replay") {
        return null;
      }
      if (result.kind === "expired") {
        return { text: workSessionContinuationCopy.expired };
      }
      return {
        text:
          result.kind === "applied"
            ? workSessionContinuationCopy.confirmed
            : workSessionContinuationCopy.stale,
      };
    } catch {
      return { text: workSessionContinuationCopy.uncertain };
    }
  }

  async #transition(command: WorkSessionContinuationTransition) {
    try {
      return await this.#repository.transition(command);
    } catch {
      return undefined;
    }
  }
}
