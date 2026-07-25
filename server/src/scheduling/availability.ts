const OWNER_TIME_ZONE_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1_000;
const HALF_HOUR_MILLISECONDS = 30 * 60 * 1_000;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const GENERATED_CAP_MILLISECONDS = 14 * DAY_MILLISECONDS;
const RECOVERY_CAP_MILLISECONDS = 7 * DAY_MILLISECONDS;
const SUPPORTED_DURATIONS = [30, 60, 90, 120] as const;

export type WorkSessionDuration = (typeof SUPPORTED_DURATIONS)[number];

export type WorkWindow = Readonly<{
  endAt: string;
  startAt: string;
}>;

export type NormalizedEffectiveDay = Readonly<{
  date: string;
  windows: readonly Readonly<{
    endTime: string;
    startTime: string;
  }>[];
}>;

type AvailabilityRequestBase = Readonly<{
  durationMinutes: number;
  effectiveDays?: readonly NormalizedEffectiveDay[];
  now: string;
  targetAt: string;
}>;

export type AvailabilityRequest =
  | (AvailabilityRequestBase & Readonly<{ kind: "generated" }>)
  | (AvailabilityRequestBase &
      Readonly<{ kind: "proposal"; proposedStartAt: string }>)
  | (AvailabilityRequestBase & Readonly<{ kind: "recovery" }>);

export type BusyInterval = Readonly<{
  endAt: string;
  startAt: string;
}>;

export type BusyIntervalReadResult =
  | Readonly<{
      busyIntervals: readonly BusyInterval[];
      checkedAt: string;
      status: "ok";
    }>
  | Readonly<{
      status: "authorization_expired" | "provider_failure" | "unavailable";
    }>;

export type BusyIntervalReader = (
  range: WorkWindow,
) => Promise<BusyIntervalReadResult>;

type ProposedResult = Readonly<{
  status: "conflict" | "free";
  window: WorkWindow;
}>;

export type AvailabilityResult =
  | Readonly<{
      alternatives: readonly WorkWindow[];
      checkedAt: string | null;
      proposed: ProposedResult | null;
      status: "available";
    }>
  | Readonly<{
      alternatives: readonly [];
      checkedAt: string | null;
      proposed: ProposedResult | null;
      status: "no_fit";
    }>
  | Readonly<{
      reason:
        | "invalid_duration"
        | "invalid_effective_days"
        | "invalid_range"
        | "invalid_proposal"
        | "recovery_not_due";
      status: "invalid_request";
    }>
  | Readonly<{
      status: "authorization_expired" | "provider_failure" | "unavailable";
    }>;

type EffectiveWindow = Readonly<{
  endMinute: number;
  startMinute: number;
}>;

type ValidatedBase = Readonly<{
  duration: WorkSessionDuration;
  durationMilliseconds: number;
  effectiveDays: ReadonlyMap<string, readonly EffectiveWindow[]>;
  nowMillis: number;
  targetMillis: number;
}>;

type MillisecondInterval = {
  endMillis: number;
  startMillis: number;
};

function parsedInstant(value: string): number | undefined {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

function localDate(millis: number): string {
  return new Date(millis + OWNER_TIME_ZONE_OFFSET_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

function localMinute(millis: number): number {
  const local = new Date(millis + OWNER_TIME_ZONE_OFFSET_MILLISECONDS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function singaporeInstant(millis: number): string {
  return `${new Date(millis + OWNER_TIME_ZONE_OFFSET_MILLISECONDS)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

function roundedUpBoundary(millis: number): number {
  return Math.ceil(millis / HALF_HOUR_MILLISECONDS) * HALF_HOUR_MILLISECONDS;
}

function boundaryStart(millis: number): boolean {
  const local = new Date(millis + OWNER_TIME_ZONE_OFFSET_MILLISECONDS);
  return (
    local.getUTCSeconds() === 0 &&
    local.getUTCMilliseconds() === 0 &&
    (local.getUTCMinutes() === 0 || local.getUTCMinutes() === 30)
  );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function timeMinute(value: string, allowMidnight: boolean): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (allowMidnight && hour === 24 && minute === 0) {
    return 24 * 60;
  }
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : undefined;
}

function effectiveDayMap(
  days: readonly NormalizedEffectiveDay[] | undefined,
): ReadonlyMap<string, readonly EffectiveWindow[]> | undefined {
  const result = new Map<string, readonly EffectiveWindow[]>();
  for (const day of days ?? []) {
    if (!validDate(day.date) || result.has(day.date)) {
      return undefined;
    }
    const windows: EffectiveWindow[] = [];
    for (const window of day.windows) {
      const startMinute = timeMinute(window.startTime, false);
      const endMinute = timeMinute(window.endTime, true);
      if (
        startMinute === undefined ||
        endMinute === undefined ||
        endMinute <= startMinute
      ) {
        return undefined;
      }
      windows.push({ endMinute, startMinute });
    }
    result.set(
      day.date,
      windows.sort(
        (left, right) =>
          left.startMinute - right.startMinute ||
          left.endMinute - right.endMinute,
      ),
    );
  }
  return result;
}

function validateBase(
  request: AvailabilityRequest,
): ValidatedBase | AvailabilityResult {
  if (
    !SUPPORTED_DURATIONS.includes(
      request.durationMinutes as WorkSessionDuration,
    )
  ) {
    return { reason: "invalid_duration", status: "invalid_request" };
  }
  const nowMillis = parsedInstant(request.now);
  const targetMillis = parsedInstant(request.targetAt);
  if (
    nowMillis === undefined ||
    targetMillis === undefined
  ) {
    return { reason: "invalid_range", status: "invalid_request" };
  }
  const effectiveDays = effectiveDayMap(request.effectiveDays);
  if (!effectiveDays) {
    return {
      reason: "invalid_effective_days",
      status: "invalid_request",
    };
  }
  return {
    duration: request.durationMinutes as WorkSessionDuration,
    durationMilliseconds: request.durationMinutes * 60 * 1_000,
    effectiveDays,
    nowMillis,
    targetMillis,
  };
}

function windowsForDate(
  date: string,
  effectiveDays: ReadonlyMap<string, readonly EffectiveWindow[]>,
): readonly EffectiveWindow[] {
  return effectiveDays.get(date) ?? [{ endMinute: 20 * 60, startMinute: 8 * 60 }];
}

function sessionFitsHours(
  startMillis: number,
  endMillis: number,
  effectiveDays: ReadonlyMap<string, readonly EffectiveWindow[]>,
): boolean {
  const startDate = localDate(startMillis);
  const endDate = localDate(endMillis);
  const startMinute = localMinute(startMillis);
  const endMinute =
    endDate === startDate
      ? localMinute(endMillis)
      : localMinute(endMillis) === 0
        ? 24 * 60
        : Number.POSITIVE_INFINITY;
  if (
    endDate !== startDate &&
    !(
      endMinute === 24 * 60 &&
      Date.parse(`${endDate}T00:00:00.000Z`) -
        Date.parse(`${startDate}T00:00:00.000Z`) ===
        DAY_MILLISECONDS
    )
  ) {
    return false;
  }
  return windowsForDate(startDate, effectiveDays).some(
    (window) =>
      startMinute >= window.startMinute && endMinute <= window.endMinute,
  );
}

function normalizeBusy(
  intervals: readonly BusyInterval[],
): readonly MillisecondInterval[] | undefined {
  const normalized: MillisecondInterval[] = [];
  for (const interval of intervals) {
    const startMillis = parsedInstant(interval.startAt);
    const endMillis = parsedInstant(interval.endAt);
    if (
      startMillis === undefined ||
      endMillis === undefined ||
      endMillis <= startMillis
    ) {
      return undefined;
    }
    normalized.push({ endMillis, startMillis });
  }
  normalized.sort(
    (left, right) =>
      left.startMillis - right.startMillis ||
      left.endMillis - right.endMillis,
  );
  const merged: MillisecondInterval[] = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (previous && interval.startMillis < previous.endMillis) {
      previous.endMillis = Math.max(previous.endMillis, interval.endMillis);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function overlapsBusy(
  startMillis: number,
  endMillis: number,
  busy: readonly MillisecondInterval[],
): boolean {
  return busy.some(
    (interval) =>
      startMillis < interval.endMillis && endMillis > interval.startMillis,
  );
}

function candidates(
  range: MillisecondInterval,
  base: ValidatedBase,
  busy: readonly MillisecondInterval[],
): readonly MillisecondInterval[] {
  const result: MillisecondInterval[] = [];
  for (
    let startMillis = roundedUpBoundary(range.startMillis);
    startMillis + base.durationMilliseconds <= range.endMillis;
    startMillis += HALF_HOUR_MILLISECONDS
  ) {
    const endMillis = startMillis + base.durationMilliseconds;
    if (
      sessionFitsHours(startMillis, endMillis, base.effectiveDays) &&
      !overlapsBusy(startMillis, endMillis, busy)
    ) {
      result.push({ endMillis, startMillis });
    }
  }
  return result;
}

function workWindow(interval: MillisecondInterval): WorkWindow {
  return {
    endAt: singaporeInstant(interval.endMillis),
    startAt: singaporeInstant(interval.startMillis),
  };
}

async function readBusy(
  reader: BusyIntervalReader,
  range: MillisecondInterval,
): Promise<
  | Readonly<{
      busy: readonly MillisecondInterval[];
      checkedAt: string;
      status: "ok";
    }>
  | Readonly<{
      status: "authorization_expired" | "provider_failure" | "unavailable";
    }>
> {
  let result: BusyIntervalReadResult;
  try {
    result = await reader(workWindow(range));
  } catch {
    return { status: "unavailable" };
  }
  if (result.status !== "ok") {
    return result;
  }
  if (parsedInstant(result.checkedAt) === undefined) {
    return { status: "unavailable" };
  }
  const busy = normalizeBusy(result.busyIntervals);
  return busy
    ? { busy, checkedAt: result.checkedAt, status: "ok" }
    : { status: "unavailable" };
}

function generatedRange(base: ValidatedBase): MillisecondInterval | undefined {
  const startMillis = roundedUpBoundary(base.nowMillis);
  const endMillis = Math.min(
    base.targetMillis,
    base.nowMillis + GENERATED_CAP_MILLISECONDS,
  );
  return startMillis + base.durationMilliseconds <= endMillis
    ? { endMillis, startMillis }
    : undefined;
}

function recoveryRange(base: ValidatedBase): MillisecondInterval | undefined {
  const startMillis = roundedUpBoundary(
    Math.max(base.nowMillis, base.targetMillis) + 1,
  );
  const endMillis = base.targetMillis + RECOVERY_CAP_MILLISECONDS;
  return startMillis + base.durationMilliseconds <= endMillis
    ? { endMillis, startMillis }
    : undefined;
}

function available(
  alternatives: readonly MillisecondInterval[],
  checkedAt: string | null,
  proposed: ProposedResult | null,
): AvailabilityResult {
  if (alternatives.length === 0 && proposed?.status !== "free") {
    return {
      alternatives: [],
      checkedAt,
      proposed,
      status: "no_fit",
    };
  }
  return {
    alternatives: alternatives.map(workWindow),
    checkedAt,
    proposed,
    status: "available",
  };
}

function rankedForConflict(
  options: readonly MillisecondInterval[],
  proposedStart: number,
): readonly MillisecondInterval[] {
  const proposedDate = localDate(proposedStart);
  const sameDay = options.filter(
    (option) => localDate(option.startMillis) === proposedDate,
  );
  const nearestLater = sameDay
    .filter((option) => option.startMillis > proposedStart)
    .sort((left, right) => left.startMillis - right.startMillis)
    .at(0);
  const nearestEarlier = sameDay
    .filter((option) => option.startMillis < proposedStart)
    .sort((left, right) => right.startMillis - left.startMillis)
    .at(0);
  if (nearestLater || nearestEarlier) {
    return [nearestLater, nearestEarlier].filter(
      (option): option is MillisecondInterval => option !== undefined,
    );
  }
  return options
    .filter((option) => localDate(option.startMillis) > proposedDate)
    .sort((left, right) => left.startMillis - right.startMillis)
    .slice(0, 2);
}

export async function findWorkWindows(
  request: AvailabilityRequest,
  reader: BusyIntervalReader,
): Promise<AvailabilityResult> {
  const validation = validateBase(request);
  if (!("duration" in validation)) {
    return validation;
  }
  const base = validation;

  if (request.kind === "recovery") {
    const range = recoveryRange(base);
    if (!range) {
      return available([], null, null);
    }
    const read = await readBusy(reader, range);
    if (read.status !== "ok") {
      return read;
    }
    return available(
      candidates(range, base, read.busy).slice(0, 2),
      read.checkedAt,
      null,
    );
  }

  if (base.nowMillis > base.targetMillis) {
    return { reason: "invalid_range", status: "invalid_request" };
  }

  if (request.kind === "proposal") {
    const proposedStart = parsedInstant(request.proposedStartAt);
    if (proposedStart === undefined) {
      return { reason: "invalid_proposal", status: "invalid_request" };
    }
    const proposedEnd = proposedStart + base.durationMilliseconds;
    if (
      proposedStart < base.nowMillis ||
      proposedStart > base.targetMillis ||
      !boundaryStart(proposedStart) ||
      !sessionFitsHours(
        proposedStart,
        proposedEnd,
        base.effectiveDays,
      )
    ) {
      return { reason: "invalid_proposal", status: "invalid_request" };
    }
    const proposedInterval = {
      endMillis: proposedEnd,
      startMillis: proposedStart,
    };
    const proposedRead = await readBusy(reader, proposedInterval);
    if (proposedRead.status !== "ok") {
      return proposedRead;
    }
    const proposedWindow = workWindow(proposedInterval);
    if (
      !overlapsBusy(
        proposedStart,
        proposedEnd,
        proposedRead.busy,
      )
    ) {
      return available([], proposedRead.checkedAt, {
        status: "free",
        window: proposedWindow,
      });
    }

    const range = generatedRange(base);
    if (!range) {
      return available([], proposedRead.checkedAt, {
        status: "conflict",
        window: proposedWindow,
      });
    }
    const alternativesRead = await readBusy(reader, range);
    if (alternativesRead.status !== "ok") {
      return alternativesRead;
    }
    return available(
      rankedForConflict(
        candidates(range, base, alternativesRead.busy),
        proposedStart,
      ),
      alternativesRead.checkedAt,
      { status: "conflict", window: proposedWindow },
    );
  }

  const range = generatedRange(base);
  if (!range) {
    return available([], null, null);
  }
  const read = await readBusy(reader, range);
  if (read.status !== "ok") {
    return read;
  }
  return available(
    candidates(range, base, read.busy).slice(0, 2),
    read.checkedAt,
    null,
  );
}
