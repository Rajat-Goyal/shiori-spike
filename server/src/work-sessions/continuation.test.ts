import { describe, expect, it, vi } from "vitest";
import type { WorkWindow } from "../scheduling/availability.js";
import {
  type WorkSessionContinuationRepository,
  type WorkSessionContinuationSnapshot,
  WorkSessionContinuationService,
} from "./continuation.js";

const intentId = "11111111-1111-4111-8111-111111111111";
const sourceSessionId = "22222222-2222-4222-8222-222222222222";
const commitmentId = "33333333-3333-4333-8333-333333333333";
const option: WorkWindow = {
  endAt: "2026-07-28T10:00:00+08:00",
  startAt: "2026-07-28T09:00:00+08:00",
};

function snapshot(
  overrides: Partial<WorkSessionContinuationSnapshot> = {},
): WorkSessionContinuationSnapshot {
  return {
    calendarAttemptedAt: null,
    calendarCheckedAt: null,
    commitmentId,
    commitmentStatus: "active",
    definitionOfDone: "Submit the synthetic note",
    durationMinutes: null,
    finalObservation: null,
    id: intentId,
    isRecovery: false,
    options: [],
    selectedWindow: null,
    sourceSessionId,
    stage: "awaiting_duration",
    targetAt: "2026-07-29T18:00:00+08:00",
    timingConstraints: "default",
    version: 1,
    ...overrides,
  };
}

class Repository implements WorkSessionContinuationRepository {
  current = snapshot();
  readKind: "current" | "expired" | "missing" | "stale" = "current";
  readonly transitions: any[] = [];
  readonly confirmations: any[] = [];
  readonly finalizations: any[] = [];

  async finalizeConversation(
    updateId: number,
    chatId: number,
    reference: Readonly<{ id: string; version: number }>,
    result: "domain_error" | "expired" | "invalid" | "stale",
  ) {
    this.finalizations.push({ chatId, reference, result, updateId });
    return { kind: "applied" as const };
  }

  async read() {
    return this.readKind === "current"
      ? { kind: "current" as const, snapshot: this.current }
      : { kind: this.readKind };
  }

  async transition(command: any) {
    this.transitions.push(command);
    this.current = {
      ...this.current,
      calendarAttemptedAt:
        command.calendarAttemptedAt ??
        this.current.calendarAttemptedAt,
      calendarCheckedAt:
        command.calendarCheckedAt ?? null,
      durationMinutes:
        command.durationMinutes ?? this.current.durationMinutes,
      isRecovery: command.isRecovery ?? this.current.isRecovery,
      finalObservation:
        command.finalObservation ?? this.current.finalObservation,
      options: command.options ?? this.current.options,
      selectedWindow:
        command.selectedWindow ?? (
          [
            "confirming",
            "conflict_choice",
            "unverified_confirming",
          ].includes(command.nextStage)
            ? this.current.selectedWindow
            : null
        ),
      stage: command.nextStage,
      version: this.current.version + 1,
    };
    return { kind: "applied" as const, snapshot: this.current };
  }

  async confirm(command: any) {
    this.confirmations.push(command);
    return {
      kind: "applied" as const,
      workSessionId: "44444444-4444-4444-8444-444444444444",
    };
  }
}

describe("work-session continuation", () => {
  it("records an exact natural 45-minute duration against one continuation authority", async () => {
    const repository = new Repository();
    const availability = vi.fn();
    const service = new WorkSessionContinuationService({
      availability,
      repository,
    });

    const reply = await service.handleDurationInput(
      80,
      123456789,
      {
        durationMinutes: 45,
        intentId,
        intentVersion: 1,
      },
    );

    expect(repository.transitions).toEqual([
      expect.objectContaining({
        action: "natural_duration",
        durationMinutes: 45,
        expectedStage: "awaiting_duration",
        nextStage: "offer",
      }),
    ]);
    expect(repository.current.durationMinutes).toBe(45);
    expect(reply?.actions?.map((item) => item.text)).toEqual([
      "Find a time",
      "Not now",
    ]);
    expect(availability).not.toHaveBeenCalled();
  });

  it.each([0, 1_441])(
    "terminally rejects a typed continuation duration of %i",
    async (durationMinutes) => {
      const repository = new Repository();
      const service = new WorkSessionContinuationService({
        availability: vi.fn(),
        repository,
      });

      await service.handleDurationInput(79, 123456789, {
        durationMinutes,
        intentId,
        intentVersion: 1,
      });

      expect(repository.transitions).toHaveLength(0);
      expect(repository.finalizations).toEqual([
        expect.objectContaining({ result: "invalid", updateId: 79 }),
      ]);
    },
  );

  it.each([
    ["expired", "expired"],
    ["missing", "stale"],
    ["stale", "stale"],
  ] as const)(
    "terminally finalizes a typed duration when the continuation is %s",
    async (readKind, expected) => {
      const repository = new Repository();
      repository.readKind = readKind;
      const service = new WorkSessionContinuationService({
        availability: vi.fn(),
        repository,
      });

      await service.handleDurationInput(78, 123456789, {
        durationMinutes: 45,
        intentId,
        intentVersion: 1,
      });

      expect(repository.finalizations).toEqual([
        expect.objectContaining({ result: expected, updateId: 78 }),
      ]);
    },
  );

  it("records duration without searching, then requires a separate Find a time action", async () => {
    const repository = new Repository();
    const availability = vi.fn(async () => ({
      alternatives: [option, {
        endAt: "2026-07-28T11:00:00+08:00",
        startAt: "2026-07-28T10:00:00+08:00",
      }, {
        endAt: "2026-07-28T12:00:00+08:00",
        startAt: "2026-07-28T11:00:00+08:00",
      }],
      checkedAt: "2026-07-27T00:00:00.000Z",
      proposed: null,
      status: "available" as const,
    }));
    const service = new WorkSessionContinuationService({
      availability,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
      repository,
    });

    const durationReply = await service.handle(
      81,
      123456789,
      `c:${intentId}:1:duration_60`,
    );

    expect(availability).not.toHaveBeenCalled();
    expect(repository.transitions[0]).toMatchObject({
      durationMinutes: 60,
      nextStage: "offer",
    });
    expect(durationReply?.actions?.map((action) => action.text)).toEqual([
      "Find a time",
      "Not now",
    ]);

    const reply = await service.handle(
      82,
      123456789,
      `c:${intentId}:2:another`,
    );
    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 60, kind: "generated" }),
    );
    expect(repository.transitions[1]).toMatchObject({
      durationMinutes: 60,
      nextStage: "choosing",
      options: expect.any(Array),
    });
    expect(repository.transitions[1].options).toHaveLength(2);
    expect(reply?.actions?.map((action) => action.text)).toEqual([
      "Choose option 1",
      "Choose option 2",
      "Not now",
    ]);
  });

  it("offers one target-relative recovery only after a conclusive pre-target no-fit", async () => {
    const repository = new Repository();
    repository.current = snapshot({
      durationMinutes: 60,
      stage: "offer",
    });
    const availability = vi
      .fn()
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt: "2026-07-27T00:00:00.000Z",
        proposed: null,
        status: "no_fit",
      })
      .mockResolvedValueOnce({
        alternatives: [{
          endAt: "2026-07-30T10:00:00+08:00",
          startAt: "2026-07-30T09:00:00+08:00",
        }],
        checkedAt: "2026-07-27T00:00:01.000Z",
        proposed: null,
        status: "available",
      });
    const service = new WorkSessionContinuationService({
      availability,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
      repository,
    });

    const reply = await service.handle(
      82,
      123456789,
      `c:${intentId}:1:another`,
    );

    expect(availability.mock.calls.map(([request]) => request.kind))
      .toEqual(["generated", "recovery"]);
    expect(repository.transitions[0]).toMatchObject({
      isRecovery: true,
      nextStage: "choosing",
    });
    expect(reply?.text).toContain("after the original target");
  });

  it("persists selection, rechecks Calendar, then confirms exactly once", async () => {
    const repository = new Repository();
    repository.current = snapshot({
      durationMinutes: 60,
      options: [option],
      stage: "choosing",
    });
    const availability = vi.fn(async () => ({
      alternatives: [],
      checkedAt: "2026-07-27T00:00:03.000Z",
      proposed: { status: "free" as const, window: option },
      status: "available" as const,
    }));
    const service = new WorkSessionContinuationService({
      availability,
      now: () => new Date("2026-07-27T00:00:02.000Z"),
      repository,
    });

    const selection = await service.handle(
      83,
      123456789,
      `c:${intentId}:1:option_1`,
    );
    expect(selection?.actions?.[0].text).toBe("Confirm");

    await expect(
      service.handle(
        84,
        123456789,
        `c:${intentId}:2:confirm`,
      ),
    ).resolves.toMatchObject({
      text: expect.stringMatching(/Next work session scheduled/),
    });
    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "proposal",
        proposedStartAt: option.startAt,
      }),
    );
    expect(repository.confirmations).toHaveLength(1);
    expect(repository.confirmations[0]).toMatchObject({
      checkedAt: "2026-07-27T00:00:03.000Z",
      expectedStage: "confirming",
      finalObservation: "free",
      status: "free",
    });
  });

  it("persists a final conflict as a versioned no-consequence retry state", async () => {
    const repository = new Repository();
    repository.current = snapshot({
      durationMinutes: 60,
      selectedWindow: option,
      stage: "confirming",
    });
    const availability = vi
      .fn()
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt: "2026-07-27T00:00:03.000Z",
        proposed: { status: "conflict", window: option },
        status: "available",
      })
      .mockResolvedValueOnce({
        alternatives: [],
        checkedAt: "2026-07-27T00:00:05.000Z",
        proposed: { status: "free", window: option },
        status: "available",
      });
    const service = new WorkSessionContinuationService({
      availability,
      now: () => new Date("2026-07-27T00:00:02.000Z"),
      repository,
    });

    const conflict = await service.handle(
      86,
      123456789,
      `c:${intentId}:1:confirm`,
    );
    expect(conflict?.actions?.map(({ text }) => text)).toEqual([
      "Check again",
      "Not now",
    ]);
    expect(repository.current).toMatchObject({
      calendarCheckedAt: "2026-07-27T00:00:03.000Z",
      finalObservation: "conflict",
      stage: "conflict_choice",
      version: 2,
    });
    expect(repository.confirmations).toHaveLength(0);

    await service.handle(
      87,
      123456789,
      `c:${intentId}:2:check_again`,
    );
    expect(repository.confirmations).toHaveLength(1);
    expect(repository.confirmations[0]).toMatchObject({
      expectedStage: "conflict_choice",
      finalObservation: "free",
      status: "free",
    });
  });

  it("offers versioned reconnect, retry, unverified save, and cancel without automatic consequence", async () => {
    const repository = new Repository();
    repository.current = snapshot({
      durationMinutes: 60,
      selectedWindow: option,
      stage: "confirming",
    });
    const service = new WorkSessionContinuationService({
      availability: vi.fn(async () => ({
        status: "authorization_expired" as const,
      })),
      now: () => new Date("2026-07-27T00:00:02.000Z"),
      repository,
    });

    const unavailable = await service.handle(
      88,
      123456789,
      `c:${intentId}:1:confirm`,
    );
    expect(unavailable?.actions?.map(({ text }) => text)).toEqual([
      "Reconnect",
      "Check again",
      "Save without Calendar check",
      "Not now",
    ]);
    expect(repository.confirmations).toHaveLength(0);
    expect(repository.current).toMatchObject({
      calendarAttemptedAt: "2026-07-27T00:00:02.000Z",
      calendarCheckedAt: null,
      finalObservation: "unavailable",
      stage: "unverified_confirming",
      version: 2,
    });

    await service.handle(
      89,
      123456789,
      `c:${intentId}:2:save_unverified`,
    );
    expect(repository.confirmations).toHaveLength(1);
    expect(repository.confirmations[0]).toMatchObject({
      attemptedAt: "2026-07-27T00:00:02.000Z",
      checkedAt: null,
      expectedStage: "unverified_confirming",
      finalObservation: "unavailable",
      status: "unverified",
    });
  });

  it("distinguishes an expired continuation from stale without checking Calendar", async () => {
    const repository = new Repository();
    repository.readKind = "expired";
    const availability = vi.fn();
    const service = new WorkSessionContinuationService({
      availability,
      repository,
    });

    await expect(
      service.handle(90, 123456789, `c:${intentId}:1:another`),
    ).resolves.toEqual({
      text: "That continuation expired after 24 hours. Nothing was changed.",
    });
    expect(availability).not.toHaveBeenCalled();
    expect(repository.transitions).toHaveLength(0);
  });

  it("declines without checking Calendar or creating a session", async () => {
    const repository = new Repository();
    repository.current = snapshot({
      durationMinutes: 60,
      stage: "offer",
    });
    const availability = vi.fn();
    const service = new WorkSessionContinuationService({
      availability,
      repository,
    });

    await expect(
      service.handle(85, 123456789, `c:${intentId}:1:decline`),
    ).resolves.toEqual({
      text: "No next work session was scheduled.",
    });
    expect(availability).not.toHaveBeenCalled();
    expect(repository.confirmations).toHaveLength(0);
  });
});
