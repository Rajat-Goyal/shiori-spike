import { describe, expect, it, vi } from "vitest";
import type {
  DecisionAttemptCount,
  DecisionEngine,
  DecisionFailureClass,
  DecisionFailureStage,
  DecisionOutcome,
} from "../decision/engine.js";
import { OpenAIDecisionEngine } from "../decision/engine.js";
import type {
  DecisionContextFields,
  DecisionResult,
} from "../decision/schema.js";
import {
  confirmationCopy,
  confirmationSummary,
} from "../confirmation.js";
import {
  collectedDraftCopy,
  collisionCopy,
  conversationCopy,
  correctionCopy,
} from "../conversation/copy.js";
import type {
  ActiveDraft,
  ConversationApplyResult,
  ConversationCommand,
  ConversationReadResult,
  ConversationRepository,
  DecisionAudit,
  PermissionCandidate,
} from "../conversation/repository.js";
import { ConversationService } from "../conversation/service.js";
import { workSessionPlanningOffer } from "../work-sessions/flow.js";

const completeFields: DecisionContextFields = {
  definitionOfDone: "Submit the synthetic note",
  durationMinutes: null,
  offerWorkWindowHelp: false,
  possibleWorkSession: false,
  simpleAction: true,
  targetAt: "2026-07-27T10:00:00+08:00",
  targetTimeZone: "Asia/Singapore",
  timingConstraints: ["Before lunch"],
};
const incompleteFields: DecisionContextFields = {
  ...completeFields,
  definitionOfDone: null,
  simpleAction: false,
  targetAt: null,
  targetTimeZone: null,
};
const targetMissingFields: DecisionContextFields = {
  ...completeFields,
  simpleAction: false,
  targetAt: null,
  targetTimeZone: null,
};
const workFields: DecisionContextFields = {
  ...completeFields,
  possibleWorkSession: true,
  simpleAction: false,
};

function decision(
  fields: DecisionContextFields,
  options: Partial<DecisionResult> = {},
): DecisionResult {
  const missingFields: DecisionResult["missingFields"] = [];
  if (fields.definitionOfDone === null) {
    missingFields.push("definition_of_done");
  }
  if (fields.targetAt === null) {
    missingFields.push("target");
  }
  const nextAction =
    missingFields[0] === "definition_of_done"
      ? "ask_definition"
      : missingFields[0] === "target"
        ? "ask_target"
        : fields.possibleWorkSession
          ? "offer_work_window"
          : "ready";
  return {
    commitmentMode: fields.simpleAction
      ? "simple_action"
      : fields.possibleWorkSession
        ? "possible_work_session"
        : "unresolved",
    definitionOfDone: fields.definitionOfDone,
    durationMinutes: fields.durationMinutes,
    inputClass: "explicit_commitment",
    missingFields,
    nextAction,
    offerWorkWindowHelp: fields.offerWorkWindowHelp,
    response: "Provider response that application copy does not trust.",
    targetAt: fields.targetAt,
    targetTimeZone: fields.targetTimeZone,
    timingConstraints: fields.timingConstraints,
    turnRelation: "new_request",
    ...options,
  };
}

function ordinary(
  response = "A bounded synthetic answer.",
  turnRelation: DecisionResult["turnRelation"] = "none",
): DecisionResult {
  return {
    definitionOfDone: null,
    durationMinutes: null,
    inputClass: "ordinary_question",
    missingFields: [],
    nextAction: "answer",
    offerWorkWindowHelp: false,
    commitmentMode: "unresolved",
    response,
    targetAt: null,
    targetTimeZone: null,
    timingConstraints: [],
    turnRelation,
  };
}

function implied(
  fields: DecisionContextFields = incompleteFields,
): DecisionResult {
  return {
    ...decision(fields, {
      inputClass: "implied_intention",
    }),
    missingFields: [],
    nextAction: "ask_permission",
    response: "Provider permission wording is not used.",
    turnRelation: "new_request",
  };
}

function activeDraft(
  phase: ActiveDraft["phase"],
  fields: DecisionContextFields,
  version = 3,
): ActiveDraft {
  return {
    expiresAt: "2026-07-26T16:00:00.000Z",
    fields,
    id: "11111111-1111-4111-8111-111111111111",
    kind: "draft",
    phase,
    version,
  };
}

function permissionCandidate(
  fields: DecisionContextFields = completeFields,
): PermissionCandidate {
  return {
    correlatedUpdateId: 7002,
    expiresAt: "2026-07-26T16:00:00.000Z",
    fields,
    id: "22222222-2222-4222-8222-222222222222",
    kind: "permission",
    sourceUpdateId: 7001,
  };
}

class ControlledRepository implements ConversationRepository {
  readonly audits: DecisionAudit[] = [];
  readonly commands: Array<Record<string, unknown>> = [];
  applyResult: ConversationApplyResult = {
    completed: true,
    draftReference: {
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
    },
    draftCreated: false,
    status: "applied",
  };

  constructor(readonly readResult: ConversationReadResult) {}

  async applyTurn(
    command: ConversationCommand,
  ): Promise<ConversationApplyResult> {
    const { audit, ...withoutAudit } = command;
    if (audit) {
      this.audits.push(audit);
    }
    this.commands.push(withoutAudit);
    return {
      ...this.applyResult,
      draftCreated:
        this.applyResult.draftCreated ||
        command.action === "create_draft" ||
        command.action === "accept_work_permission",
    };
  }

  async readTurn(): Promise<ConversationReadResult> {
    return this.readResult;
  }
}

function controlled(
  snapshot: ConversationReadResult,
  outcome: DecisionOutcome,
) {
  const repository = new ControlledRepository(snapshot);
  const decisionFailureEvents = vi.fn();
  const decisionRetryRecoveredEvents = vi.fn();
  const decisionEngine: DecisionEngine = {
    decide: vi.fn(async () => outcome),
  };
  const service = new ConversationService({
    decisionEngine,
    modelId: "gpt-test-model",
    onDecisionFailure: decisionFailureEvents,
    onDecisionRetryRecovered: decisionRetryRecoveredEvents,
    promptVersion: "shiori-test-v1",
    repository,
  });
  return {
    decide: vi.mocked(decisionEngine.decide),
    decisionFailureEvents,
    decisionRetryRecoveredEvents,
    repository,
    service,
  };
}

function success(result: DecisionResult): DecisionOutcome {
  return { decision: result, ok: true };
}

const failureStage = {
  http: "request",
  provider_error: "provider",
  incomplete: "completion",
  refusal: "completion",
  missing_output: "completion",
  non_json: "schema",
  schema: "schema",
  semantic: "semantic",
  timeout: "request",
} as const satisfies Record<DecisionFailureClass, DecisionFailureStage>;

function failureOutcome(
  failure: DecisionFailureClass,
  attemptCount: DecisionAttemptCount = 1,
): DecisionOutcome {
  return {
    attemptCount,
    failure,
    ok: false,
    stage: failureStage[failure],
  };
}

function providerResponse(value: unknown): Response {
  return Response.json({
    output: [
      {
        content: [
          {
            text: JSON.stringify(value),
            type: "output_text",
          },
        ],
        status: "completed",
        type: "message",
      },
    ],
    status: "completed",
  });
}

describe("ConversationService", () => {
  it("applies repository state once only after a semantic retry succeeds", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    const validDecision = decision(completeFields);
    const fetchFromOpenAI = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        expect(repository.commands).toHaveLength(0);
        return providerResponse({
          ...validDecision,
          targetTimeZone: "UTC",
        });
      })
      .mockImplementationOnce(async () => {
        expect(repository.commands).toHaveLength(0);
        return providerResponse(validDecision);
      });
    const decisionFailureEvents = vi.fn();
    const decisionRetryRecoveredEvents = vi.fn();
    const service = new ConversationService({
      decisionEngine: new OpenAIDecisionEngine({
        apiKey: "unit-test-api-key",
        fetch: fetchFromOpenAI,
        model: "gpt-test-model",
        now: () => new Date("2026-07-26T00:00:00.000Z"),
        promptVersion: "shiori-test-v1",
      }),
      modelId: "gpt-test-model",
      onDecisionFailure: decisionFailureEvents,
      onDecisionRetryRecovered: decisionRetryRecoveredEvents,
      promptVersion: "shiori-test-v1",
      repository,
    });

    await expect(
      service.handle(7000, "private owner input"),
    ).resolves.toEqual(
      confirmationSummary(completeFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
    );

    expect(fetchFromOpenAI).toHaveBeenCalledTimes(2);
    expect(repository.commands).toHaveLength(1);
    expect(repository.audits).toHaveLength(1);
    expect(decisionFailureEvents).not.toHaveBeenCalled();
    expect(decisionRetryRecoveredEvents).toHaveBeenCalledOnce();
    expect(decisionRetryRecoveredEvents).toHaveBeenCalledWith({
      attemptCount: 2,
      event: "decision_retry_recovered",
      failureClass: "semantic",
      stage: "output_semantic",
    });
    expect(
      Object.keys(decisionRetryRecoveredEvents.mock.calls[0][0]),
    ).toEqual([
      "event",
      "stage",
      "failureClass",
      "attemptCount",
    ]);
    expect(
      JSON.stringify(decisionRetryRecoveredEvents.mock.calls),
    ).not.toMatch(/private|unit-test|UTC|Submit/);
  });

  it.each([
    {
      copy: conversationCopy.missingDefinition,
      fields: incompleteFields,
      phase: "awaiting_definition",
    },
    {
      copy: conversationCopy.missingTarget,
      fields: targetMissingFields,
      phase: "awaiting_target",
    },
    {
      copy: confirmationSummary(completeFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
      fields: completeFields,
      phase: "complete",
    },
  ] as const)(
    "creates a restart-safe simple draft and sends only $phase copy",
    async ({ copy, fields, phase }) => {
      const test = controlled(
        { kind: "none" },
        success(decision(fields)),
      );

      await expect(
        test.service.handle(7000, "private raw owner sentinel"),
      ).resolves.toEqual(copy);
      expect(test.decide).toHaveBeenCalledWith({
        context: { fields: null, phase: "none" },
        ownerText: "private raw owner sentinel",
      });
      expect(test.repository.commands).toEqual([
        {
          action: "create_draft",
          expected: { kind: "none" },
          fields,
          phase,
          processingResult: "conversation",
          updateId: 7000,
        },
      ]);
      expect(JSON.stringify(test.repository.commands)).not.toContain(
        "private raw owner sentinel",
      );
      expect(test.repository.audits).toHaveLength(1);
      expect(test.decisionRetryRecoveredEvents).not.toHaveBeenCalled();
      expect(test.repository.audits[0]).toMatchObject({
        inputClass: "explicit_commitment",
        modelId: "gpt-test-model",
        promptVersion: "shiori-test-v1",
      });
      expect(test.repository.audits[0]).not.toHaveProperty("response");
      expect(JSON.stringify(test.repository.audits)).not.toContain(
        "Provider response that application copy does not trust.",
      );
      if (typeof copy === "string") {
        expect(copy).not.toMatch(/Confirm|Cancel|\/correct/);
      } else {
        expect(copy.actions?.map((action) => action.text)).toEqual([
          "Confirm",
          "Cancel",
        ]);
      }
    },
  );

  it("continues a work-shaped definition-only request against the same awaiting-target draft", async () => {
    const first = controlled(
      { kind: "none" },
      success(decision(targetMissingFields)),
    );

    await expect(
      first.service.handle(7020, "Create and submit the video"),
    ).resolves.toBe(conversationCopy.missingTarget);
    expect(first.repository.commands[0]).toMatchObject({
      action: "create_draft",
      fields: targetMissingFields,
      phase: "awaiting_target",
    });

    const draft = activeDraft("awaiting_target", targetMissingFields, 1);
    const second = controlled(
      draft,
      success(
        decision(workFields, {
          turnRelation: "clarification_continuation",
        }),
      ),
    );

    await second.service.handle(7021, "Tomorrow at 5pm");
    expect(second.decide).toHaveBeenCalledWith({
      context: {
        fields: {
          commitmentMode: "unresolved",
          definitionOfDone: targetMissingFields.definitionOfDone,
          durationMinutes: null,
          offerWorkWindowHelp: false,
          targetAt: null,
          targetTimeZone: null,
          timingConstraints: targetMissingFields.timingConstraints,
        },
        phase: "awaiting_target",
      },
      ownerText: "Tomorrow at 5pm",
    });
    expect(second.repository.commands[0]).toMatchObject({
      action: "update_draft",
      expected: {
        id: draft.id,
        kind: "draft",
        version: draft.version,
      },
      fields: workFields,
      phase: "complete",
    });
  });

  it("stores one bounded permission candidate and uses approved permission copy", async () => {
    const test = controlled({ kind: "none" }, success(implied()));

    await expect(test.service.handle(7001, "Maybe I should do it")).resolves.toBe(
      conversationCopy.impliedPermission,
    );
    expect(test.repository.commands).toEqual([
      {
        action: "create_permission",
        expected: { kind: "none" },
        fields: incompleteFields,
        processingResult: "conversation",
        updateId: 7001,
      },
    ]);
  });

  it("answers an ordinary phase-none question with only one bounded audit mutation", async () => {
    const result = ordinary("A direct bounded answer.");
    const test = controlled({ kind: "none" }, success(result));

    await expect(
      test.service.handle(7003, "private ordinary text"),
    ).resolves.toBe("A direct bounded answer.");
    expect(test.repository.commands).toEqual([
      {
        action: "preserve",
        expected: { kind: "none" },
        processingResult: "conversation",
        updateId: 7003,
      },
    ]);
    expect(test.repository.audits).toEqual([
      {
        inputClass: "ordinary_question",
        modelId: "gpt-test-model",
        payload: {
          commitmentMode: "unresolved",
          definitionOfDone: null,
          durationMinutes: null,
          missingFields: [],
          nextAction: "answer",
          offerWorkWindowHelp: false,
          targetAt: null,
          targetTimeZone: null,
          timingConstraints: [],
          turnRelation: "none",
        },
        promptVersion: "shiori-test-v1",
      },
    ]);
    expect(JSON.stringify(test.repository.commands)).not.toMatch(
      /fields|version|expires|commitment|session|scheduled|event/,
    );
    expect(JSON.stringify(test.repository.audits)).not.toContain(
      "A direct bounded answer.",
    );
  });

  it("accepts permission only by exact stored candidate and passes no candidate mutation fields", async () => {
    const permission = permissionCandidate();
    const test = controlled(
      permission,
      success(
        decision(completeFields, {
          turnRelation: "permission_accepted",
        }),
      ),
    );
    test.repository.applyResult.draftCreated = true;

    await expect(test.service.handle(7002, "yes")).resolves.toEqual(
      confirmationSummary(completeFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
    );
    expect(test.repository.commands).toEqual([
      {
        action: "accept_permission",
        expected: {
          correlatedUpdateId: 7002,
          id: permission.id,
          kind: "permission",
          sourceUpdateId: 7001,
        },
        processingResult: "conversation",
        updateId: 7002,
      },
    ]);
    expect(JSON.stringify(test.repository.commands)).not.toContain(
      completeFields.definitionOfDone,
    );
  });

  it("fails closed when permission acceptance does not exactly match all eight stored fields", async () => {
    const permission = permissionCandidate({
      ...completeFields,
      timingConstraints: ["First", "Second"],
    });
    const test = controlled(
      permission,
      success(
        decision(
          {
            ...permission.fields,
            timingConstraints: ["Second", "First"],
          },
          { turnRelation: "permission_accepted" },
        ),
      ),
    );

    await expect(test.service.handle(7002, "yes")).resolves.toBe(
      conversationCopy.failureNoDraft,
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "preserve",
      processingResult: "conversation_failed",
    });
    expect(test.repository.audits).toHaveLength(0);
  });

  it("accepts an eligible work candidate into the same versioned draft", async () => {
    const permission = permissionCandidate(workFields);
    const test = controlled(
      permission,
      success(
        decision(workFields, {
          turnRelation: "permission_accepted",
        }),
      ),
    );

    await expect(test.service.handle(7002, "yes")).resolves.toEqual(
      workSessionPlanningOffer(workFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "accept_work_permission",
      fields: workFields,
      phase: "complete",
    });
  });

  it.each([
    {
      copy: conversationCopy.decline,
      decision: ordinary("No.", "permission_declined"),
      action: "terminate_permission",
    },
    {
      copy: conversationCopy.permissionUnclear,
      decision: ordinary("Unclear.", "clarification_continuation"),
      action: "rearm_permission",
    },
    {
      copy: "A bounded answer.",
      decision: ordinary("A bounded answer."),
      action: "terminate_permission",
    },
  ] as const)(
    "handles permission response with $action and exact copy",
    async ({ action, copy, decision: result }) => {
      const test = controlled(
        permissionCandidate(),
        success(result),
      );

      await expect(test.service.handle(7002, "owner response")).resolves.toBe(
        copy,
      );
      expect(test.repository.commands[0]).toMatchObject({ action });
    },
  );

  it.each([
    {
      returnedFields: completeFields,
      label: "coincidentally equal",
    },
    {
      returnedFields: {
        ...completeFields,
        definitionOfDone: "A different separate request",
      },
      label: "different",
    },
  ])(
    "treats a $label permission-phase separate request as collision-only",
    async ({ returnedFields }) => {
      const test = controlled(
        permissionCandidate(),
        success(
          decision(returnedFields, {
            turnRelation: "separate_request",
          }),
        ),
      );

      await expect(test.service.handle(7002, "another request")).resolves.toBe(
        conversationCopy.permissionCollision,
      );
      expect(test.repository.commands[0]).toMatchObject({
        action: "rearm_permission",
      });
      expect(JSON.stringify(test.repository.commands)).not.toContain(
        returnedFields.definitionOfDone,
      );
    },
  );

  it.each([
    {
      copy: collectedDraftCopy("awaiting_target"),
      relation: "clarification_continuation",
    },
    {
      copy: correctionCopy("awaiting_target"),
      relation: "correction",
    },
  ] as const)(
    "applies an accepted $relation once against current draft version",
    async ({ copy, relation }) => {
      const snapshot = activeDraft(
        "awaiting_definition",
        incompleteFields,
        5,
      );
      const fields = targetMissingFields;
      const test = controlled(
        snapshot,
        success(decision(fields, { turnRelation: relation })),
      );

      await expect(test.service.handle(7010, "structured update")).resolves.toBe(
        copy,
      );
      expect(test.repository.commands).toEqual([
        {
          action: "update_draft",
          expected: {
            id: snapshot.id,
            kind: "draft",
            version: 5,
          },
          fields,
          phase: "awaiting_target",
          processingResult: "conversation",
          updateId: 7010,
        },
      ]);
    },
  );

  it("accepts a work-shaped clarification and invalidates the prior draft version", async () => {
    const snapshot = activeDraft(
      "awaiting_target",
      targetMissingFields,
      6,
    );
    const test = controlled(
      snapshot,
      success(
        decision(workFields, {
          turnRelation: "clarification_continuation",
        }),
      ),
    );
    test.repository.applyResult = {
      completed: true,
      draftCreated: false,
      draftReference: { id: snapshot.id, version: 7 },
      status: "applied",
    };

    await expect(test.service.handle(7011, "work-shaped")).resolves.toEqual(
      workSessionPlanningOffer(workFields, {
        id: snapshot.id,
        version: 7,
      }),
    );
    expect(test.repository.commands[0]).toEqual({
      action: "update_draft",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 6,
      },
      fields: workFields,
      phase: "complete",
      processingResult: "conversation",
      updateId: 7011,
    });
    expect(test.repository.audits).toHaveLength(1);
  });

  it("rejects clarification relation in complete phase", async () => {
    const snapshot = activeDraft("complete", completeFields, 7);
    const test = controlled(
      snapshot,
      success(
        decision(completeFields, {
          turnRelation: "clarification_continuation",
        }),
      ),
    );

    await expect(test.service.handle(7011, "invalid relation")).resolves.toBe(
      conversationCopy.failureWithDraft,
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "preserve",
      processingResult: "conversation_failed",
    });
  });

  it("increments a complete correction once and binds the full updated summary to the new version", async () => {
    const snapshot = activeDraft("complete", completeFields, 7);
    const correctedFields = {
      ...completeFields,
      definitionOfDone: "Submit the corrected synthetic note",
    };
    const test = controlled(
      snapshot,
      success(
        decision(correctedFields, {
          turnRelation: "correction",
        }),
      ),
    );
    test.repository.applyResult.draftReference = {
      id: snapshot.id,
      version: 8,
    };

    await expect(
      test.service.handle(7012, "correct the current promise"),
    ).resolves.toEqual(
      confirmationSummary(
        correctedFields,
        { id: snapshot.id, version: 8 },
        confirmationCopy.updated,
      ),
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "update_draft",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 7,
      },
      fields: correctedFields,
      phase: "complete",
    });
  });

  it("rejects a correction that would make a complete draft incomplete and rerenders the current version", async () => {
    const snapshot = activeDraft("complete", completeFields, 7);
    const test = controlled(
      snapshot,
      success(
        decision(
          {
            ...completeFields,
            definitionOfDone: null,
          },
          {
            turnRelation: "correction",
          },
        ),
      ),
    );

    await expect(
      test.service.handle(7012, "clear the definition"),
    ).resolves.toEqual(
      confirmationSummary(
        completeFields,
        snapshot,
        confirmationCopy.correctionIncomplete,
      ),
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "preserve",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 7,
      },
    });
  });

  it.each([
    completeFields,
    {
      ...completeFields,
      definitionOfDone: "Different returned candidate",
    },
  ])(
    "ignores every separate-request field and preserves complete draft",
    async (returnedFields) => {
      const snapshot = activeDraft("complete", completeFields, 8);
      const test = controlled(
        snapshot,
        success(
          decision(returnedFields, {
            turnRelation: "separate_request",
          }),
        ),
      );

      await expect(test.service.handle(7012, "second promise")).resolves.toEqual(
        confirmationSummary(
          completeFields,
          snapshot,
          confirmationCopy.secondRequest,
        ),
      );
      expect(test.repository.commands[0]).toEqual({
        action: "preserve",
        expected: {
          id: snapshot.id,
          kind: "draft",
          version: 8,
        },
        processingResult: "conversation",
        updateId: 7012,
      });
      expect(JSON.stringify(test.repository.commands)).not.toContain(
        returnedFields.definitionOfDone,
      );
    },
  );

  it("answers an ordinary question without extending or changing active draft", async () => {
    const snapshot = activeDraft("complete", completeFields, 9);
    const test = controlled(
      snapshot,
      success(ordinary("The bounded answer.")),
    );

    await expect(test.service.handle(7013, "ordinary")).resolves.toBe(
      "The bounded answer.\n\nYour current draft is unchanged.",
    );
    expect(test.repository.commands[0]).toEqual({
      action: "preserve",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 9,
      },
      processingResult: "conversation",
      updateId: 7013,
    });
  });

  it.each([
    {
      copy: conversationCopy.expired,
      read: { completed: true, kind: "expired" },
    },
    {
      copy: conversationCopy.interrupted,
      read: { completed: true, kind: "interrupted" },
    },
    {
      copy: conversationCopy.permissionCollision,
      read: { completed: true, kind: "busy" },
    },
  ] as const)(
    "bypasses the engine for terminal pre-decision state $read.kind",
    async ({ copy, read }) => {
      const test = controlled(
        read,
        success(decision(completeFields)),
      );

      await expect(test.service.handle(7014, "must not reach model")).resolves.toBe(
        copy,
      );
      expect(test.decide).not.toHaveBeenCalled();
      expect(test.repository.commands).toHaveLength(0);
    },
  );

  it.each([
    "http",
    "provider_error",
    "incomplete",
    "refusal",
    "missing_output",
    "non_json",
    "schema",
    "semantic",
    "timeout",
  ] satisfies DecisionFailureClass[])(
    "preserves state for bounded decision failure %s",
    async (failure) => {
      const snapshot = activeDraft("complete", completeFields, 10);
      const test = controlled(snapshot, failureOutcome(failure));

      await expect(test.service.handle(7015, "private sentinel")).resolves.toBe(
        conversationCopy.failureWithDraft,
      );
      expect(test.repository.commands[0]).toEqual({
        action: "preserve",
        expected: {
          id: snapshot.id,
          kind: "draft",
          version: 10,
        },
        processingResult: "conversation_failed",
        updateId: 7015,
      });
      expect(test.repository.audits).toHaveLength(0);
      expect(test.decisionFailureEvents).toHaveBeenCalledOnce();
      expect(test.decisionFailureEvents).toHaveBeenCalledWith({
        attemptCount: 1,
        event: "decision_failure",
        failureClass: failure,
        stage: failureStage[failure],
      });
      const serializedEvent = JSON.stringify(
        test.decisionFailureEvents.mock.calls,
      );
      expect(serializedEvent).not.toContain("private sentinel");
      expect(serializedEvent).not.toContain("unit-test");
      expect(Object.keys(test.decisionFailureEvents.mock.calls[0][0])).toEqual([
        "event",
        "stage",
        "failureClass",
        "attemptCount",
      ]);
    },
  );

  it("keeps the bounded failure response when operational logging fails", async () => {
    const snapshot = activeDraft("complete", completeFields, 10);
    const repository = new ControlledRepository(snapshot);
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => failureOutcome("timeout")),
      },
      modelId: "gpt-test-model",
      onDecisionFailure: () => {
        throw new Error("private logging failure");
      },
      promptVersion: "shiori-test-v1",
      repository,
    });

    await expect(service.handle(7015, "private sentinel")).resolves.toBe(
      conversationCopy.failureWithDraft,
    );
    expect(repository.commands[0]).toMatchObject({
      action: "preserve",
      processingResult: "conversation_failed",
      updateId: 7015,
    });
  });

  it("keeps a recovered decision when recovery logging fails", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => ({
          decision: decision(completeFields),
          ok: true,
          recovery: {
            attemptCount: 2,
            failureClass: "semantic",
            stage: "output_semantic",
          },
        })),
      },
      modelId: "gpt-test-model",
      onDecisionRetryRecovered: () => {
        throw new Error("private recovery logging failure");
      },
      promptVersion: "shiori-test-v1",
      repository,
    });

    await expect(
      service.handle(7016, "private owner input"),
    ).resolves.toEqual(
      confirmationSummary(completeFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
    );
    expect(repository.commands).toHaveLength(1);
    expect(repository.audits).toHaveLength(1);
  });

  it("classifies an unexpected engine rejection as opaque HTTP failure", async () => {
    const snapshot = activeDraft("complete", completeFields, 10);
    const repository = new ControlledRepository(snapshot);
    const decisionFailureEvents = vi.fn();
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => {
          throw new Error("private provider trace and credential");
        }),
      },
      modelId: "gpt-test-model",
      onDecisionFailure: decisionFailureEvents,
      promptVersion: "shiori-test-v1",
      repository,
    });

    await expect(service.handle(7015, "private sentinel")).resolves.toBe(
      conversationCopy.failureWithDraft,
    );
    expect(decisionFailureEvents).toHaveBeenCalledWith({
      attemptCount: 0,
      event: "decision_failure",
      failureClass: "http",
      stage: "request",
    });
    expect(JSON.stringify(decisionFailureEvents.mock.calls)).not.toMatch(
      /private|credential|trace/,
    );
  });

  it.each([
    {
      copy: conversationCopy.expired,
      status: "expired",
    },
    {
      copy: conversationCopy.interrupted,
      status: "interrupted",
    },
    {
      copy: conversationCopy.failureWithDraft,
      status: "stale",
    },
  ] as const)(
    "uses bounded $status result when CAS does not apply",
    async ({ copy, status }) => {
      const snapshot = activeDraft("complete", completeFields);
      const test = controlled(
        snapshot,
        success(ordinary("Answer")),
      );
      test.repository.applyResult.status = status;

      await expect(test.service.handle(7016, "owner input")).resolves.toBe(copy);
    },
  );

  it("throws opaquely if repository does not atomically complete the update", async () => {
    const test = controlled(
      { kind: "none" },
      success(ordinary("Answer")),
    );
    test.repository.applyResult.completed = false;

    await expect(test.service.handle(7017, "private sentinel")).rejects.toThrow(
      "Conversation update was not completed",
    );
  });

  it("binds complete-state actions only to the opaque current draft reference", () => {
    const reply = confirmationSummary(
      completeFields,
      activeDraft("complete", completeFields, 12),
    );

    expect(reply.text).toContain("Nothing has been saved");
    expect(reply.text).not.toContain(reply.actions![0].callbackData);
    expect(reply.actions).toEqual([
      {
        callbackData:
          "d:11111111-1111-4111-8111-111111111111:12:confirm",
        text: "Confirm",
      },
      {
        callbackData:
          "d:11111111-1111-4111-8111-111111111111:12:cancel",
        text: "Cancel",
      },
    ]);
  });
});
