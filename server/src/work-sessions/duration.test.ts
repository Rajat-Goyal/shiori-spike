import { describe, expect, it } from "vitest";
import {
  isSingaporeWorkSessionStart,
  isWorkSessionDuration,
  isWorkSessionWindow,
} from "./duration.js";

describe("work-session duration and exact window validation", () => {
  it.each([1, 45, 1_440])(
    "accepts a whole-minute duration of %i",
    (duration) => {
      expect(isWorkSessionDuration(duration)).toBe(true);
    },
  );

  it.each([0, 1_441, 45.5, Number.NaN])(
    "rejects an invalid duration of %s",
    (duration) => {
      expect(isWorkSessionDuration(duration)).toBe(false);
    },
  );

  it("accepts exact Singapore half-hour boundaries represented in either +08:00 or UTC", () => {
    expect(
      isSingaporeWorkSessionStart("2026-07-30T08:00:00+08:00"),
    ).toBe(true);
    expect(
      isSingaporeWorkSessionStart("2026-07-30T00:30:00.000Z"),
    ).toBe(true);
    expect(
      isSingaporeWorkSessionStart("2026-07-30T08:15:00+08:00"),
    ).toBe(false);
  });

  it.each([
    [
      "2026-07-30T08:00:00+08:00",
      "2026-07-30T08:45:00+08:00",
      45,
    ],
    [
      "2026-07-30T08:30:00+08:00",
      "2026-07-30T09:15:00+08:00",
      45,
    ],
    [
      "2026-07-30T00:00:00+08:00",
      "2026-07-31T00:00:00+08:00",
      1_440,
    ],
  ])(
    "accepts the exact interval %s to %s",
    (startAt, endAt, duration) => {
      expect(isWorkSessionWindow(startAt, endAt, duration)).toBe(true);
    },
  );

  it.each([
    [
      "2026-07-30T08:15:00+08:00",
      "2026-07-30T09:00:00+08:00",
      45,
    ],
    [
      "2026-07-30T08:00:00+08:00",
      "2026-07-30T08:44:00+08:00",
      45,
    ],
    [
      "2026-07-30T08:00:00+08:00",
      "2026-07-31T08:01:00+08:00",
      1_441,
    ],
  ])(
    "rejects the malformed interval %s to %s",
    (startAt, endAt, duration) => {
      expect(isWorkSessionWindow(startAt, endAt, duration)).toBe(false);
    },
  );
});
