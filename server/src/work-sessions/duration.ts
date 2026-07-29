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
