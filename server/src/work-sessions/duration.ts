export const MIN_WORK_SESSION_DURATION_MINUTES = 1;
export const MAX_WORK_SESSION_DURATION_MINUTES = 24 * 60;

export function isWorkSessionDuration(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_WORK_SESSION_DURATION_MINUTES &&
    value <= MAX_WORK_SESSION_DURATION_MINUTES
  );
}

export function isSingaporeWorkSessionStart(
  value: unknown,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    return false;
  }
  const singapore = new Date(instant + 8 * 60 * 60_000);
  return (
    [0, 30].includes(singapore.getUTCMinutes()) &&
    singapore.getUTCSeconds() === 0 &&
    singapore.getUTCMilliseconds() === 0
  );
}

export function isWorkSessionWindow(
  startAt: unknown,
  endAt: unknown,
  durationMinutes: unknown,
): startAt is string {
  if (
    !isSingaporeWorkSessionStart(startAt) ||
    typeof endAt !== "string" ||
    !Number.isFinite(Date.parse(endAt)) ||
    !isWorkSessionDuration(durationMinutes)
  ) {
    return false;
  }
  return (
    Date.parse(endAt) - Date.parse(startAt) ===
      durationMinutes * 60_000
  );
}
