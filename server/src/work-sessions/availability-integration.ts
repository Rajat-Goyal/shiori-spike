import type { GoogleCalendarAdapter } from "../google/calendar.js";
import {
  type AvailabilityRequest,
  type AvailabilityResult,
  findWorkWindows,
  type NormalizedEffectiveDay,
} from "../scheduling/availability.js";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const GENERATED_CAP_MILLISECONDS = 14 * DAY_MILLISECONDS;
const RECOVERY_CAP_MILLISECONDS = 7 * DAY_MILLISECONDS;
const SINGAPORE_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1_000;
const DAY_NAMES = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
const ORDERED_DAY_NAMES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

export const TIMING_CONSTRAINT_FORMAT_HELP =
  "Use `default` or up to four lines like `mon,wed 08:00-12:00`. Use Singapore time and 30-minute boundaries.";

type DayName = (typeof DAY_NAMES)[number];

type TimingWindow = Readonly<{
  endMinute: number;
  startMinute: number;
}>;

export type TimingConstraintNormalization =
  | Readonly<{
      canonical: string;
      effectiveDays: readonly NormalizedEffectiveDay[];
      status: "ok";
    }>
  | Readonly<{
      formatHelp: typeof TIMING_CONSTRAINT_FORMAT_HELP;
      status: "invalid";
    }>;

type WithoutEffectiveDays<T> = T extends unknown
  ? Omit<T, "effectiveDays">
  : never;

export type CalendarAvailabilityRequest =
  WithoutEffectiveDays<AvailabilityRequest> &
  Readonly<{ timingConstraints: string }>;

export type CalendarAvailabilityResult =
  | AvailabilityResult
  | Readonly<{
      formatHelp: typeof TIMING_CONSTRAINT_FORMAT_HELP;
      status: "invalid_timing_constraints";
    }>;

type CalendarAvailabilityBoundary = Pick<GoogleCalendarAdapter, "read">;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function timeMinute(
  value: string,
  allowEndOfDay: boolean,
): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (allowEndOfDay && hour === 24 && minute === 0) {
    return 24 * 60;
  }
  return hour >= 0 &&
      hour <= 23 &&
      (minute === 0 || minute === 30)
    ? hour * 60 + minute
    : undefined;
}

function minuteTime(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function mergeWindows(
  windows: readonly TimingWindow[],
): readonly TimingWindow[] {
  const sorted = [...windows].sort(
    (left, right) =>
      left.startMinute - right.startMinute ||
      left.endMinute - right.endMinute,
  );
  const merged: Array<{ endMinute: number; startMinute: number }> = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.startMinute <= previous.endMinute) {
      previous.endMinute = Math.max(previous.endMinute, window.endMinute);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function canonicalRules(
  rules: ReadonlyMap<DayName, readonly TimingWindow[]>,
): string {
  const byWindow = new Map<string, DayName[]>();
  for (const day of ORDERED_DAY_NAMES) {
    for (const window of rules.get(day) ?? []) {
      const key = `${minuteTime(window.startMinute)}-${minuteTime(window.endMinute)}`;
      const days = byWindow.get(key) ?? [];
      days.push(day);
      byWindow.set(key, days);
    }
  }
  return [...byWindow.entries()]
    .sort(([leftWindow, leftDays], [rightWindow, rightDays]) => {
      const leftDay = Math.min(
        ...leftDays.map((day) => ORDERED_DAY_NAMES.indexOf(day)),
      );
      const rightDay = Math.min(
        ...rightDays.map((day) => ORDERED_DAY_NAMES.indexOf(day)),
      );
      return leftDay - rightDay || leftWindow.localeCompare(rightWindow);
    })
    .map(([window, days]) => {
      const selector = days.length === 7 ? "daily" : days.join(",");
      return `${selector} ${window}`;
    })
    .join("\n");
}

export function normalizeTimingConstraints(
  timingConstraints: string,
  dates: readonly string[],
): TimingConstraintNormalization {
  if (
    dates.some((date) => !validDate(date)) ||
    new Set(dates).size !== dates.length
  ) {
    return {
      formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
      status: "invalid",
    };
  }

  const normalizedInput = timingConstraints.trim().toLowerCase();
  if (normalizedInput === "default") {
    return {
      canonical: "default",
      effectiveDays: dates.map((date) => ({
        date,
        windows: [{ endTime: "20:00", startTime: "08:00" }],
      })),
      status: "ok",
    };
  }

  const lines = normalizedInput.split(/\r?\n/);
  if (
    lines.length === 0 ||
    lines.length > 4 ||
    lines.some((line) => line.trim().length === 0)
  ) {
    return {
      formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
      status: "invalid",
    };
  }

  const rules = new Map<DayName, TimingWindow[]>();
  for (const rawLine of lines) {
    const match =
      /^(daily|[a-z]{3}(?:\s*,\s*[a-z]{3})*)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/
        .exec(rawLine.trim());
    if (!match) {
      return {
        formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
        status: "invalid",
      };
    }
    const selectedDays =
      match[1] === "daily"
        ? [...ORDERED_DAY_NAMES]
        : match[1].split(",").map((day) => day.trim());
    if (
      selectedDays.some(
        (day): day is string => !ORDERED_DAY_NAMES.includes(day as DayName),
      )
    ) {
      return {
        formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
        status: "invalid",
      };
    }
    const startMinute = timeMinute(match[2], false);
    const endMinute = timeMinute(match[3], true);
    if (
      startMinute === undefined ||
      endMinute === undefined ||
      endMinute <= startMinute
    ) {
      return {
        formatHelp: TIMING_CONSTRAINT_FORMAT_HELP,
        status: "invalid",
      };
    }
    for (const day of new Set(selectedDays as DayName[])) {
      const windows = rules.get(day) ?? [];
      windows.push({ endMinute, startMinute });
      rules.set(day, windows);
    }
  }

  for (const [day, windows] of rules) {
    rules.set(day, [...mergeWindows(windows)]);
  }

  return {
    canonical: canonicalRules(rules),
    effectiveDays: dates.map((date) => {
      const day = DAY_NAMES[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
      return {
        date,
        windows: (rules.get(day) ?? []).map((window) => ({
          endTime: minuteTime(window.endMinute),
          startTime: minuteTime(window.startMinute),
        })),
      };
    }),
    status: "ok",
  };
}

function parsedInstant(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function singaporeDate(millis: number): string {
  return new Date(millis + SINGAPORE_OFFSET_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

function addDateRange(
  dates: Set<string>,
  startMillis: number,
  endMillis: number,
): void {
  if (endMillis < startMillis) {
    return;
  }
  const first = Date.parse(`${singaporeDate(startMillis)}T00:00:00.000Z`);
  const last = Date.parse(`${singaporeDate(endMillis)}T00:00:00.000Z`);
  for (let day = first; day <= last; day += DAY_MILLISECONDS) {
    dates.add(new Date(day).toISOString().slice(0, 10));
  }
}

function relevantDates(
  request: CalendarAvailabilityRequest,
): readonly string[] {
  const dates = new Set<string>();
  const nowMillis = parsedInstant(request.now);
  const targetMillis = parsedInstant(request.targetAt);
  if (nowMillis === undefined || targetMillis === undefined) {
    return [];
  }

  if (request.kind === "recovery") {
    addDateRange(
      dates,
      nowMillis,
      nowMillis + RECOVERY_CAP_MILLISECONDS,
    );
  } else if (nowMillis <= targetMillis) {
    addDateRange(
      dates,
      nowMillis,
      Math.min(
        targetMillis,
        nowMillis + GENERATED_CAP_MILLISECONDS,
      ),
    );
  }

  if (request.kind === "proposal") {
    const proposedMillis = parsedInstant(request.proposedStartAt);
    if (proposedMillis !== undefined) {
      dates.add(singaporeDate(proposedMillis));
    }
  }
  return [...dates].sort();
}

export async function checkCalendarAvailability(
  request: CalendarAvailabilityRequest,
  calendar: CalendarAvailabilityBoundary,
): Promise<CalendarAvailabilityResult> {
  const normalized = normalizeTimingConstraints(
    request.timingConstraints,
    relevantDates(request),
  );
  if (normalized.status !== "ok") {
    return {
      formatHelp: normalized.formatHelp,
      status: "invalid_timing_constraints",
    };
  }

  const { timingConstraints: _timingConstraints, ...availabilityRequest } =
    request;
  return findWorkWindows(
    {
      ...availabilityRequest,
      effectiveDays: normalized.effectiveDays,
    } as AvailabilityRequest,
    async (range) => {
      const result = await calendar.read({
        calendarId: "primary",
        range,
      });
      return result.status === "ok"
        ? {
            busyIntervals: result.busyIntervals,
            checkedAt: result.checkedAt,
            status: "ok",
          }
        : result;
    },
  );
}
