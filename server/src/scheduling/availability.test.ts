import { describe, expect, it, vi } from "vitest";

import {
  type AvailabilityRequest,
  type BusyInterval,
  type BusyIntervalReadResult,
  findWorkWindows,
} from "./availability.js";

const checkedAt = "2026-08-01T00:00:01.000Z";
const base = {
  durationMinutes: 60,
  kind: "generated",
  now: "2026-08-01T08:00:00+08:00",
  targetAt: "2026-08-03T20:00:00+08:00",
} as const satisfies AvailabilityRequest;

function controlled(
  results:
    | readonly BusyInterval[]
    | readonly BusyIntervalReadResult[],
) {
  const queue: BusyIntervalReadResult[] =
    results.length > 0 && "status" in results[0]!
      ? [...(results as readonly BusyIntervalReadResult[])]
      : [
          {
            busyIntervals: results as readonly BusyInterval[],
            checkedAt,
            status: "ok",
          },
        ];
  const calls: Array<{ endAt: string; startAt: string }> = [];
  const reader = vi.fn(async (range: { endAt: string; startAt: string }) => {
    calls.push(range);
    const result = queue.shift();
    if (!result) {
      throw new Error("Unexpected busy read");
    }
    return result;
  });
  return { calls, reader };
}

function ok(busyIntervals: readonly BusyInterval[]): BusyIntervalReadResult {
  return { busyIntervals, checkedAt, status: "ok" };
}

describe("findWorkWindows", () => {
  it.each([15, 45, 180])(
    "rejects unsupported %i-minute duration before Calendar",
    async (durationMinutes) => {
      const test = controlled([]);
      await expect(
        findWorkWindows({ ...base, durationMinutes }, test.reader),
      ).resolves.toEqual({
        reason: "invalid_duration",
        status: "invalid_request",
      });
      expect(test.reader).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      expected: "2026-08-01T08:00:00+08:00",
      now: "2026-08-01T08:00:00+08:00",
    },
    {
      expected: "2026-08-01T08:30:00+08:00",
      now: "2026-08-01T08:01:00+08:00",
    },
  ])("rounds $now to the next valid boundary", async ({ expected, now }) => {
    const test = controlled([]);
    const result = await findWorkWindows(
      { ...base, durationMinutes: 30, now },
      test.reader,
    );
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.alternatives[0]?.startAt).toBe(expected);
    }
  });

  it("uses 08:00–20:00 defaults and requires the full session to fit", async () => {
    const test = controlled([]);
    const result = await findWorkWindows(
      {
        ...base,
        durationMinutes: 30,
        now: "2026-08-01T19:30:00+08:00",
        targetAt: "2026-08-01T20:30:00+08:00",
      },
      test.reader,
    );
    expect(result).toMatchObject({
      alternatives: [
        {
          endAt: "2026-08-01T20:00:00+08:00",
          startAt: "2026-08-01T19:30:00+08:00",
        },
      ],
      status: "available",
    });

    const atClose = controlled([]);
    await expect(
      findWorkWindows(
        {
          ...base,
          durationMinutes: 30,
          now: "2026-08-01T20:00:00+08:00",
          targetAt: "2026-08-01T21:00:00+08:00",
        },
        atClose.reader,
      ),
    ).resolves.toMatchObject({ alternatives: [], status: "no_fit" });
  });

  it("lets normalized per-date windows narrow, extend, split, or close defaults", async () => {
    const test = controlled([]);
    const result = await findWorkWindows(
      {
        ...base,
        durationMinutes: 30,
        effectiveDays: [
          {
            date: "2026-08-01",
            windows: [
              { endTime: "07:30", startTime: "07:00" },
              { endTime: "21:30", startTime: "21:00" },
            ],
          },
          { date: "2026-08-02", windows: [] },
        ],
        now: "2026-08-01T06:59:00+08:00",
      },
      test.reader,
    );
    expect(result).toMatchObject({
      alternatives: [
        {
          endAt: "2026-08-01T07:30:00+08:00",
          startAt: "2026-08-01T07:00:00+08:00",
        },
        {
          endAt: "2026-08-01T21:30:00+08:00",
          startAt: "2026-08-01T21:00:00+08:00",
        },
      ],
      status: "available",
    });
  });

  it("allows an exact-midnight end but never time after midnight", async () => {
    const effectiveDays = [
      {
        date: "2026-08-01",
        windows: [{ endTime: "24:00", startTime: "23:30" }],
      },
    ];
    const valid = controlled([]);
    await expect(
      findWorkWindows(
        {
          ...base,
          durationMinutes: 30,
          effectiveDays,
          now: "2026-08-01T23:30:00+08:00",
          targetAt: "2026-08-02T00:00:00+08:00",
        },
        valid.reader,
      ),
    ).resolves.toMatchObject({
      alternatives: [
        {
          endAt: "2026-08-02T00:00:00+08:00",
          startAt: "2026-08-01T23:30:00+08:00",
        },
      ],
      status: "available",
    });

    const crossing = controlled([]);
    await expect(
      findWorkWindows(
        {
          ...base,
          durationMinutes: 60,
          effectiveDays,
          now: "2026-08-01T23:30:00+08:00",
          targetAt: "2026-08-02T01:00:00+08:00",
        },
        crossing.reader,
      ),
    ).resolves.toMatchObject({ alternatives: [], status: "no_fit" });
  });

  it("uses half-open busy overlap so adjacency remains free", async () => {
    const test = controlled([
      {
        endAt: "2026-08-01T09:00:00+08:00",
        startAt: "2026-08-01T08:30:00+08:00",
      },
      {
        endAt: "2026-08-01T09:00:00+08:00",
        startAt: "2026-08-01T08:30:00+08:00",
      },
    ]);
    const result = await findWorkWindows(
      {
        ...base,
        durationMinutes: 30,
        targetAt: "2026-08-01T10:00:00+08:00",
      },
      test.reader,
    );
    expect(result).toMatchObject({
      alternatives: [
        {
          endAt: "2026-08-01T08:30:00+08:00",
          startAt: "2026-08-01T08:00:00+08:00",
        },
        {
          endAt: "2026-08-01T09:30:00+08:00",
          startAt: "2026-08-01T09:00:00+08:00",
        },
      ],
      status: "available",
    });
  });

  it("blocks every overlapping candidate, including an all-day FreeBusy interval", async () => {
    const test = controlled([
      {
        endAt: "2026-08-02T00:00:00+08:00",
        startAt: "2026-08-01T00:00:00+08:00",
      },
    ]);
    await expect(
      findWorkWindows(
        { ...base, targetAt: "2026-08-01T20:00:00+08:00" },
        test.reader,
      ),
    ).resolves.toEqual({
      alternatives: [],
      checkedAt,
      proposed: null,
      status: "no_fit",
    });
  });

  it("caps generated pre-target reads at exactly 14 days", async () => {
    const test = controlled([]);
    await findWorkWindows(
      {
        ...base,
        now: "2026-08-01T08:01:00+08:00",
        targetAt: "2026-09-01T20:00:00+08:00",
      },
      test.reader,
    );
    expect(test.calls).toEqual([
      {
        endAt: "2026-08-15T08:01:00+08:00",
        startAt: "2026-08-01T08:30:00+08:00",
      },
    ]);
  });

  it("checks an exact proposal beyond 14 days when it starts by the target", async () => {
    const test = controlled([]);
    const result = await findWorkWindows(
      {
        ...base,
        kind: "proposal",
        proposedStartAt: "2026-08-20T10:00:00+08:00",
        targetAt: "2026-08-20T10:00:00+08:00",
      },
      test.reader,
    );
    expect(test.calls).toEqual([
      {
        endAt: "2026-08-20T11:00:00+08:00",
        startAt: "2026-08-20T10:00:00+08:00",
      },
    ]);
    expect(result).toEqual({
      alternatives: [],
      checkedAt,
      proposed: {
        status: "free",
        window: {
          endAt: "2026-08-20T11:00:00+08:00",
          startAt: "2026-08-20T10:00:00+08:00",
        },
      },
      status: "available",
    });
  });

  it("rejects proposals after the target or off-boundary before Calendar", async () => {
    for (const proposedStartAt of [
      "2026-08-03T20:30:00+08:00",
      "2026-08-03T19:15:00+08:00",
    ]) {
      const test = controlled([]);
      await expect(
        findWorkWindows(
          {
            ...base,
            kind: "proposal",
            proposedStartAt,
          },
          test.reader,
        ),
      ).resolves.toEqual({
        reason: "invalid_proposal",
        status: "invalid_request",
      });
      expect(test.reader).not.toHaveBeenCalled();
    }
  });

  it("allows recovery only after target and caps its range at seven days", async () => {
    const test = controlled([]);
    await findWorkWindows(
      {
        ...base,
        kind: "recovery",
        now: "2026-08-03T08:01:00+08:00",
        targetAt: "2026-08-03T08:00:00+08:00",
      },
      test.reader,
    );
    expect(test.calls).toEqual([
      {
        endAt: "2026-08-10T08:01:00+08:00",
        startAt: "2026-08-03T08:30:00+08:00",
      },
    ]);

    const early = controlled([]);
    await expect(
      findWorkWindows(
        {
          ...base,
          kind: "recovery",
          now: "2026-08-03T07:59:00+08:00",
          targetAt: "2026-08-03T08:00:00+08:00",
        },
        early.reader,
      ),
    ).resolves.toEqual({
      reason: "recovery_not_due",
      status: "invalid_request",
    });
    expect(early.reader).not.toHaveBeenCalled();
  });

  it("returns a free proposal exactly without alternatives", async () => {
    const test = controlled([]);
    await expect(
      findWorkWindows(
        {
          ...base,
          kind: "proposal",
          proposedStartAt: "2026-08-01T10:00:00+08:00",
        },
        test.reader,
      ),
    ).resolves.toEqual({
      alternatives: [],
      checkedAt,
      proposed: {
        status: "free",
        window: {
          endAt: "2026-08-01T11:00:00+08:00",
          startAt: "2026-08-01T10:00:00+08:00",
        },
      },
      status: "available",
    });
    expect(test.reader).toHaveBeenCalledTimes(1);
  });

  it("ranks the nearest later then nearest earlier same-day alternatives", async () => {
    const conflict = {
      endAt: "2026-08-01T11:00:00+08:00",
      startAt: "2026-08-01T10:00:00+08:00",
    };
    const test = controlled([ok([conflict]), ok([conflict])]);
    const result = await findWorkWindows(
      {
        ...base,
        kind: "proposal",
        proposedStartAt: "2026-08-01T10:00:00+08:00",
      },
      test.reader,
    );
    expect(result).toMatchObject({
      alternatives: [
        { startAt: "2026-08-01T11:00:00+08:00" },
        { startAt: "2026-08-01T09:00:00+08:00" },
      ],
      proposed: { status: "conflict" },
      status: "available",
    });
  });

  it("returns one same-day option without filling from future dates", async () => {
    const conflict = {
      endAt: "2026-08-01T11:00:00+08:00",
      startAt: "2026-08-01T10:00:00+08:00",
    };
    const test = controlled([ok([conflict]), ok([conflict])]);
    const result = await findWorkWindows(
      {
        ...base,
        effectiveDays: [
          {
            date: "2026-08-01",
            windows: [{ endTime: "11:00", startTime: "08:00" }],
          },
        ],
        kind: "proposal",
        proposedStartAt: "2026-08-01T10:00:00+08:00",
      },
      test.reader,
    );
    expect(result).toMatchObject({
      alternatives: [{ startAt: "2026-08-01T09:00:00+08:00" }],
      status: "available",
    });
  });

  it("falls forward chronologically only when the proposed day has no fit", async () => {
    const allDay = {
      endAt: "2026-08-02T00:00:00+08:00",
      startAt: "2026-08-01T00:00:00+08:00",
    };
    const test = controlled([ok([allDay]), ok([allDay])]);
    const result = await findWorkWindows(
      {
        ...base,
        kind: "proposal",
        proposedStartAt: "2026-08-01T10:00:00+08:00",
      },
      test.reader,
    );
    expect(result).toMatchObject({
      alternatives: [
        { startAt: "2026-08-02T08:00:00+08:00" },
        { startAt: "2026-08-02T08:30:00+08:00" },
      ],
      status: "available",
    });
  });

  it("returns the earliest two chronological windows when no time was proposed", async () => {
    const test = controlled([]);
    const first = await findWorkWindows(base, test.reader);
    const second = await findWorkWindows(base, controlled([]).reader);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      alternatives: [
        { startAt: "2026-08-01T08:00:00+08:00" },
        { startAt: "2026-08-01T08:30:00+08:00" },
      ],
      status: "available",
    });
    expect(JSON.stringify(first)).not.toMatch(/best|optimal/i);
  });

  it.each(["authorization_expired", "unavailable"] as const)(
    "keeps Calendar %s distinct",
    async (status) => {
      const test = controlled([{ status }]);
      await expect(findWorkWindows(base, test.reader)).resolves.toEqual({
        status,
      });
    },
  );

  it("fails closed on invalid normalized busy data", async () => {
    const test = controlled([
      {
        busyIntervals: [
          { endAt: "private-end", startAt: "private-start" },
        ],
        checkedAt,
        status: "ok",
      },
    ]);
    await expect(findWorkWindows(base, test.reader)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("rejects malformed normalized effective windows before Calendar", async () => {
    const test = controlled([]);
    await expect(
      findWorkWindows(
        {
          ...base,
          effectiveDays: [
            {
              date: "2026-02-30",
              windows: [{ endTime: "08:00", startTime: "09:00" }],
            },
          ],
        },
        test.reader,
      ),
    ).resolves.toEqual({
      reason: "invalid_effective_days",
      status: "invalid_request",
    });
    expect(test.reader).not.toHaveBeenCalled();
  });
});
