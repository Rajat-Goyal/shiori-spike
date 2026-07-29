import type { AgentInputItem } from "@openai/agents";
import { supabaseHeaders } from "../supabase.js";
import {
  AGENT_SESSION_HISTORY_PAGE_LIMIT,
  type AgentSdkSession,
} from "./session.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRODUCT_CONTEXT_LIMIT = 10;
const WORK_SESSION_LIMIT = 20;
const AMBIGUITY_CANDIDATE_LIMIT = 5;
const AMBIGUITY_STOP_WORDS = new Set([
  "and",
  "change",
  "friday",
  "edit",
  "for",
  "from",
  "make",
  "move",
  "monday",
  "one",
  "please",
  "reschedule",
  "set",
  "saturday",
  "sunday",
  "that",
  "the",
  "this",
  "thursday",
  "to",
  "today",
  "tomorrow",
  "tuesday",
  "update",
  "wednesday",
  "with",
]);

type DraftPhase =
  | "awaiting_definition"
  | "awaiting_target"
  | "complete";
type DraftMode =
  | "possible_work_session"
  | "simple_action"
  | "unresolved";
type CommitmentStatus = "active" | "cancelled" | "done";
type WorkSessionStatus =
  | "awaiting_check_in"
  | "cancelled"
  | "done"
  | "missed"
  | "more_work_needed"
  | "planned"
  | "started";
type OutcomeStatus =
  | "cancelled"
  | "done"
  | "missed"
  | "more_work_needed";
type WorkSessionPlanningStage =
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

export type AgentDraftPreparationContext = Readonly<{
  durationMinutes: number | null;
  selectedEndAt: string | null;
  selectedStartAt: string | null;
  stage: WorkSessionPlanningStage;
  timingConstraints: string | null;
}>;

export type AgentDraftContext = Readonly<{
  definitionOfDone: string | null;
  focused: boolean;
  id: string;
  mode: DraftMode;
  phase: DraftPhase;
  preparation?: AgentDraftPreparationContext | null;
  targetAt: string | null;
  version: number;
}>;

export type AgentCommitmentContext = Readonly<{
  definitionOfDone: string;
  id: string;
  preparationNeeded?: boolean;
  status: CommitmentStatus;
  targetAt: string;
  version: number;
}>;

export type AgentWorkSessionContext = Readonly<{
  calendarAttemptedAt?: string;
  calendarCheckedAt?: string | null;
  calendarStatus?: "conflict_kept" | "free" | "unverified";
  commitmentId: string;
  conflictConsent?: boolean;
  durationMinutes: number;
  endAt: string;
  finalCalendarObservation?: "conflict" | "free" | "unavailable";
  id: string;
  startAt: string;
  status: WorkSessionStatus;
  timingConstraints?: string;
}>;

export type AgentRecentOutcomeContext = Readonly<{
  commitmentId: string;
  occurredAt: string;
  status: OutcomeStatus;
  workSessionId: string;
}>;

export type AgentContinuationContext = Readonly<{
  commitmentId: string;
  durationMinutes: number | null;
  id: string;
  stage:
    | "awaiting_duration"
    | "choosing"
    | "confirming"
    | "conflict_choice"
    | "offer"
    | "unverified_confirming";
  targetAt: string;
  timingConstraints: string;
  version: number;
}>;

export type AgentFocusedEntity =
  | Readonly<{ entity: AgentDraftContext; kind: "draft" }>
  | Readonly<{ entity: AgentCommitmentContext; kind: "commitment" }>;

export type AgentAmbiguityCandidate = Readonly<{
  id: string;
  kind: "commitment" | "draft";
  label: string;
  version: number;
}>;

export type AgentProductContext = Readonly<{
  ambiguity: Readonly<{
    candidates: readonly AgentAmbiguityCandidate[];
    query: string;
  }> | null;
  commitments: readonly AgentCommitmentContext[];
  continuations?: readonly AgentContinuationContext[];
  drafts: readonly AgentDraftContext[];
  focusedEntity: AgentFocusedEntity | null;
  matchedEntity?: AgentFocusedEntity | null;
  recentOutcomes: readonly AgentRecentOutcomeContext[];
  truncated: Readonly<{
    commitments: boolean;
    drafts: boolean;
    recentOutcomes: boolean;
    workSessions: boolean;
  }>;
  workSessions: readonly AgentWorkSessionContext[];
}>;

export type AgentProductContextRequest = Readonly<{
  chatId: number;
  focusedEntityId: string | null;
  limit?: number;
  query: string | null;
}>;

export type AgentContextHistoryPage = Readonly<{
  items: readonly AgentInputItem[];
  nextCursor: string | null;
}>;

export interface AgentContextReader {
  readHistory(
    session: AgentSdkSession,
    cursor?: string,
    limit?: number,
  ): Promise<AgentContextHistoryPage>;
  readProductContext(
    request: AgentProductContextRequest,
  ): Promise<AgentProductContext>;
}

type SupabaseAgentContextReaderOptions = Readonly<{
  fetch?: typeof fetch;
  now?: () => Date;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

type RawProductContext = Readonly<{
  commitments: readonly unknown[];
  continuations: readonly unknown[];
  drafts: readonly unknown[];
  focusedEntity: unknown;
  recentOutcomes: readonly unknown[];
  truncated: unknown;
  workSessions: readonly unknown[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function definition(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 500
  );
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseDraft(
  value: unknown,
  observedAt: Date,
): AgentDraftContext | null {
  const item = record(value);
  const preparation =
    item?.preparation === null || item?.preparation === undefined
      ? null
      : record(item.preparation);
  if (
    !item ||
    !uuid(item.id) ||
    !positiveInteger(item.version) ||
    typeof item.focused !== "boolean" ||
    !oneOf(item.phase, [
      "awaiting_definition",
      "awaiting_target",
      "complete",
    ]) ||
    !oneOf(item.mode, [
      "possible_work_session",
      "simple_action",
      "unresolved",
    ]) ||
    !(
      item.definitionOfDone === null ||
      definition(item.definitionOfDone)
    ) ||
    !(item.targetAt === null || instant(item.targetAt)) ||
    !instant(item.expiresAt) ||
    (
      item.preparation !== undefined &&
      item.preparation !== null &&
      (
        preparation === null ||
        !oneOf(preparation.stage, [
          "availability_unavailable",
          "awaiting_constraints",
          "awaiting_duration_help",
          "awaiting_duration_owner",
          "awaiting_owner_time",
          "choosing",
          "commit_pending",
          "confirming",
          "conflict_choice",
          "conflict_confirming",
          "offer_help",
          "unverified_confirming",
        ]) ||
        !(
          preparation.durationMinutes === null ||
          (
            positiveInteger(preparation.durationMinutes) &&
            preparation.durationMinutes <= 1_440
          )
        ) ||
        !(
          preparation.timingConstraints === null ||
          (
            typeof preparation.timingConstraints === "string" &&
            preparation.timingConstraints.length > 0 &&
            preparation.timingConstraints.length <= 500
          )
        ) ||
        !(
          preparation.selectedStartAt === null ||
          instant(preparation.selectedStartAt)
        ) ||
        !(
          preparation.selectedEndAt === null ||
          instant(preparation.selectedEndAt)
        )
      )
    )
  ) {
    throw new Error("Agent draft context is invalid");
  }
  if (Date.parse(item.expiresAt) <= observedAt.getTime()) {
    return null;
  }
  return {
    definitionOfDone: item.definitionOfDone as string | null,
    focused: item.focused,
    id: item.id,
    mode: item.mode,
    phase: item.phase,
    ...(item.preparation === undefined
      ? {}
      : {
          preparation:
            preparation === null
              ? null
              : {
                  durationMinutes:
                    preparation.durationMinutes as number | null,
                  selectedEndAt:
                    preparation.selectedEndAt as string | null,
                  selectedStartAt:
                    preparation.selectedStartAt as string | null,
                  stage:
                    preparation.stage as WorkSessionPlanningStage,
                  timingConstraints:
                    preparation.timingConstraints as string | null,
                },
        }),
    targetAt: item.targetAt as string | null,
    version: item.version,
  };
}

function parseCommitment(value: unknown): AgentCommitmentContext {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    !positiveInteger(item.version) ||
    !definition(item.definitionOfDone) ||
    !oneOf(item.status, ["active", "cancelled", "done"]) ||
    !instant(item.targetAt) ||
    !(
      item.preparationNeeded === undefined ||
      typeof item.preparationNeeded === "boolean"
    )
  ) {
    throw new Error("Agent commitment context is invalid");
  }
  return {
    definitionOfDone: item.definitionOfDone,
    id: item.id,
    ...(typeof item.preparationNeeded === "boolean"
      ? { preparationNeeded: item.preparationNeeded }
      : {}),
    status: item.status,
    targetAt: item.targetAt,
    version: item.version,
  };
}

function parseWorkSession(value: unknown): AgentWorkSessionContext {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    !uuid(item.commitmentId) ||
    !oneOf(item.status, [
      "awaiting_check_in",
      "cancelled",
      "done",
      "missed",
      "more_work_needed",
      "planned",
      "started",
    ]) ||
    !instant(item.startAt) ||
    !instant(item.endAt) ||
    Date.parse(item.endAt) <= Date.parse(item.startAt) ||
    !positiveInteger(item.durationMinutes) ||
    item.durationMinutes > 1_440 ||
    !(
      item.timingConstraints === undefined ||
      (
        typeof item.timingConstraints === "string" &&
        item.timingConstraints.trim().length > 0 &&
        item.timingConstraints.length <= 500
      )
    ) ||
    !(
      item.calendarStatus === undefined ||
      oneOf(item.calendarStatus, [
        "conflict_kept",
        "free",
        "unverified",
      ])
    ) ||
    !(
      item.calendarAttemptedAt === undefined ||
      instant(item.calendarAttemptedAt)
    ) ||
    !(
      item.calendarCheckedAt === undefined ||
      item.calendarCheckedAt === null ||
      instant(item.calendarCheckedAt)
    ) ||
    !(
      item.conflictConsent === undefined ||
      typeof item.conflictConsent === "boolean"
    ) ||
    !(
      item.finalCalendarObservation === undefined ||
      oneOf(item.finalCalendarObservation, [
        "conflict",
        "free",
        "unavailable",
      ])
    )
  ) {
    throw new Error("Agent work-session context is invalid");
  }
  return {
    ...(item.calendarAttemptedAt === undefined
      ? {}
      : { calendarAttemptedAt: item.calendarAttemptedAt as string }),
    ...(item.calendarCheckedAt === undefined
      ? {}
      : {
          calendarCheckedAt:
            item.calendarCheckedAt as string | null,
        }),
    ...(item.calendarStatus === undefined
      ? {}
      : {
          calendarStatus:
            item.calendarStatus as AgentWorkSessionContext["calendarStatus"],
        }),
    commitmentId: item.commitmentId,
    ...(item.conflictConsent === undefined
      ? {}
      : { conflictConsent: item.conflictConsent as boolean }),
    durationMinutes: item.durationMinutes,
    endAt: item.endAt,
    id: item.id,
    ...(item.finalCalendarObservation === undefined
      ? {}
      : {
          finalCalendarObservation:
            item.finalCalendarObservation as AgentWorkSessionContext["finalCalendarObservation"],
        }),
    startAt: item.startAt,
    status: item.status,
    ...(item.timingConstraints === undefined
      ? {}
      : { timingConstraints: item.timingConstraints as string }),
  };
}

function parseOutcome(value: unknown): AgentRecentOutcomeContext {
  const item = record(value);
  if (
    !item ||
    !uuid(item.commitmentId) ||
    !uuid(item.workSessionId) ||
    !oneOf(item.status, [
      "cancelled",
      "done",
      "missed",
      "more_work_needed",
    ]) ||
    !instant(item.occurredAt)
  ) {
    throw new Error("Agent recent-outcome context is invalid");
  }
  return {
    commitmentId: item.commitmentId,
    occurredAt: item.occurredAt,
    status: item.status,
    workSessionId: item.workSessionId,
  };
}

function parseContinuation(value: unknown): AgentContinuationContext {
  const item = record(value);
  if (
    !item ||
    !uuid(item.id) ||
    !uuid(item.commitmentId) ||
    !positiveInteger(item.version) ||
    !oneOf(item.stage, [
      "awaiting_duration",
      "choosing",
      "confirming",
      "conflict_choice",
      "offer",
      "unverified_confirming",
    ]) ||
    !(
      item.durationMinutes === null ||
      (
        positiveInteger(item.durationMinutes) &&
        item.durationMinutes <= 1_440
      )
    ) ||
    !instant(item.targetAt) ||
    typeof item.timingConstraints !== "string" ||
    item.timingConstraints.length < 1 ||
    item.timingConstraints.length > 500
  ) {
    throw new Error("Agent continuation context is invalid");
  }
  return {
    commitmentId: item.commitmentId,
    durationMinutes: item.durationMinutes as number | null,
    id: item.id,
    stage: item.stage as AgentContinuationContext["stage"],
    targetAt: item.targetAt,
    timingConstraints: item.timingConstraints,
    version: item.version,
  };
}

function parseTruncated(value: unknown): AgentProductContext["truncated"] {
  const item = record(value);
  if (
    !item ||
    typeof item.commitments !== "boolean" ||
    typeof item.drafts !== "boolean" ||
    typeof item.recentOutcomes !== "boolean" ||
    typeof item.workSessions !== "boolean"
  ) {
    throw new Error("Agent context truncation data is invalid");
  }
  return {
    commitments: item.commitments,
    drafts: item.drafts,
    recentOutcomes: item.recentOutcomes,
    workSessions: item.workSessions,
  };
}

function parseFocusedEntity(
  value: unknown,
  observedAt: Date,
): AgentFocusedEntity | null {
  if (value === null) {
    return null;
  }
  const item = record(value);
  if (!item || !oneOf(item.kind, ["commitment", "draft"])) {
    throw new Error("Agent focused entity is invalid");
  }
  if (item.kind === "draft") {
    const draft = parseDraft(item.entity, observedAt);
    return draft === null ? null : { entity: draft, kind: "draft" };
  }
  return {
    entity: parseCommitment(item.entity),
    kind: "commitment",
  };
}

function parseRawProductContext(value: unknown): RawProductContext {
  const item = record(value);
  if (
    !item ||
    !Array.isArray(item.drafts) ||
    !Array.isArray(item.commitments) ||
    !Array.isArray(item.workSessions) ||
    !Array.isArray(item.recentOutcomes)
  ) {
    throw new Error("Supabase agent context read returned invalid data");
  }
  return {
    commitments: item.commitments,
    continuations: Array.isArray(item.continuations)
      ? item.continuations
      : [],
    drafts: item.drafts,
    focusedEntity: item.focusedEntity,
    recentOutcomes: item.recentOutcomes,
    truncated: item.truncated,
    workSessions: item.workSessions,
  };
}

function normalizedQuery(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLocaleLowerCase("en");
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error("Agent context query is invalid");
  }
  return normalized;
}

function referenceMatch(
  query: string | null,
  drafts: readonly AgentDraftContext[],
  commitments: readonly AgentCommitmentContext[],
): Readonly<{
  ambiguity: AgentProductContext["ambiguity"];
  exact: AgentFocusedEntity | null;
}> {
  const normalized = normalizedQuery(query);
  if (normalized === null) {
    return { ambiguity: null, exact: null };
  }
  const queryTokens = new Set(
    normalized
      .match(/[a-z0-9]+/g)
      ?.filter(
        (token) =>
          token.length >= 3 && !AMBIGUITY_STOP_WORDS.has(token),
      ) ?? [],
  );
  const score = (label: string): number => {
    const normalizedLabel = label.toLocaleLowerCase("en");
    const labelTokens = new Set(
      (normalizedLabel.match(/[a-z0-9]+/g) ?? []).filter(
        (token) =>
          token.length >= 3 && !AMBIGUITY_STOP_WORDS.has(token),
      ),
    );
    return [...queryTokens].filter((token) => labelTokens.has(token))
      .length;
  };
  const scored: Array<{
    candidate: AgentAmbiguityCandidate;
    score: number;
  }> = [
    ...drafts
      .filter(
        (draft) =>
          draft.definitionOfDone !== null,
      )
      .map((draft) => ({
        candidate: {
          id: draft.id,
          kind: "draft" as const,
          label: draft.definitionOfDone as string,
          version: draft.version,
        },
        score: score(draft.definitionOfDone as string),
      })),
    ...commitments
      .map((commitment) => ({
        candidate: {
          id: commitment.id,
          kind: "commitment" as const,
          label: commitment.definitionOfDone,
          version: commitment.version,
        },
        score: score(commitment.definitionOfDone),
      })),
  ];
  const highest = Math.max(0, ...scored.map((item) => item.score));
  const candidates = scored
    .filter((item) => highest > 0 && item.score === highest)
    .slice(0, AMBIGUITY_CANDIDATE_LIMIT)
    .map((item) => item.candidate);
  if (candidates.length > 1) {
    return {
      ambiguity: { candidates, query: normalized },
      exact: null,
    };
  }
  if (candidates.length === 0) {
    return { ambiguity: null, exact: null };
  }
  const candidate = candidates[0]!;
  return {
    ambiguity: null,
    exact:
      candidate.kind === "draft"
        ? {
            entity: drafts.find((draft) => draft.id === candidate.id)!,
            kind: "draft",
          }
        : {
            entity: commitments.find(
              (commitment) => commitment.id === candidate.id,
            )!,
            kind: "commitment",
          },
  };
}

function boundedLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? maximum;
  if (!positiveInteger(limit) || limit > maximum) {
    throw new Error(`Agent context limit must be between 1 and ${maximum}`);
  }
  return limit;
}

export class SupabaseAgentContextReader implements AgentContextReader {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #ownerId: number;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseAgentContextReaderOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#ownerId = options.ownerId;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async readHistory(
    session: AgentSdkSession,
    cursor?: string,
    limit?: number,
  ): Promise<AgentContextHistoryPage> {
    if (session.chatId !== this.#ownerId) {
      throw new Error("Agent context read is not authorized");
    }
    const page = await session.readHistory(
      cursor,
      boundedLimit(limit, AGENT_SESSION_HISTORY_PAGE_LIMIT),
    );
    return {
      items: page.items.map(({ item }) => item),
      nextCursor: page.nextCursor,
    };
  }

  async readProductContext(
    request: AgentProductContextRequest,
  ): Promise<AgentProductContext> {
    if (request.chatId !== this.#ownerId) {
      throw new Error("Agent context read is not authorized");
    }
    if (
      request.focusedEntityId !== null &&
      !uuid(request.focusedEntityId)
    ) {
      throw new Error("Agent focused entity id is invalid");
    }
    const limit = boundedLimit(request.limit, PRODUCT_CONTEXT_LIMIT);
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/read_agent_product_context`,
      {
        body: JSON.stringify({
          p_focused_entity_id: request.focusedEntityId,
          p_limit: limit,
          p_owner_id: String(this.#ownerId),
        }),
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
        `Supabase agent context read failed with HTTP ${response.status}`,
      );
    }
    const raw = parseRawProductContext(await response.json());
    const observedAt = this.#now();
    if (!Number.isFinite(observedAt.getTime())) {
      throw new Error("Agent context observation time is invalid");
    }
    const drafts = raw.drafts
      .map((draft) => parseDraft(draft, observedAt))
      .filter((draft): draft is AgentDraftContext => draft !== null);
    const commitments = raw.commitments.map(parseCommitment);
    const continuations = raw.continuations.map(parseContinuation);
    const workSessions = raw.workSessions.map(parseWorkSession);
    const recentOutcomes = raw.recentOutcomes.map(parseOutcome);
    if (
      drafts.length > limit ||
      commitments.length > limit ||
      continuations.length > Math.min(5, limit) ||
      workSessions.length > Math.min(WORK_SESSION_LIMIT, limit * 2) ||
      recentOutcomes.length > limit
    ) {
      throw new Error("Supabase agent context read exceeded its bounds");
    }
    const match = referenceMatch(request.query, drafts, commitments);
    return {
      ambiguity: match.ambiguity,
      commitments,
      continuations,
      drafts,
      focusedEntity: parseFocusedEntity(raw.focusedEntity, observedAt),
      matchedEntity: match.exact,
      recentOutcomes,
      truncated: parseTruncated(raw.truncated),
      workSessions,
    };
  }
}
