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
    commitmentId,
    commitmentStatus: "active",
    definitionOfDone: "Submit the synthetic note",
    durationMinutes: null,
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
  readonly transitions: any[] = [];
  readonly confirmations: any[] = [];

  async read() {
    return { kind: "current" as const, snapshot: this.current };
  }

  async transition(command: any) {
    this.transitions.push(command);
    this.current = {
      ...this.current,
      durationMinutes:
        command.durationMinutes ?? this.current.durationMinutes,
      isRecovery: command.isRecovery ?? this.current.isRecovery,
      options: command.options ?? this.current.options,
      selectedWindow:
        command.selectedWindow ?? (
          command.nextStage === "confirming"
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
  it("requires explicit duration then persists at most two Calendar-checked choices", async () => {
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

    const reply = await service.handle(
      81,
      123456789,
      `c:${intentId}:1:duration_60`,
    );

    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 60, kind: "generated" }),
    );
    expect(repository.transitions[0]).toMatchObject({
      durationMinutes: 60,
      nextStage: "choosing",
      options: expect.any(Array),
    });
    expect(repository.transitions[0].options).toHaveLength(2);
    expect(reply?.actions?.map((action) => action.text)).toEqual([
      "Choose option 1",
      "Choose option 2",
      "Not now",
    ]);
  });

  it("offers one target-relative recovery only after a conclusive pre-target no-fit", async () => {
    const repository = new Repository();
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
      `c:${intentId}:1:duration_60`,
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
