import { describe, expect, it, vi } from "vitest";
import type { DecisionContextFields } from "../decision/schema.js";
import {
  confirmationSummary,
  type DraftReference,
} from "../confirmation.js";
import type { WorkWindow } from "../scheduling/availability.js";
import {
  isEligibleWorkSessionCandidate,
  parseWorkSessionAction,
  type WorkSessionAvailabilityChecker,
  type WorkSessionCommitter,
  type WorkSessionDraftSnapshot,
  WorkSessionFlow,
  type WorkSessionFlowRepository,
  type WorkSessionFlowTransition,
  type WorkSessionFlowTransitionResult,
  workSessionPlanningOffer,
} from "./flow.js";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-27T00:00:00.000Z");
const TARGET = "2026-07-28T18:00:00+08:00";
const OPTION_ONE = {
  endAt: "2026-07-27T10:00:00+08:00",
  startAt: "2026-07-27T09:00:00+08:00",
} as const;
const OPTION_TWO = {
  endAt: "2026-07-27T12:00:00+08:00",
  startAt: "2026-07-27T11:00:00+08:00",
} as const;
const OWNER_WINDOW = {
  endAt: "2026-07-27T15:00:00+08:00",
  startAt: "2026-07-27T14:00:00+08:00",
} as const;
const OWNER_WINDOW_45 = {
  endAt: "2026-07-27T14:45:00+08:00",
  startAt: "2026-07-27T14:00:00+08:00",
} as const;

const possibleWorkFields: DecisionContextFields = {
  definitionOfDone: "Finish the bounded work note",
  durationMinutes: null,
  offerWorkWindowHelp: false,
  possibleWorkSession: true,
  simpleAction: false,
  targetAt: TARGET,
  targetTimeZone: "Asia/Singapore",
  timingConstraints: [],
};

function initialSnapshot(
  overrides: Partial<WorkSessionDraftSnapshot> = {},
): WorkSessionDraftSnapshot {
  return {
    calendarAttemptedAt: null,
    calendarCheckedAt: null,
    conflictConsent: false,
    definitionOfDone: "Finish the bounded work note",
    durationMinutes: null,
    finalObservation: null,
    id: ID,
    options: [],
    selectedWindow: null,
    stage: "offer_help",
    targetAt: TARGET,
    timingConstraints: null,
    version: 1,
    ...overrides,
  };
}

class MemoryRepository implements WorkSessionFlowRepository {
  snapshot: WorkSessionDraftSnapshot;
  readonly finalizations: unknown[] = [];
  readonly transitions: WorkSessionFlowTransition[] = [];
  readonly seenUpdates = new Set<number>();
  readKind: "current" | "expired" | "missing" | "stale" = "current";

  constructor(snapshot = initialSnapshot()) {
    this.snapshot = snapshot;
  }

  async finalizeConversation(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    result: "domain_error" | "expired" | "invalid" | "stale",
  ) {
    this.finalizations.push({ chatId, reference, result, updateId });
    return { kind: "applied" as const };
  }

  async read(reference: DraftReference) {
    if (this.readKind !== "current") {
      return { kind: this.readKind } as const;
    }
    return reference.id === this.snapshot.id &&
        reference.version === this.snapshot.version
      ? { kind: "current" as const, snapshot: this.snapshot }
      : { kind: "stale" as const };
  }

  async transition(
    command: WorkSessionFlowTransition,
  ): Promise<WorkSessionFlowTransitionResult> {
    this.transitions.push(command);
    if (this.seenUpdates.has(command.updateId)) {
      return { kind: "replay" };
    }
    this.seenUpdates.add(command.updateId);
    if (
      command.reference.id !== this.snapshot.id ||
      command.reference.version !== this.snapshot.version ||
      command.expectedStage !== this.snapshot.stage
    ) {
      return { kind: "stale" };
    }
    const has = (key: keyof WorkSessionFlowTransition) =>
      Object.hasOwn(command, key);
    this.snapshot = {
      ...this.snapshot,
      calendarAttemptedAt: has("calendarAttemptedAt")
        ? command.calendarAttemptedAt ?? null
        : this.snapshot.calendarAttemptedAt,
      calendarCheckedAt: has("calendarCheckedAt")
        ? command.calendarCheckedAt ?? null
        : this.snapshot.calendarCheckedAt,
      conflictConsent: has("conflictConsent")
        ? command.conflictConsent ?? this.snapshot.conflictConsent
        : this.snapshot.conflictConsent,
      durationMinutes:
        command.durationMinutes ?? this.snapshot.durationMinutes,
      finalObservation: has("finalObservation")
        ? command.finalObservation ?? null
        : this.snapshot.finalObservation,
      options: command.options ?? [],
      selectedWindow: has("selectedWindow")
        ? command.selectedWindow ?? null
        : this.snapshot.selectedWindow,
      stage: command.nextStage,
      timingConstraints:
        command.timingConstraints ?? this.snapshot.timingConstraints,
      version: this.snapshot.version + 1,
    };
    return { kind: "applied", snapshot: this.snapshot };
  }

  async cancel(
    updateId: number,
    chatId: number,
    reference: DraftReference,
    expectedStage: WorkSessionDraftSnapshot["stage"],
  ) {
    return this.transition({
      chatId,
      expectedStage,
      nextStage: expectedStage,
      reference,
      updateId,
    });
  }

  async declinePreparation(
    updateId: number,
    _chatId: number,
    reference: DraftReference,
  ) {
    if (this.seenUpdates.has(updateId)) {
      return { kind: "replay" as const };
    }
    this.seenUpdates.add(updateId);
    if (
      reference.id !== this.snapshot.id ||
      reference.version !== this.snapshot.version ||
      this.snapshot.stage !== "offer_help"
    ) {
      return { kind: "stale" as const };
    }
    this.snapshot = {
      ...this.snapshot,
      version: this.snapshot.version + 1,
    };
    return {
      draft: {
        definitionOfDone: this.snapshot.definitionOfDone,
        id: this.snapshot.id,
        targetAt: this.snapshot.targetAt,
        version: this.snapshot.version,
      },
      kind: "applied" as const,
    };
  }
}

function checker(
  ...results: Awaited<ReturnType<WorkSessionAvailabilityChecker>>[]
) {
  const availability = vi.fn<WorkSessionAvailabilityChecker>();
  for (const result of results) {
    availability.mockResolvedValueOnce(result);
  }
  return availability;
}

function setup(
  repository = new MemoryRepository(),
  availability = checker(),
  prepareApproval?: NonNullable<
    ConstructorParameters<typeof WorkSessionFlow>[0]["prepareApproval"]
  >,
) {
  const commit = vi.fn<WorkSessionCommitter["commit"]>(
    async () => ({ kind: "applied" }),
  );
  return {
    availability,
    commit,
    flow: new WorkSessionFlow({
      availability,
      committer: { commit },
      now: () => NOW,
      prepareApproval,
      repository,
    }),
    repository,
  };
}

function callback(
  snapshot: WorkSessionDraftSnapshot,
  action: string,
): string {
  return `w:${snapshot.id}:${snapshot.version}:${action}`;
}

describe("work-session planning entry", () => {
  it("offers planning only for a complete eligible possible-work candidate without a supplied window", () => {
    expect(isEligibleWorkSessionCandidate(possibleWorkFields)).toBe(true);
    expect(
      isEligibleWorkSessionCandidate(possibleWorkFields, OPTION_ONE),
    ).toBe(false);
    for (const fields of [
      { ...possibleWorkFields, possibleWorkSession: false, simpleAction: true },
      { ...possibleWorkFields, definitionOfDone: null },
      { ...possibleWorkFields, targetAt: null, targetTimeZone: null },
      { ...possibleWorkFields, offerWorkWindowHelp: true },
    ]) {
      expect(isEligibleWorkSessionCandidate(fields)).toBe(false);
    }

    expect(
      workSessionPlanningOffer(possibleWorkFields, {
        id: ID,
        version: 3,
      }),
    ).toEqual({
      actions: [
        {
          callbackData: `w:${ID}:3:help`,
          text: "Help me find time",
        },
        {
          callbackData: `w:${ID}:3:owner_time`,
          text: "I’ll choose a time",
        },
        {
          callbackData: `w:${ID}:3:no_preparation`,
          text: "No preparation needed",
        },
        {
          callbackData: `w:${ID}:3:cancel`,
          text: "Cancel",
        },
      ],
      text:
        "Do you need preparation time for this promise? Nothing has been saved yet.",
    });
  });

  it("accepts only strict bounded application-owned work callbacks", () => {
    expect(parseWorkSessionAction(`w:${ID}:7:option_2`)).toEqual({
      action: "option_2",
      id: ID,
      version: 7,
    });
    for (const value of [
      `w:${ID}:0:help`,
      `w:${ID}:7:delete`,
      `W:${ID}:7:help`,
      `w:${ID}:7:help:extra`,
      "w:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA:7:help",
      { modelGeneratedAuthority: true },
      "private event title",
    ]) {
      expect(parseWorkSessionAction(value)).toBeNull();
    }
  });
});

describe("WorkSessionFlow", () => {
  it("accepts a natural 45-minute constrained answer and offers only sanitized free windows", async () => {
    const availability = checker({
      alternatives: [OWNER_WINDOW_45],
      checkedAt: "2026-07-27T00:01:00.000Z",
      proposed: null,
      status: "available",
    });
    const test = setup(new MemoryRepository(), availability);

    const reply = await test.flow.handleConversationInput(7990, 42, {
      draftId: ID,
      draftVersion: 1,
      durationMinutes: 45,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: true,
      startAt: null,
      timingConstraints: "mon,wed 08:00-12:00",
    });

    expect(availability).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMinutes: 45,
        timingConstraints: "mon,wed 08:00-12:00",
      }),
    );
    expect(test.repository.snapshot).toMatchObject({
      durationMinutes: 45,
      options: [OWNER_WINDOW_45],
      stage: "choosing",
    });
    expect(reply?.text).toContain("available work windows");
    expect(JSON.stringify(reply)).not.toMatch(
      /private|title|attendee|description/i,
    );
  });

  it("carries a natural 45-minute owner-selected time through free, busy, and unavailable Calendar outcomes", async () => {
    const cases = [
      {
        expectedStage: "confirming",
        expectedText: "Please confirm",
        result: {
          alternatives: [],
          checkedAt: "2026-07-27T00:01:00.000Z",
          proposed: { status: "free", window: OWNER_WINDOW_45 },
          status: "available",
        },
      },
      {
        expectedStage: "conflict_choice",
        expectedText: "conflicts with your Calendar",
        result: {
          alternatives: [],
          checkedAt: "2026-07-27T00:01:00.000Z",
          proposed: {
            status: "conflict",
            window: OWNER_WINDOW_45,
          },
          status: "available",
        },
      },
      {
        expectedStage: "unverified_confirming",
        expectedText: "couldn’t verify",
        result: { status: "provider_failure" },
      },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const prepareApproval = vi.fn(async () => true);
      const test = setup(
        new MemoryRepository(),
        checker(item.result),
        prepareApproval,
      );
      const reply = await test.flow.handleConversationInput(
        7991 + index,
        42,
        {
          draftId: ID,
          draftVersion: 1,
          durationMinutes: 45,
          followUpQuestion: null,
          nextInput: null,
          preparationRequired: true,
          startAt: OWNER_WINDOW_45.startAt,
          timingConstraints: null,
        },
      );

      expect(test.repository.snapshot).toMatchObject({
        durationMinutes: 45,
        selectedWindow: OWNER_WINDOW_45,
        stage: item.expectedStage,
      });
      expect(reply?.text).toContain(item.expectedText);
      expect(JSON.stringify(reply)).not.toMatch(
        /private|title|attendee|description/i,
      );
      expect(prepareApproval).toHaveBeenCalledTimes(
        item.expectedStage === "conflict_choice" ? 0 : 1,
      );
    }
  });

  it("accepts a 1440-minute owner window across midnight and rejects a non-boundary start terminally", async () => {
    const fullDay = {
      endAt: "2026-07-29T00:00:00+08:00",
      startAt: "2026-07-28T00:00:00+08:00",
    };
    const valid = setup(
      new MemoryRepository(),
      checker({
        alternatives: [],
        checkedAt: "2026-07-27T00:01:00.000Z",
        proposed: { status: "free", window: fullDay },
        status: "available",
      }),
      vi.fn(async () => true),
    );

    await valid.flow.handleConversationInput(7994, 42, {
      draftId: ID,
      draftVersion: 1,
      durationMinutes: 1_440,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: true,
      startAt: fullDay.startAt,
      timingConstraints: null,
    });

    expect(valid.repository.snapshot.selectedWindow).toEqual(fullDay);
    expect(valid.repository.snapshot.durationMinutes).toBe(1_440);

    const invalid = setup(new MemoryRepository(), checker());
    await expect(
      invalid.flow.handleConversationInput(7995, 42, {
        draftId: ID,
        draftVersion: 1,
        durationMinutes: 45,
        followUpQuestion: null,
        nextInput: null,
        preparationRequired: true,
        startAt: "2026-07-28T08:15:00+08:00",
        timingConstraints: null,
      }),
    ).resolves.toEqual({
      text:
        "Use an exact future Singapore time on a 30-minute boundary. I didn’t change the draft.",
    });
    expect(invalid.availability).not.toHaveBeenCalled();
    expect(invalid.repository.finalizations).toEqual([
      expect.objectContaining({ result: "invalid", updateId: 7995 }),
    ]);
  });

  it("turns a natural no-preparation answer into the exact same-run creation approval and rejects stale focus", async () => {
    const prepareApproval = vi.fn(async () => true);
    const test = setup(
      new MemoryRepository(),
      checker(),
      prepareApproval,
    );
    const noPreparation = {
      draftId: ID,
      draftVersion: 1,
      durationMinutes: null,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: false,
      startAt: null,
      timingConstraints: null,
    } as const;

    const reply = await test.flow.handleConversationInput(
      7995,
      42,
      noPreparation,
    );
    expect(reply?.text).toContain("Please confirm");
    expect(prepareApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({ id: ID, version: 2 }),
        updateId: 7995,
      }),
    );

    await expect(
      test.flow.handleConversationInput(7996, 42, noPreparation),
    ).resolves.toEqual({
      text: "That action is stale. I didn’t change anything.",
    });
    expect(test.repository.finalizations).toEqual([
      expect.objectContaining({ result: "stale", updateId: 7996 }),
    ]);
  });

  it.each([
    ["expired", "expired"],
    ["missing", "stale"],
    ["stale", "stale"],
  ] as const)(
    "terminally finalizes a typed answer when its draft read is %s",
    async (readKind, result) => {
      const repository = new MemoryRepository();
      repository.readKind = readKind;
      const test = setup(repository);

      await test.flow.handleConversationInput(7997, 42, {
        draftId: ID,
        draftVersion: 1,
        durationMinutes: 45,
        followUpQuestion: null,
        nextInput: null,
        preparationRequired: true,
        startAt: null,
        timingConstraints: "mon 08:00-12:00",
      });

      expect(repository.finalizations).toEqual([
        expect.objectContaining({ result, updateId: 7997 }),
      ]);
    },
  );

  it("terminally finalizes typed domain failures without retrying Calendar", async () => {
    const repository = new MemoryRepository();
    const availability = vi.fn(async () => {
      throw new Error("provider internals");
    });
    const test = setup(repository, availability);

    await expect(
      test.flow.handleConversationInput(7998, 42, {
        draftId: ID,
        draftVersion: 1,
        durationMinutes: 45,
        followUpQuestion: null,
        nextInput: null,
        preparationRequired: true,
        startAt: null,
        timingConstraints: "mon 08:00-12:00",
      }),
    ).resolves.toEqual({
      text:
        "I couldn’t safely prepare this preparation step. Nothing was saved. Send another message to continue this draft.",
    });
    expect(repository.finalizations).toEqual([
      expect.objectContaining({ result: "domain_error", updateId: 7998 }),
    ]);
    expect(availability).toHaveBeenCalledTimes(1);
  });

  it("propagates a typed preparation finalizer failure instead of returning normal success copy", async () => {
    const repository = new MemoryRepository();
    vi.spyOn(repository, "finalizeConversation").mockRejectedValueOnce(
      new Error("finalizer unavailable"),
    );
    const availability = vi.fn(async () => {
      throw new Error("provider internals");
    });
    const test = setup(repository, availability);

    await expect(
      test.flow.handleConversationInput(7999, 42, {
        draftId: ID,
        draftVersion: 1,
        durationMinutes: 45,
        followUpQuestion: null,
        nextInput: null,
        preparationRequired: true,
        startAt: null,
        timingConstraints: "mon 08:00-12:00",
      }),
    ).rejects.toThrow("finalizer unavailable");
    expect(availability).toHaveBeenCalledTimes(1);
  });

  it("converts declined preparation into a fresh simple confirmation without side effects", async () => {
    const prepareApproval = vi.fn(async () => true);
    const test = setup(
      new MemoryRepository(),
      checker(),
      prepareApproval,
    );
    const offered = test.repository.snapshot;

    await expect(
      test.flow.handle(
        8000,
        42,
        callback(offered, "no_preparation"),
      ),
    ).resolves.toEqual(
      confirmationSummary(
        {
          definitionOfDone: offered.definitionOfDone,
          targetAt: offered.targetAt,
        },
        { id: offered.id, version: offered.version + 1 },
      ),
    );

    expect(test.repository.snapshot.version).toBe(2);
    expect(prepareApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 42,
        decision: expect.objectContaining({
          commitmentMode: "simple_action",
        }),
        draft: expect.objectContaining({ id: ID, version: 2 }),
        updateId: 8000,
      }),
    );
    expect(test.availability).not.toHaveBeenCalled();
    expect(test.commit).not.toHaveBeenCalled();
    await expect(
      test.flow.handle(
        8001,
        42,
        callback(offered, "no_preparation"),
      ),
    ).resolves.toEqual({
      text: "That action is stale. I didn’t change anything.",
    });
  });

  it("shows final work Confirm only after the durable version is approval-staged", async () => {
    const repository = new MemoryRepository(
      initialSnapshot({
        calendarCheckedAt: "2026-07-27T00:01:00.000Z",
        durationMinutes: 60,
        options: [OPTION_ONE],
        stage: "choosing",
        timingConstraints: "default",
        version: 5,
      }),
    );
    const prepareApproval = vi.fn(async (request) => {
      expect(repository.snapshot).toMatchObject({
        selectedWindow: OPTION_ONE,
        stage: "confirming",
        version: 6,
      });
      expect(request.draft).toEqual({ id: ID, version: 6 });
      return true;
    });
    const test = setup(repository, checker(), prepareApproval);

    const reply = await test.flow.handle(
      8002,
      42,
      callback(repository.snapshot, "option_1"),
    );

    expect(prepareApproval).toHaveBeenCalledOnce();
    expect(reply?.actions?.map((item) => item.text)).toEqual([
      "Confirm",
      "Cancel",
    ]);
  });

  it("strips final work actions when approval staging fails", async () => {
    const repository = new MemoryRepository(
      initialSnapshot({
        calendarCheckedAt: "2026-07-27T00:01:00.000Z",
        durationMinutes: 60,
        options: [OPTION_ONE],
        stage: "choosing",
        timingConstraints: "default",
        version: 5,
      }),
    );
    const test = setup(
      repository,
      checker(),
      vi.fn(async () => false),
    );

    await expect(
      test.flow.handle(
        8003,
        42,
        callback(repository.snapshot, "option_1"),
      ),
    ).resolves.toEqual({
      text:
        "I couldn’t safely prepare this preparation step. Nothing was saved. Send another message to continue this draft.",
    });
  });

  it("collects duration and strict constraints before showing at most two sanitized choices", async () => {
    const availability = checker({
      alternatives: [OPTION_ONE, OPTION_TWO],
      checkedAt: "2026-07-27T00:01:00.000Z",
      proposed: null,
      status: "available",
    });
    const test = setup(new MemoryRepository(), availability);

    const offered = test.repository.snapshot;
    const durationReply = await test.flow.handle(
      8001,
      42,
      callback(offered, "help"),
    );
    expect(durationReply?.actions).toHaveLength(4);
    expect(test.availability).not.toHaveBeenCalled();

    const awaitingDuration = test.repository.snapshot;
    const constraintsReply = await test.flow.handle(
      8002,
      42,
      callback(awaitingDuration, "duration_60"),
    );
    expect(constraintsReply?.text).toContain("Use `default`");
    expect(test.availability).not.toHaveBeenCalled();

    const awaitingConstraints = test.repository.snapshot;
    const choices = await test.flow.submitTimingConstraints(
      8003,
      42,
      awaitingConstraints,
      "mon 08:00-18:00",
    );
    expect(choices?.actions?.map((item) => item.text)).toEqual([
      "Choose option 1",
      "Choose option 2",
      "Choose my time",
      "Cancel",
    ]);
    expect(JSON.stringify(choices)).not.toMatch(
      /private|title|attendee|description/i,
    );
    expect(test.repository.snapshot).toMatchObject({
      durationMinutes: 60,
      options: [OPTION_ONE, OPTION_TWO],
      stage: "choosing",
      timingConstraints: "mon 08:00-18:00",
      version: 4,
    });
    expect(test.commit).not.toHaveBeenCalled();
  });

  it("invalidates every superseded action without another Calendar call or consequence", async () => {
    const test = setup();
    const original = test.repository.snapshot;
    await test.flow.handle(8010, 42, callback(original, "help"));

    await expect(
      test.flow.handle(8011, 42, callback(original, "help")),
    ).resolves.toEqual({
      text: "That action is stale. I didn’t change anything.",
    });
    expect(test.availability).not.toHaveBeenCalled();
    expect(test.commit).not.toHaveBeenCalled();
  });

  it("persists a final free observation factually while retaining prior conflict consent only in audit", async () => {
    const availability = checker(
      {
        alternatives: [OPTION_ONE, OPTION_TWO],
        checkedAt: "2026-07-27T00:02:00.000Z",
        proposed: { status: "conflict", window: OWNER_WINDOW },
        status: "available",
      },
      {
        alternatives: [],
        checkedAt: "2026-07-27T00:03:00.000Z",
        proposed: { status: "free", window: OWNER_WINDOW },
        status: "available",
      },
    );
    const test = setup(new MemoryRepository(), availability);

    await test.flow.handle(
      8020,
      42,
      callback(test.repository.snapshot, "owner_time"),
    );
    await test.flow.handle(
      8021,
      42,
      callback(test.repository.snapshot, "duration_60"),
    );
    const conflict = await test.flow.submitOwnerTime(
      8022,
      42,
      test.repository.snapshot,
      OWNER_WINDOW.startAt,
    );
    expect(conflict?.text).toContain("conflicts with your Calendar");
    expect(test.commit).not.toHaveBeenCalled();

    const keep = await test.flow.handle(
      8023,
      42,
      callback(test.repository.snapshot, "keep"),
    );
    expect(keep?.text).toContain(
      "You chose to keep the conflicting time.",
    );
    expect(test.commit).not.toHaveBeenCalled();

    const saved = await test.flow.handle(
      8024,
      42,
      callback(test.repository.snapshot, "confirm"),
    );
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirm",
        calendar: {
          attemptedAt: NOW.toISOString(),
          checkedAt: "2026-07-27T00:03:00.000Z",
          conflictConsent: true,
          finalObservation: "free",
          status: "free",
        },
        chatId: 42,
        expectedStage: "conflict_confirming",
        selectedWindow: OWNER_WINDOW,
        updateId: 8024,
      }),
    );
    expect(test.repository.snapshot.stage).toBe("conflict_confirming");
    expect(saved?.text).toContain("Start reminder:");
    expect(saved?.text).toContain("End check-in:");
    expect(saved?.text).toContain("Google Calendar was not changed.");
    expect(saved?.text).not.toMatch(/kept|conflict/i);
  });

  it("blocks a newly conflicting final recheck and requires a new keep confirmation", async () => {
    const snapshot = initialSnapshot({
      calendarAttemptedAt: "2026-07-27T00:01:00.000Z",
      calendarCheckedAt: "2026-07-27T00:01:00.000Z",
      durationMinutes: 60,
      selectedWindow: OWNER_WINDOW,
      stage: "confirming",
      timingConstraints: "default",
      version: 9,
    });
    const test = setup(
      new MemoryRepository(snapshot),
      checker({
        alternatives: [OPTION_ONE],
        checkedAt: "2026-07-27T00:05:00.000Z",
        proposed: { status: "conflict", window: OWNER_WINDOW },
        status: "available",
      }),
    );

    const reply = await test.flow.handle(
      8030,
      42,
      callback(snapshot, "confirm"),
    );
    expect(reply?.text).toContain(
      "now conflicts with your Calendar, so I did not save it",
    );
    expect(reply?.actions?.map((item) => item.text)).toContain(
      "Keep conflicting time",
    );
    expect(test.repository.snapshot.stage).toBe("conflict_choice");
    expect(test.commit).not.toHaveBeenCalled();
  });

  it("leaves the authorized draft untouched when the atomic committer fails", async () => {
    const snapshot = initialSnapshot({
      calendarAttemptedAt: "2026-07-27T00:01:00.000Z",
      calendarCheckedAt: "2026-07-27T00:01:00.000Z",
      durationMinutes: 60,
      selectedWindow: OWNER_WINDOW,
      stage: "confirming",
      timingConstraints: "default",
      version: 11,
    });
    const test = setup(
      new MemoryRepository(snapshot),
      checker({
        alternatives: [],
        checkedAt: "2026-07-27T00:06:00.000Z",
        proposed: { status: "free", window: OWNER_WINDOW },
        status: "available",
      }),
    );
    test.commit.mockRejectedValueOnce(new Error("transaction failed"));

    await expect(
      test.flow.handle(
        8035,
        42,
        callback(snapshot, "confirm"),
      ),
    ).rejects.toThrow("transaction failed");

    expect(test.repository.snapshot).toEqual(snapshot);
    expect(test.repository.transitions).toHaveLength(0);
  });

  it("offers a distinct unverified action only for a concrete selection and commits it once", async () => {
    const snapshot = initialSnapshot({
      durationMinutes: 60,
      selectedWindow: OWNER_WINDOW,
      stage: "confirming",
      timingConstraints: "default",
      version: 4,
    });
    const test = setup(
      new MemoryRepository(snapshot),
      checker({ status: "unavailable" }),
    );

    const unavailable = await test.flow.handle(
      8040,
      42,
      callback(snapshot, "confirm"),
    );
    expect(unavailable?.actions?.map((item) => item.text)).toContain(
      "Save without Calendar check",
    );
    expect(test.commit).not.toHaveBeenCalled();

    const saved = await test.flow.handle(
      8041,
      42,
      callback(test.repository.snapshot, "save_unverified"),
    );
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "save_unverified",
        calendar: expect.objectContaining({
          attemptedAt: NOW.toISOString(),
          checkedAt: null,
          finalObservation: "unavailable",
          status: "unverified",
        }),
        expectedStage: "unverified_confirming",
        updateId: 8041,
      }),
    );
    expect(saved?.text).toContain("saved without a Calendar check");
    expect(saved?.text).toContain("Google Calendar was not changed.");
  });

  it("offers reconnect without unverified save before a concrete time exists", async () => {
    const snapshot = initialSnapshot({
      durationMinutes: 60,
      stage: "availability_unavailable",
      timingConstraints: "default",
      version: 6,
    });
    const test = setup(
      new MemoryRepository(snapshot),
      checker({ status: "authorization_expired" }),
    );

    const reply = await test.flow.handle(
      8050,
      42,
      callback(snapshot, "check_again"),
    );
    const actions = reply?.actions?.map((item) => item.text);
    expect(actions).toEqual([
      "Reconnect",
      "Check again",
      "Choose my time",
      "Cancel",
    ]);
    expect(actions).not.toContain("Save without Calendar check");
    expect(test.commit).not.toHaveBeenCalled();

    const transitionCount = test.repository.transitions.length;
    const reconnect = await test.flow.handle(
      8051,
      42,
      callback(test.repository.snapshot, "reconnect"),
    );
    expect(reconnect).toEqual({
      text:
        "Reconnect Google Calendar from the protected dashboard, then press Check again.",
    });
    expect(test.repository.transitions).toHaveLength(transitionCount);
  });

  it("creates no consequence for malformed, unauthorized, replayed, cancelled, or inspected actions", async () => {
    const test = setup();
    await expect(
      test.flow.handle(8060, 42, "model:commit:anything"),
    ).resolves.toEqual({
      text: "That action isn’t valid. I didn’t change anything.",
    });

    test.repository.readKind = "missing";
    await expect(
      test.flow.handle(
        8061,
        999,
        callback(test.repository.snapshot, "help"),
      ),
    ).resolves.toEqual({
      text: "That action is stale. I didn’t change anything.",
    });
    test.repository.readKind = "current";

    const beforeCancel = test.repository.snapshot;
    await test.flow.handle(
      8062,
      42,
      callback(beforeCancel, "cancel"),
    );
    await test.flow.handle(
      8062,
      42,
      callback(test.repository.snapshot, "cancel"),
    );

    expect(test.availability).not.toHaveBeenCalled();
    expect(test.commit).not.toHaveBeenCalled();
    expect(JSON.stringify(test.repository.transitions)).not.toMatch(
      /event|attendee|description|modelGeneratedAuthority/i,
    );
  });
});
