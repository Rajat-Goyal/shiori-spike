import { supabaseHeaders } from "./supabase.js";
import {
  isWorkSessionDuration,
  isWorkSessionWindow,
} from "./work-sessions/duration.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const deliveryLabels = {
  cancelled: "Cancelled before delivery",
  claimed: "Sending",
  delivered: "Delivered",
  delivery_unknown: "Delivery uncertain",
  pending: "Scheduled",
  permanent_failure: "Not delivered",
  retryable_failure: "Retry limit reached",
} as const;

const sessionLabels = {
  cancelled: "Cancelled",
  done: "Done",
  missed: "Missed",
  more_work_needed: "More work needed",
} as const;

const eventLabels = {
  "commitment.cancelled": "Promise cancelled",
  "commitment.created": "Promise created",
  "commitment.done": "Promise completed",
  "scheduled_message.cancelled": "Notification cancelled",
  "scheduled_message.created": "Notification scheduled",
  "scheduled_message.delivered": "Notification delivered",
  "scheduled_message.delivery_attempt":
    "Notification delivery attempted",
  "scheduled_message.delivery_unknown":
    "Notification delivery uncertain",
  "scheduled_message.permanent_failure": "Notification not delivered",
  "scheduled_message.retry_exhausted":
    "Notification retry limit reached",
  "scheduled_message.retry_scheduled": "Notification retry scheduled",
  "work_session.cancelled": "Work session cancelled",
  "work_session.continuation_declined":
    "Another work session declined",
  "work_session.created": "Work session scheduled",
  "work_session.done": "Work session completed",
  "work_session.missed": "Missed session recorded",
  "work_session.more_work_needed": "More work needed recorded",
  "work_session.started": "Work session started",
} as const;

type DeliveryKind =
  | "simple_reminder"
  | "work_session_end"
  | "work_session_start";
type DeliveryState = keyof typeof deliveryLabels;
type SessionTerminalStatus = keyof typeof sessionLabels;
type EventType = keyof typeof eventLabels;

export type DashboardDelivery = Readonly<{
  dueAt: string;
  kind: DeliveryKind;
  label: (typeof deliveryLabels)[DeliveryState];
  state: DeliveryState;
}>;

export type DashboardCalendarStatus =
  | Readonly<{
      attemptedAt: null;
      checkedAt: null;
      kind: "not_needed";
      label: "Calendar check not needed";
    }>
  | Readonly<{
      attemptedAt: string;
      checkedAt: string;
      kind: "conflict_kept" | "free";
      label: "Conflict kept when checked" | "Free when checked";
    }>
  | Readonly<{
      attemptedAt: string;
      checkedAt: null;
      kind: "unverified";
      label: "Saved without a Calendar check";
    }>;

export type DashboardCommitment = Readonly<{
  calendar: DashboardCalendarStatus;
  definitionOfDone: string;
  deliveries: readonly DashboardDelivery[];
  expectedDurationMinutes: number | null;
  id: string;
  next: Readonly<{
    at: string | null;
    kind:
      | "continuation_choice"
      | "continuation_duration"
      | "none"
      | "session_end"
      | "session_outcome"
      | "simple_reminder"
      | "work_session"
      | "work_session_choice"
      | "work_session_confirmation";
    label:
      | "Continuation decision needed"
      | "No next action scheduled"
      | "Remaining duration needed"
      | "Session outcome needed"
      | "Simple reminder"
      | "Work session ends"
      | "Work session starts"
      | "Work-session choice needed"
      | "Work-session confirmation needed";
  }>;
  status: "active";
  targetAt: string;
}>;

export type DashboardSessionHistory = Readonly<{
  commitmentId: string;
  definitionOfDone: string;
  sessions: readonly Readonly<{
    durationMinutes: number;
    endAt: string;
    id: string;
    isRecovery: boolean;
    label: (typeof sessionLabels)[SessionTerminalStatus];
    outcomeAt: string;
    sequenceNumber: number;
    startAt: string;
    status: SessionTerminalStatus;
  }>[];
  truncated: boolean;
}>;

export type DashboardTerminalCommitment = Readonly<{
  definitionOfDone: string;
  id: string;
  label: "Cancelled" | "Completed";
  status: "cancelled" | "done";
  targetAt: string;
  terminalAt: string;
}>;

export type DashboardEvent = Readonly<{
  actor: "owner" | "system";
  commitmentId: string;
  definitionOfDone: string;
  eventType: EventType;
  id: string;
  label: (typeof eventLabels)[EventType];
  occurredAt: string;
}>;

export type DashboardSummary = Readonly<{
  commitments: readonly DashboardCommitment[];
  counts: Readonly<{
    active: number;
    dueToday: number;
    overdue: number;
  }>;
  events: readonly DashboardEvent[];
  sessionHistory: readonly DashboardSessionHistory[];
  terminalCommitments: readonly DashboardTerminalCommitment[];
  updatedAt: string;
}>;

export interface DashboardRepository {
  readSummary(): Promise<DashboardSummary>;
}

type SupabaseDashboardRepositoryOptions = {
  fetch?: typeof fetch;
  now?: () => Date;
  ownerId: number;
  ownerTimeZone: string;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

type RawDelivery = Readonly<{
  dueAt: string;
  id: string;
  kind: DeliveryKind;
  state: DeliveryState;
}>;

type RawSession = Readonly<{
  calendarAttemptedAt: string;
  calendarCheckedAt: string | null;
  calendarStatus: "conflict_kept" | "free" | "unverified";
  conflictConsent: boolean;
  durationMinutes: number;
  endAt: string;
  finalCalendarObservation: "conflict" | "free" | "unavailable";
  id: string;
  isRecovery: boolean;
  outcomeAt: string | null;
  sequenceNumber: number;
  startAt: string;
  status:
    | "awaiting_check_in"
    | "cancelled"
    | "done"
    | "missed"
    | "more_work_needed"
    | "planned"
    | "started";
}>;

type RawContinuation = Readonly<{
  id: string;
  stage: "awaiting_duration" | "choosing" | "confirming" | "offer";
  version: number;
}>;

type RawActiveCommitment = Readonly<{
  continuation: RawContinuation | null;
  currentSession: RawSession | null;
  definitionOfDone: string;
  deliveries: readonly RawDelivery[];
  id: string;
  targetAt: string;
}>;

type RawSessionHistory = Readonly<{
  commitmentId: string;
  definitionOfDone: string;
  durationMinutes: number;
  endAt: string;
  id: string;
  isRecovery: boolean;
  outcomeAt: string;
  sequenceNumber: number;
  startAt: string;
  status: SessionTerminalStatus;
  totalForCommitment: number;
}>;

type RawDashboardSummary = Readonly<{
  activeCommitments: readonly RawActiveCommitment[];
  events: readonly Omit<DashboardEvent, "label">[];
  sessionHistoryRows: readonly RawSessionHistory[];
  terminalCommitments: readonly Omit<
    DashboardTerminalCommitment,
    "label"
  >[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function definition(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 500
  );
}

function rawDelivery(value: unknown): RawDelivery {
  if (
    !isRecord(value) ||
    !uuid(value.id) ||
    !oneOf(value.kind, [
      "simple_reminder",
      "work_session_end",
      "work_session_start",
    ]) ||
    !instant(value.dueAt) ||
    !oneOf(value.state, Object.keys(deliveryLabels) as DeliveryState[])
  ) {
    throw new Error("Dashboard delivery data is invalid");
  }
  return value as RawDelivery;
}

function rawSession(value: unknown): RawSession {
  if (
    !isRecord(value) ||
    !uuid(value.id) ||
    !positiveInteger(value.sequenceNumber) ||
    !oneOf(value.status, [
      "awaiting_check_in",
      "cancelled",
      "done",
      "missed",
      "more_work_needed",
      "planned",
      "started",
    ]) ||
    !instant(value.startAt) ||
    !instant(value.endAt) ||
    Date.parse(value.endAt) <= Date.parse(value.startAt) ||
    !isWorkSessionDuration(value.durationMinutes) ||
    !isWorkSessionWindow(
      value.startAt,
      value.endAt,
      value.durationMinutes,
    ) ||
    !oneOf(value.calendarStatus, [
      "conflict_kept",
      "free",
      "unverified",
    ]) ||
    !instant(value.calendarAttemptedAt) ||
    !(
      value.calendarCheckedAt === null ||
      instant(value.calendarCheckedAt)
    ) ||
    typeof value.conflictConsent !== "boolean" ||
    !oneOf(value.finalCalendarObservation, [
      "conflict",
      "free",
      "unavailable",
    ]) ||
    !(
      value.outcomeAt === null ||
      instant(value.outcomeAt)
    ) ||
    typeof value.isRecovery !== "boolean"
  ) {
    throw new Error("Dashboard work-session data is invalid");
  }
  return value as RawSession;
}

function rawContinuation(value: unknown): RawContinuation {
  if (
    !isRecord(value) ||
    !uuid(value.id) ||
    !positiveInteger(value.version) ||
    !oneOf(value.stage, [
      "awaiting_duration",
      "choosing",
      "confirming",
      "offer",
    ])
  ) {
    throw new Error("Dashboard continuation data is invalid");
  }
  return value as RawContinuation;
}

function parseRawSummary(value: unknown): RawDashboardSummary {
  if (
    !isRecord(value) ||
    !Array.isArray(value.activeCommitments) ||
    !Array.isArray(value.sessionHistoryRows) ||
    !Array.isArray(value.terminalCommitments) ||
    !Array.isArray(value.events)
  ) {
    throw new Error("Supabase dashboard read returned an invalid response");
  }

  const activeCommitments = value.activeCommitments.map((item) => {
    if (
      !isRecord(item) ||
      !uuid(item.id) ||
      !definition(item.definitionOfDone) ||
      !instant(item.targetAt) ||
      !Array.isArray(item.deliveries)
    ) {
      throw new Error("Dashboard active commitment data is invalid");
    }
    return {
      continuation:
        item.continuation === null
          ? null
          : rawContinuation(item.continuation),
      currentSession:
        item.currentSession === null
          ? null
          : rawSession(item.currentSession),
      definitionOfDone: item.definitionOfDone,
      deliveries: item.deliveries.map(rawDelivery),
      id: item.id,
      targetAt: item.targetAt,
    } satisfies RawActiveCommitment;
  });

  const sessionHistoryRows = value.sessionHistoryRows.map((item) => {
    if (
      !isRecord(item) ||
      !uuid(item.id) ||
      !uuid(item.commitmentId) ||
      !definition(item.definitionOfDone) ||
      !positiveInteger(item.sequenceNumber) ||
      !oneOf(
        item.status,
        Object.keys(sessionLabels) as SessionTerminalStatus[],
      ) ||
      !instant(item.startAt) ||
      !instant(item.endAt) ||
      !positiveInteger(item.durationMinutes) ||
      !instant(item.outcomeAt) ||
      typeof item.isRecovery !== "boolean" ||
      !positiveInteger(item.totalForCommitment)
    ) {
      throw new Error("Dashboard session history data is invalid");
    }
    return item as RawSessionHistory;
  });

  const terminalCommitments = value.terminalCommitments.map((item) => {
    if (
      !isRecord(item) ||
      !uuid(item.id) ||
      !definition(item.definitionOfDone) ||
      !instant(item.targetAt) ||
      !oneOf(item.status, ["cancelled", "done"]) ||
      !instant(item.terminalAt)
    ) {
      throw new Error("Dashboard terminal commitment data is invalid");
    }
    return item as Omit<DashboardTerminalCommitment, "label">;
  });

  const events = value.events.map((item) => {
    if (
      !isRecord(item) ||
      !uuid(item.id) ||
      !uuid(item.commitmentId) ||
      !definition(item.definitionOfDone) ||
      !oneOf(item.eventType, Object.keys(eventLabels) as EventType[]) ||
      !oneOf(item.actor, ["owner", "system"]) ||
      !instant(item.occurredAt)
    ) {
      throw new Error("Dashboard event data is invalid");
    }
    return item as Omit<DashboardEvent, "label">;
  });

  return {
    activeCommitments,
    events,
    sessionHistoryRows,
    terminalCommitments,
  };
}

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function calendarStatus(
  session: RawSession | null,
): DashboardCalendarStatus {
  if (!session) {
    return {
      attemptedAt: null,
      checkedAt: null,
      kind: "not_needed",
      label: "Calendar check not needed",
    };
  }
  if (session.calendarStatus === "unverified") {
    if (session.calendarCheckedAt !== null) {
      throw new Error("Unverified Calendar status has a check time");
    }
    return {
      attemptedAt: session.calendarAttemptedAt,
      checkedAt: null,
      kind: "unverified",
      label: "Saved without a Calendar check",
    };
  }
  if (!session.calendarCheckedAt) {
    throw new Error("Checked Calendar status is missing its check time");
  }
  return {
    attemptedAt: session.calendarAttemptedAt,
    checkedAt: session.calendarCheckedAt,
    kind: session.calendarStatus,
    label:
      session.calendarStatus === "free"
        ? "Free when checked"
        : "Conflict kept when checked",
  };
}

function nextAction(
  commitment: RawActiveCommitment,
): DashboardCommitment["next"] {
  const session = commitment.currentSession;
  if (session?.status === "planned") {
    return {
      at: session.startAt,
      kind: "work_session",
      label: "Work session starts",
    };
  }
  if (session?.status === "started") {
    return {
      at: session.endAt,
      kind: "session_end",
      label: "Work session ends",
    };
  }
  if (session?.status === "awaiting_check_in") {
    return {
      at: null,
      kind: "session_outcome",
      label: "Session outcome needed",
    };
  }
  const continuation = commitment.continuation;
  if (continuation?.stage === "awaiting_duration") {
    return {
      at: null,
      kind: "continuation_duration",
      label: "Remaining duration needed",
    };
  }
  if (continuation?.stage === "offer") {
    return {
      at: null,
      kind: "continuation_choice",
      label: "Continuation decision needed",
    };
  }
  if (continuation?.stage === "choosing") {
    return {
      at: null,
      kind: "work_session_choice",
      label: "Work-session choice needed",
    };
  }
  if (continuation?.stage === "confirming") {
    return {
      at: null,
      kind: "work_session_confirmation",
      label: "Work-session confirmation needed",
    };
  }
  const reminder = commitment.deliveries.find(
    (delivery) =>
      delivery.kind === "simple_reminder" &&
      ["claimed", "pending"].includes(delivery.state),
  );
  return reminder
    ? {
        at: reminder.dueAt,
        kind: "simple_reminder",
        label: "Simple reminder",
      }
    : {
        at: null,
        kind: "none",
        label: "No next action scheduled",
      };
}

function sessionHistory(
  rows: readonly RawSessionHistory[],
): readonly DashboardSessionHistory[] {
  const groups = new Map<
    string,
    {
      commitmentId: string;
      definitionOfDone: string;
      sessions: DashboardSessionHistory["sessions"][number][];
      total: number;
    }
  >();
  for (const row of rows) {
    const group = groups.get(row.commitmentId) ?? {
      commitmentId: row.commitmentId,
      definitionOfDone: row.definitionOfDone,
      sessions: [],
      total: row.totalForCommitment,
    };
    group.sessions.push({
      durationMinutes: row.durationMinutes,
      endAt: row.endAt,
      id: row.id,
      isRecovery: row.isRecovery,
      label: sessionLabels[row.status],
      outcomeAt: row.outcomeAt,
      sequenceNumber: row.sequenceNumber,
      startAt: row.startAt,
      status: row.status,
    });
    group.total = row.totalForCommitment;
    groups.set(row.commitmentId, group);
  }
  return [...groups.values()].map((group) => ({
    commitmentId: group.commitmentId,
    definitionOfDone: group.definitionOfDone,
    sessions: group.sessions,
    truncated: group.total > group.sessions.length,
  }));
}

export class SupabaseDashboardRepository implements DashboardRepository {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #ownerId: string;
  readonly #ownerTimeZone: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseDashboardRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#ownerId = String(options.ownerId);
    this.#ownerTimeZone = options.ownerTimeZone;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async readSummary(): Promise<DashboardSummary> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/read_dashboard_summary`,
      {
        body: JSON.stringify({ p_owner_id: this.#ownerId }),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Supabase dashboard read failed with HTTP ${response.status}`,
      );
    }
    const raw = parseRawSummary(await response.json());
    const updatedAt = this.#now();
    const today = dateKey(updatedAt, this.#ownerTimeZone);
    let dueToday = 0;
    let overdue = 0;
    const commitments = raw.activeCommitments
      .map(
        (commitment): DashboardCommitment => ({
          calendar: calendarStatus(commitment.currentSession),
          definitionOfDone: commitment.definitionOfDone,
          deliveries: commitment.deliveries.map((delivery) => ({
            dueAt: delivery.dueAt,
            kind: delivery.kind,
            label: deliveryLabels[delivery.state],
            state: delivery.state,
          })),
          expectedDurationMinutes:
            commitment.currentSession?.durationMinutes ?? null,
          id: commitment.id,
          next: nextAction(commitment),
          status: "active",
          targetAt: commitment.targetAt,
        }),
      )
      .sort(
        (left, right) =>
          Date.parse(left.targetAt) - Date.parse(right.targetAt) ||
          left.id.localeCompare(right.id),
      );

    for (const commitment of commitments) {
      if (
        dateKey(new Date(commitment.targetAt), this.#ownerTimeZone) ===
        today
      ) {
        dueToday += 1;
      }
      if (Date.parse(commitment.targetAt) < updatedAt.getTime()) {
        overdue += 1;
      }
    }

    return {
      commitments,
      counts: {
        active: commitments.length,
        dueToday,
        overdue,
      },
      events: raw.events.map((event) => ({
        ...event,
        label: eventLabels[event.eventType],
      })),
      sessionHistory: sessionHistory(raw.sessionHistoryRows),
      terminalCommitments: raw.terminalCommitments.map((commitment) => ({
        ...commitment,
        label: commitment.status === "done" ? "Completed" : "Cancelled",
      })),
      updatedAt: updatedAt.toISOString(),
    };
  }
}
