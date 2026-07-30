import { describe, expect, it, vi } from "vitest";
import type {
  DecisionAttemptCount,
  DecisionEngine,
  DecisionFailureClass,
  DecisionFailureStage,
  DecisionOutcome,
  DecisionTelemetryReason,
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
  PatchFocusedDraftCommand,
  PermissionCandidate,
} from "../conversation/repository.js";
import { ConversationService } from "../conversation/service.js";
import { StatusService } from "./status-cancel.js";
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
        command.action === "create_separate_draft" ||
        command.action === "accept_work_permission",
    };
  }

  async patchFocusedDraft(
    command: PatchFocusedDraftCommand,
  ): Promise<ConversationApplyResult> {
    const { audit, expectedFocus, ...withoutAudit } = command;
    this.audits.push(audit);
    this.commands.push({
      action: "update_draft",
      expected: expectedFocus,
      ...withoutAudit,
    });
    return this.applyResult;
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
  const completeTurn = vi.fn();
  const decisionEngine: DecisionEngine = {
    completeTurn,
    decide: vi.fn(async () => {
      if (
        outcome.ok &&
        outcome.draftTarget === undefined &&
        snapshot.kind === "draft" &&
        outcome.decision.turnRelation !== "none"
      ) {
        return {
          ...outcome,
          draftTarget: {
            authority: {
              expectedVersion: snapshot.version,
              id: snapshot.id,
              kind: "draft" as const,
            },
            fields: snapshot.fields,
            phase: snapshot.phase,
          },
        };
      }
      return outcome;
    }),
  };
  const conversationFailureEvents = vi.fn();
  const service = new ConversationService({
    decisionEngine,
    modelId: "gpt-test-model",
    onConversationFailure: conversationFailureEvents,
    onDecisionFailure: decisionFailureEvents,
    onDecisionRetryRecovered: decisionRetryRecoveredEvents,
    promptVersion: "shiori-test-v1",
    repository,
  });
  return {
    completeTurn,
    conversationFailureEvents,
    decide: vi.mocked(decisionEngine.decide),
    decisionFailureEvents,
    decisionRetryRecoveredEvents,
    repository,
    service,
  };
}

function reportedFailureSites(
  events: ReturnType<typeof vi.fn>,
): readonly string[] {
  return events.mock.calls.map(
    ([event]) => (event as { site: string }).site,
  );
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
  reason: DecisionTelemetryReason = failure,
): DecisionOutcome {
  return {
    attemptCount,
    failure,
    ok: false,
    reason,
    stage: failureStage[failure],
  };
}

function providerResponse(value: unknown): Response {
  const providerValue =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "missingFields" in value &&
    "nextAction" in value &&
    "offerWorkWindowHelp" in value &&
    "targetTimeZone" in value
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) =>
              ![
                "missingFields",
                "nextAction",
                "offerWorkWindowHelp",
                "targetTimeZone",
              ].includes(key),
          ),
        )
      : value;
  return Response.json({
    output: [
      {
        content: [
          {
            text: JSON.stringify(providerValue),
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
  it("finalizes an ambiguous clarification before every model-supplied mutation payload", async () => {
    const snapshot = activeDraft("complete", workFields, 7);
    const repository = new ControlledRepository(snapshot);
    const workSessionConversation = {
      handleConversationInput: vi.fn(),
    };
    const continuationConversation = {
      handleDurationInput: vi.fn(),
    };
    const prepareApproval = vi.fn();
    const clarification =
      "Nothing was changed. Which one did you mean: “Draft one”, “Draft two”?";
    const service = new ConversationService({
      continuationConversation,
      decisionEngine: {
        completeTurn: vi.fn(),
        decide: vi.fn(async () => ({
          approval: {
            reply: { text: "Must not be shown" },
            target: {
              id: snapshot.id,
              kind: "draft" as const,
              version: snapshot.version,
            },
          },
          clarification: "ambiguous_reference" as const,
          continuationInput: {
            durationMinutes: 45,
            intentId: "22222222-2222-4222-8222-222222222222",
            intentVersion: 1,
          },
          decision: ordinary(clarification),
          initialWorkSessionInput: {
            durationMinutes: 45,
            followUpQuestion: null,
            nextInput: "owner_time" as const,
            preparationRequired: true,
            startAt: null,
            timingConstraints: null,
          },
          ok: true as const,
          workSessionInput: {
            draftId: snapshot.id,
            draftVersion: snapshot.version,
            durationMinutes: 45,
            followUpQuestion: null,
            nextInput: "owner_time" as const,
            preparationRequired: true,
            startAt: null,
            timingConstraints: null,
          },
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      prepareApproval,
      promptVersion: "shiori-test-v1",
      repository,
      workSessionConversation,
    });

    await expect(
      service.handle(79991, "Use the 45-minute plan for that draft"),
    ).resolves.toBe(clarification);
    expect(repository.commands).toEqual([
      {
        action: "preserve",
        expected: {
          id: snapshot.id,
          kind: "draft",
          version: snapshot.version,
        },
        processingResult: "conversation",
        updateId: 79991,
      },
    ]);
    expect(repository.audits).toHaveLength(1);
    expect(workSessionConversation.handleConversationInput)
      .not.toHaveBeenCalled();
    expect(continuationConversation.handleDurationInput)
      .not.toHaveBeenCalled();
    expect(prepareApproval).not.toHaveBeenCalled();
  });

  it("hands a validated natural preparation answer to the exact deterministic flow without losing focus", async () => {
    const snapshot = activeDraft("complete", workFields, 7);
    const repository = new ControlledRepository(snapshot);
    const completeTurn = vi.fn();
    const workSessionInput = {
      draftId: snapshot.id,
      draftVersion: snapshot.version,
      durationMinutes: 45,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: true,
      startAt: null,
      timingConstraints: "mon,wed 08:00-12:00",
    } as const;
    const workSessionConversation = {
      handleConversationInput: vi.fn(async () => ({
        actions: [
          {
            callbackData: `w:${snapshot.id}:8:option_1`,
            text: "Choose option 1",
          },
        ],
        text: "I found an available work window.",
      })),
    };
    const service = new ConversationService({
      decisionEngine: {
        completeTurn,
        decide: vi.fn(async () => ({
          decision: ordinary(""),
          ok: true,
          workSessionInput,
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      promptVersion: "shiori-test-v1",
      repository,
      workSessionConversation,
    });

    await expect(
      service.handle(7999, "45 minutes Monday morning"),
    ).resolves.toMatchObject({
      text: "I found an available work window.",
    });
    expect(workSessionConversation.handleConversationInput)
      .toHaveBeenCalledWith(7999, 42, workSessionInput);
    expect(repository.commands).toEqual([]);
    expect(completeTurn).toHaveBeenCalledWith({
      activeDraftId: snapshot.id,
      assistantText: "I found an available work window.",
      pendingQuestion: "replace",
      status: "active",
      updateId: 7999,
    });
  });

  it("incorporates explicit preparation facts while creating the promise and skips the redundant generic question", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    repository.applyResult = {
      completed: true,
      draftCreated: true,
      draftReference: {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      },
      status: "applied",
    };
    const completeTurn = vi.fn();
    const workSessionConversation = {
      handleConversationInput: vi.fn(async () => ({
        actions: [{
          callbackData:
            "w:11111111-1111-4111-8111-111111111111:2:option_1",
          text: "Choose option 1",
        }],
        text: "I found an available work window.",
      })),
    };
    const initialWorkSessionInput = {
      durationMinutes: 45,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: true,
      startAt: null,
      timingConstraints: "mon 08:00-12:00",
    } as const;
    const service = new ConversationService({
      decisionEngine: {
        completeTurn,
        decide: vi.fn(async () => ({
          decision: decision(completeFields),
          initialWorkSessionInput,
          ok: true as const,
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      promptVersion: "shiori-test-v1",
      repository,
      workSessionConversation,
    });

    const reply = await service.handle(
      7998,
      "I will submit the note by Sunday; I need 45 minutes Monday morning.",
    );

    expect(repository.commands).toEqual([
      expect.objectContaining({
        action: "create_draft",
        fields: expect.objectContaining({
          durationMinutes: 45,
          possibleWorkSession: true,
          simpleAction: false,
          timingConstraints: ["mon 08:00-12:00"],
        }),
      }),
    ]);
    expect(workSessionConversation.handleConversationInput)
      .toHaveBeenCalledWith(7998, 42, {
        draftId: "11111111-1111-4111-8111-111111111111",
        draftVersion: 1,
        ...initialWorkSessionInput,
      });
    expect(reply).toMatchObject({
      text: "I found an available work window.",
    });
    expect(JSON.stringify(reply)).not.toContain(
      "Do you need preparation time",
    );
    expect(completeTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a relative target duration out of preparation and asks the mandatory question", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    repository.applyResult = {
      completed: true,
      draftCreated: true,
      draftReference: {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      },
      status: "applied",
    };
    const workSessionConversation = {
      handleConversationInput: vi.fn(),
    };
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => ({
          decision: decision(workFields),
          ok: true as const,
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      promptVersion: "shiori-test-v1",
      repository,
      workSessionConversation,
    });

    const reply = await service.handle(
      79981,
      "Remind me to stretch in 45 minutes",
    );

    expect(repository.commands[0]).toMatchObject({
      action: "create_draft",
      fields: expect.objectContaining({
        durationMinutes: null,
        possibleWorkSession: true,
      }),
    });
    expect(reply).toEqual(
      workSessionPlanningOffer(workFields, {
        id: repository.applyResult.draftReference!.id,
        version: repository.applyResult.draftReference!.version,
      }),
    );
    expect(workSessionConversation.handleConversationInput)
      .not.toHaveBeenCalled();
  });

  it("asks for an explicit preparation duration without borrowing the target duration", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    repository.applyResult = {
      completed: true,
      draftCreated: true,
      draftReference: {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      },
      status: "applied",
    };
    const initialWorkSessionInput = {
      durationMinutes: null,
      followUpQuestion: "How long do you need to prepare?",
      nextInput: "duration",
      preparationRequired: true,
      startAt: null,
      timingConstraints: null,
    } as const;
    const workSessionConversation = {
      handleConversationInput: vi.fn(async () => ({
        text: "How long do you need to prepare?",
      })),
    };
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => ({
          decision: decision(workFields),
          initialWorkSessionInput,
          ok: true as const,
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      promptVersion: "shiori-test-v1",
      repository,
      workSessionConversation,
    });

    const reply = await service.handle(
      79982,
      "Submit in 45 minutes; I need to prepare",
    );

    expect(repository.commands[0]).toMatchObject({
      action: "create_draft",
      fields: expect.objectContaining({
        durationMinutes: null,
        possibleWorkSession: true,
      }),
    });
    expect(workSessionConversation.handleConversationInput)
      .toHaveBeenCalledWith(79982, 42, {
        draftId: repository.applyResult.draftReference!.id,
        draftVersion: repository.applyResult.draftReference!.version,
        ...initialWorkSessionInput,
      });
    expect(reply).toEqual({
      text: "How long do you need to prepare?",
    });
  });

  it("incorporates explicit no-preparation while creating the promise and proceeds to exact approval", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    repository.applyResult = {
      completed: true,
      draftCreated: true,
      draftReference: {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      },
      status: "applied",
    };
    const prepareApproval = vi.fn(async () => true);
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => ({
          decision: decision(workFields),
          initialWorkSessionInput: {
            durationMinutes: null,
            followUpQuestion: null,
            nextInput: null,
            preparationRequired: false,
            startAt: null,
            timingConstraints: null,
          },
          ok: true as const,
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      prepareApproval,
      promptVersion: "shiori-test-v1",
      repository,
    });

    const reply = await service.handle(
      7997,
      "I will submit the note by Sunday. No preparation needed.",
    );

    expect(repository.commands[0]).toMatchObject({
      action: "create_draft",
      fields: {
        durationMinutes: null,
        possibleWorkSession: false,
        simpleAction: true,
      },
    });
    expect(reply).toEqual(
      confirmationSummary(
        completeFields,
        repository.applyResult.draftReference!,
      ),
    );
    expect(prepareApproval).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reply)).not.toContain(
      "Do you need preparation time",
    );
  });

  it("dispatches /status inside the unified boundary and preserves draft interaction authority", async () => {
    const snapshot = activeDraft(
      "awaiting_target",
      targetMissingFields,
      8,
    );
    const repository = new ControlledRepository(snapshot);
    repository.applyResult = {
      completed: true,
      draftCreated: false,
      draftReference: { id: snapshot.id, version: snapshot.version },
      status: "applied",
    };
    const completeTurn = vi.fn();
    const decide = vi.fn();
    const service = new ConversationService({
      decisionEngine: { completeTurn, decide },
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository,
      statusService: new StatusService({
        now: () => new Date("2026-07-25T03:00:00.000Z"),
        repository: {
          listActive: vi.fn(async () => [{
            calendarCheckedAt: null,
            calendarStatus: null,
            definitionOfDone: "Submit the authoritative note",
            id: "22222222-2222-4222-8222-222222222222",
            nextAt: "2026-07-25T02:00:00.000Z",
            nextKind: "simple_reminder",
            targetAt: "2026-07-25T02:00:00.000Z",
            version: 1,
          }]),
        },
      }),
    });

    const replies = await service.handle(6999, "/status");

    expect(decide).not.toHaveBeenCalled();
    expect(replies).toEqual([
      expect.objectContaining({
        actions: [
          {
            callbackData:
              "p:22222222-2222-4222-8222-222222222222:1:done",
            text: "Done",
          },
          {
            callbackData:
              "p:22222222-2222-4222-8222-222222222222:1:cancel",
            text: "Cancel",
          },
        ],
        text: expect.stringContaining("Submit the authoritative note"),
      }),
    ]);
    expect(repository.commands).toEqual([{
      action: "preserve",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: snapshot.version,
      },
      processingResult: "status_listed",
      updateId: 6999,
    }]);
    expect(completeTurn).toHaveBeenCalledWith({
      activeDraftId: snapshot.id,
      assistantText: expect.stringContaining(
        "Submit the authoritative note",
      ),
      pendingQuestion: "preserve",
      status: "unchanged",
      updateId: 6999,
    });
  });

  it("returns exact empty /status copy through the unified boundary", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    const decide = vi.fn();
    const service = new ConversationService({
      decisionEngine: { decide },
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository,
      statusService: new StatusService({
        repository: { listActive: vi.fn(async () => []) },
      }),
    });

    await expect(service.handle(6998, "/status")).resolves.toEqual([
      { text: "No active promises." },
    ]);
    expect(decide).not.toHaveBeenCalled();
    expect(repository.commands).toEqual([{
      action: "preserve",
      expected: { kind: "none" },
      processingResult: "status_empty",
      updateId: 6998,
    }]);
  });

  it("distinguishes an unconfirmed draft from no active promises without leaking its fields", async () => {
    const snapshot = activeDraft("awaiting_target", targetMissingFields, 8);
    const repository = new ControlledRepository(snapshot) as
      ControlledRepository & {
        listDrafts: () => Promise<{
          drafts: readonly unknown[];
          nextCursor: null;
        }>;
      };
    repository.listDrafts = vi.fn(async () => ({
      drafts: [snapshot],
      nextCursor: null,
    }));
    const service = new ConversationService({
      decisionEngine: { decide: vi.fn() },
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository,
      statusService: new StatusService({
        repository: { listActive: vi.fn(async () => []) },
      }),
    });

    const reply = await service.handle(6997, "/status");

    expect(reply).toEqual([{
      text:
        "No active promises. You have an unconfirmed draft in progress.",
    }]);
    expect(JSON.stringify(reply)).not.toContain(
      snapshot.fields.definitionOfDone,
    );
  });

  it("handles exact /reset before reading state or calling the model", async () => {
    const readTurn = vi.fn();
    const decide = vi.fn();
    const service = new ConversationService({
      decisionEngine: { decide },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      promptVersion: "shiori-test-v1",
      repository: {
        applyTurn: vi.fn(),
        patchFocusedDraft: vi.fn(),
        readTurn,
      },
    });

    await expect(service.handle(6996, "/reset")).resolves.toBe(
      conversationCopy.reset,
    );
    expect(readTurn).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("applies repository state once only after a semantic retry succeeds", async () => {
    const repository = new ControlledRepository({ kind: "none" });
    const validDecision = decision(completeFields);
    const fetchFromOpenAI = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        expect(repository.commands).toHaveLength(0);
        return providerResponse({
          ...validDecision,
          targetAt: "2026-02-30T10:00:00+08:00",
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
      workSessionPlanningOffer(workFields, {
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
      reason: "target_format_invalid",
    });
    expect(
      Object.keys(decisionRetryRecoveredEvents.mock.calls[0][0]),
    ).toEqual([
      "event",
      "attemptCount",
      "reason",
    ]);
    expect(
      JSON.stringify(decisionRetryRecoveredEvents.mock.calls),
    ).not.toMatch(/private|unit-test|2026-02-30|Submit/);
  });

  it.each([
    {
      copy: conversationCopy.missingDefinition,
      fields: incompleteFields,
      phase: "awaiting_definition",
      storedFields: incompleteFields,
    },
    {
      copy: conversationCopy.missingTarget,
      fields: targetMissingFields,
      phase: "awaiting_target",
      storedFields: targetMissingFields,
    },
    {
      copy: workSessionPlanningOffer(workFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
      fields: completeFields,
      phase: "complete",
      storedFields: workFields,
    },
  ] as const)(
    "creates a restart-safe draft and sends only $phase copy",
    async ({ copy, fields, phase, storedFields }) => {
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
      }, { updateId: 7000 });
      expect(test.repository.commands).toEqual([
        {
          action: "create_draft",
          expected: { kind: "none" },
          fields: storedFields,
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
        expect(copy.actions?.map((action) => action.text)).toEqual(
          phase === "complete"
            ? [
                "Help me find time",
                "I’ll choose a time",
                "No preparation needed",
                "Cancel",
              ]
            : ["Confirm", "Cancel"],
        );
      }
    },
  );

  it("asks permission for a separate implied intention while preserving the old draft as the exact precondition", async () => {
    const snapshot = activeDraft("complete", completeFields, 8);
    const impliedFields = {
      ...incompleteFields,
      definitionOfDone: "Finish revamping the prototype",
    };
    const test = controlled(
      snapshot,
      {
        decision: decision(impliedFields, {
          inputClass: "implied_intention",
          missingFields: [],
          nextAction: "ask_permission",
          turnRelation: "separate_request",
        }),
        draftTarget: {
          authority: {
            expectedVersion: snapshot.version,
            id: snapshot.id,
            kind: "draft",
          },
          fields: snapshot.fields,
          phase: snapshot.phase,
        },
        ok: true,
      } as Extract<DecisionOutcome, { ok: true }>,
    );

    await expect(
      test.service.handle(
        70123,
        "I have to finish revamping my prototype based on the new details shared by April",
      ),
    ).resolves.toBe(conversationCopy.impliedPermission);
    expect(test.repository.commands[0]).toMatchObject({
      action: "create_permission",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: snapshot.version,
      },
      fields: {
        definitionOfDone: "Finish revamping the prototype",
        targetAt: null,
      },
      updateId: 70123,
    });
  });

  it("gives controlled future-target guidance when an overdue complete draft is continued unchanged", async () => {
    const snapshot = activeDraft("complete", completeFields, 8);
    const test = controlled(
      snapshot,
      failureOutcome("semantic", 1, "target_not_future"),
    );

    await expect(
      test.service.handle(70124, "Keep the current target"),
    ).resolves.toBe(conversationCopy.overdueTarget);
  });

  it("continues a work-shaped definition-only request against the same awaiting-target draft", async () => {
    const definitionOnlyWorkFields: DecisionContextFields = {
      ...targetMissingFields,
      durationMinutes: 30,
    };
    const completedWorkFields: DecisionContextFields = {
      ...workFields,
      durationMinutes: 30,
    };
    const first = controlled(
      { kind: "none" },
      success(decision(definitionOnlyWorkFields)),
    );

    await expect(
      first.service.handle(7020, "Create and submit the video"),
    ).resolves.toBe(conversationCopy.missingTarget);
    expect(first.repository.commands[0]).toMatchObject({
      action: "create_draft",
      fields: definitionOnlyWorkFields,
      phase: "awaiting_target",
    });

    const draft = activeDraft(
      "awaiting_target",
      definitionOnlyWorkFields,
      1,
    );
    const second = controlled(
      draft,
      success(
        decision(completedWorkFields, {
          turnRelation: "clarification_continuation",
        }),
      ),
    );

    await second.service.handle(7021, "Tomorrow at 5pm");
    expect(second.decide).toHaveBeenCalledWith({
      context: {
        fields: {
          commitmentMode: "unresolved",
          definitionOfDone:
            definitionOnlyWorkFields.definitionOfDone,
          durationMinutes: 30,
          offerWorkWindowHelp: false,
          targetAt: null,
          targetTimeZone: null,
          timingConstraints:
            definitionOnlyWorkFields.timingConstraints,
        },
        phase: "awaiting_target",
      },
      ownerText: "Tomorrow at 5pm",
    }, { updateId: 7021 });
    expect(second.repository.commands[0]).toMatchObject({
      action: "update_draft",
      expected: {
        id: draft.id,
        kind: "draft",
        version: draft.version,
      },
      fields: completedWorkFields,
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

  it("retains an implied definition and target through exact Yes acceptance without asking for the target again", async () => {
    const first = controlled(
      { kind: "none" },
      success(implied(completeFields)),
    );

    await expect(
      first.service.handle(
        7001,
        "I should submit the synthetic note by 27 July 10am",
      ),
    ).resolves.toBe(conversationCopy.impliedPermission);
    expect(first.repository.commands[0]).toMatchObject({
      action: "create_permission",
      fields: completeFields,
    });

    const stored = permissionCandidate(completeFields);
    const second = controlled(
      stored,
      success(
        decision(completeFields, {
          turnRelation: "permission_accepted",
        }),
      ),
    );
    second.repository.applyResult.draftCreated = true;

    const reply = await second.service.handle(7002, "Yes");
    expect(reply).toEqual(
      workSessionPlanningOffer(workFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
    );
    expect(reply).not.toBe(conversationCopy.missingTarget);
    expect(second.decide).toHaveBeenCalledWith({
      context: {
        fields: {
          commitmentMode: "simple_action",
          definitionOfDone: completeFields.definitionOfDone,
          durationMinutes: completeFields.durationMinutes,
          offerWorkWindowHelp: false,
          targetAt: completeFields.targetAt,
          targetTimeZone: completeFields.targetTimeZone,
          timingConstraints: completeFields.timingConstraints,
        },
        phase: "awaiting_permission",
      },
      ownerText: "Yes",
    }, { updateId: 7002 });
    expect(second.repository.commands[0]).toMatchObject({
      action: "accept_work_permission",
      fields: workFields,
      phase: "complete",
    });
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
          definitionOfDone: null,
          durationMinutes: null,
          missingFields: [],
          nextAction: "answer",
          offerWorkWindowHelp: false,
          possibleWorkSession: false,
          simpleAction: false,
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
    expect(
      Object.keys(test.repository.audits[0]!.payload).sort(),
    ).toEqual([
      "definitionOfDone",
      "durationMinutes",
      "missingFields",
      "nextAction",
      "offerWorkWindowHelp",
      "possibleWorkSession",
      "simpleAction",
      "targetAt",
      "targetTimeZone",
      "timingConstraints",
      "turnRelation",
    ]);
    expect(test.repository.audits[0]!.payload).not.toHaveProperty(
      "commitmentMode",
    );
  });

  it("accepts only the exact stored candidate and enters preparation on permission acceptance", async () => {
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
      workSessionPlanningOffer(workFields, {
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
      }),
    );
    expect(test.repository.commands).toEqual([
      {
        action: "accept_work_permission",
        expected: {
          correlatedUpdateId: 7002,
          id: permission.id,
          kind: "permission",
          sourceUpdateId: 7001,
        },
        fields: workFields,
        phase: "complete",
        processingResult: "conversation",
        updateId: 7002,
      },
    ]);
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
      action: "preserve",
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
      copy: conversationCopy.targetFailureWithDraft,
      expected: {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "draft",
        version: 10,
      } as const,
      read: activeDraft("awaiting_target", targetMissingFields, 10),
      reason: "target_not_future",
      text: "Tomorrow 9am",
    },
    {
      copy: conversationCopy.targetFailureNoDraft,
      expected: { kind: "none" } as const,
      read: { kind: "none" } as const,
      reason: "target_timezone_invalid",
      text:
        "I have to create a video for telegram setup by tomorrow 9am",
    },
  ] as const)(
    "finalizes targeted future-date guidance for $reason without candidate or audit writes",
    async ({ copy, expected, read, reason, text }) => {
      const test = controlled(
        read,
        failureOutcome("semantic", 2, reason),
      );

      await expect(test.service.handle(7015, text)).resolves.toBe(copy);
      expect(test.repository.commands).toEqual([
        {
          action: "preserve",
          expected,
          processingResult: "conversation_failed",
          updateId: 7015,
        },
      ]);
      expect(test.repository.audits).toHaveLength(0);
      expect(test.decisionFailureEvents).toHaveBeenCalledWith({
        attemptCount: 2,
        event: "decision_failure",
        reason,
      });
      expect(
        Object.keys(test.decisionFailureEvents.mock.calls[0][0]),
      ).toEqual(["event", "attemptCount", "reason"]);
      expect(
        JSON.stringify(test.decisionFailureEvents.mock.calls),
      ).not.toMatch(/Tomorrow|telegram|2026|9am|gpt|private/);
    },
  );

  it("uses targeted date guidance when an awaiting-target clarification extracts nothing", async () => {
    const snapshot = activeDraft(
      "awaiting_target",
      targetMissingFields,
      10,
    );
    const test = controlled(
      snapshot,
      failureOutcome(
        "semantic",
        2,
        "clarification_filled_nothing",
      ),
    );

    await expect(
      test.service.handle(7015, "29 July 9am"),
    ).resolves.toBe(conversationCopy.targetFailureWithDraft);
    expect(test.repository.commands).toEqual([
      {
        action: "preserve",
        expected: {
          id: snapshot.id,
          kind: "draft",
          version: snapshot.version,
        },
        processingResult: "conversation_failed",
        updateId: 7015,
      },
    ]);
    expect(test.repository.audits).toHaveLength(0);
  });

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
          target: {
            expectedVersion: 5,
            id: snapshot.id,
            kind: "draft",
          },
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
      target: {
        expectedVersion: 6,
        id: snapshot.id,
        kind: "draft",
      },
      updateId: 7011,
    });
    expect(test.repository.audits).toHaveLength(1);
  });

  it("enters preparation when a simple-shaped clarification first completes a draft", async () => {
    const snapshot = activeDraft(
      "awaiting_target",
      targetMissingFields,
      6,
    );
    const test = controlled(
      snapshot,
      success(
        decision(completeFields, {
          turnRelation: "clarification_continuation",
        }),
      ),
    );
    test.repository.applyResult.draftReference = {
      id: snapshot.id,
      version: 7,
    };

    await expect(
      test.service.handle(7011, "tomorrow at 10"),
    ).resolves.toEqual(
      workSessionPlanningOffer(workFields, {
        id: snapshot.id,
        version: 7,
      }),
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "update_draft",
      fields: workFields,
      phase: "complete",
    });
  });

  it("focuses and patches the exact uniquely referenced parked draft", async () => {
    const focused = activeDraft(
      "awaiting_target",
      targetMissingFields,
      8,
    );
    const parkedId = "22222222-2222-4222-8222-222222222222";
    const parkedFields = {
      ...targetMissingFields,
      definitionOfDone: "Review the finance report",
    };
    const completedParkedFields = {
      ...parkedFields,
      simpleAction: true,
      targetAt: "2026-07-28T10:00:00+08:00",
      targetTimeZone: "Asia/Singapore",
    };
    const test = controlled(
      focused,
      {
        decision: decision(completedParkedFields, {
          turnRelation: "clarification_continuation",
        }),
        draftTarget: {
          authority: {
            expectedVersion: 2,
            id: parkedId,
            kind: "draft",
          },
          fields: parkedFields,
          phase: "awaiting_target",
        },
        ok: true,
      },
    );
    test.repository.applyResult = {
      completed: true,
      draftCreated: false,
      draftReference: { id: parkedId, version: 3 },
      status: "applied",
    };

    const reply = await test.service.handle(
      70115,
      "Move the finance report to 28 July at 10am",
    );

    expect(reply).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          callbackData: expect.stringContaining(`${parkedId}:3:`),
        }),
      ]),
    });
    expect(test.repository.commands[0]).toMatchObject({
      action: "update_draft",
      expected: {
        id: focused.id,
        kind: "draft",
        version: focused.version,
      },
      fields: {
        definitionOfDone: "Review the finance report",
        targetAt: "2026-07-28T10:00:00+08:00",
      },
      target: {
        expectedVersion: 2,
        id: parkedId,
        kind: "draft",
      },
    });
  });

  it("fails closed when exact parked-draft authority is stale", async () => {
    const focused = activeDraft(
      "awaiting_target",
      targetMissingFields,
      8,
    );
    const parkedId = "22222222-2222-4222-8222-222222222222";
    const parkedFields = {
      ...targetMissingFields,
      definitionOfDone: "Review the finance report",
    };
    const test = controlled(
      focused,
      {
        decision: decision({
          ...parkedFields,
          simpleAction: true,
          targetAt: "2026-07-28T10:00:00+08:00",
          targetTimeZone: "Asia/Singapore",
        }, {
          turnRelation: "clarification_continuation",
        }),
        draftTarget: {
          authority: {
            expectedVersion: 2,
            id: parkedId,
            kind: "draft",
          },
          fields: parkedFields,
          phase: "awaiting_target",
        },
        ok: true,
      },
    );
    test.repository.applyResult = {
      completed: true,
      draftCreated: false,
      status: "stale",
    };

    await expect(
      test.service.handle(70116, "Move the finance report"),
    ).resolves.toBe(conversationCopy.failureWithDraft);
    expect(test.repository.commands).toHaveLength(1);
    expect(test.repository.commands[0]).toMatchObject({
      target: {
        expectedVersion: 2,
        id: parkedId,
        kind: "draft",
      },
    });
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

  it("keeps a post-No-preparation simple correction on direct versioned confirmation", async () => {
    const snapshot = activeDraft("complete", completeFields, 7);
    const correctedFields = {
      ...completeFields,
      definitionOfDone: "Submit the corrected synthetic note",
    };
    const test = controlled(
      snapshot,
      success(
        decision(
          {
            ...correctedFields,
            possibleWorkSession: true,
            simpleAction: false,
          },
          {
            turnRelation: "correction",
          },
        ),
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

  it("keeps an already-complete possible-work correction in the preparation path", async () => {
    const snapshot = activeDraft("complete", workFields, 7);
    const correctedFields = {
      ...workFields,
      definitionOfDone: "Submit the corrected synthetic note",
    };
    const test = controlled(
      snapshot,
      success(
        decision(
          {
            ...correctedFields,
            durationMinutes: null,
            possibleWorkSession: false,
            simpleAction: true,
          },
          {
            turnRelation: "correction",
          },
        ),
      ),
    );
    test.repository.applyResult.draftReference = {
      id: snapshot.id,
      version: 8,
    };

    await expect(
      test.service.handle(7012, "correct the current promise"),
    ).resolves.toEqual(
      workSessionPlanningOffer(
        correctedFields,
        { id: snapshot.id, version: 8 },
        confirmationCopy.updated,
      ),
    );
    expect(test.repository.commands[0]).toMatchObject({
      action: "update_draft",
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
    "creates and focuses a separate draft without overwriting the current one",
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
      test.repository.applyResult = {
        completed: true,
        draftCreated: true,
        draftReference: {
          id: "33333333-3333-4333-8333-333333333333",
          version: 1,
        },
        status: "applied",
      };

      const reply = await test.service.handle(7012, "second promise");
      expect(reply).toMatchObject({
        text: "Do you need preparation time for this promise? Nothing has been saved yet.",
      });
      expect(test.repository.commands[0]).toMatchObject({
        action: "create_separate_draft",
        expected: {
          id: snapshot.id,
          kind: "draft",
          version: 8,
        },
        fields: {
          definitionOfDone: returnedFields.definitionOfDone,
          possibleWorkSession: true,
          simpleAction: false,
        },
        phase: "complete",
        processingResult: "conversation",
        updateId: 7012,
      });
      expect(test.repository.commands[0]).not.toMatchObject({
        action: "update_draft",
      });
    },
  );

  it("creates and focuses the exact separate smoke promise while preserving target and preparation roles", async () => {
    const snapshot = activeDraft("complete", completeFields, 8);
    const repository = new ControlledRepository(snapshot);
    repository.applyResult = {
      completed: true,
      draftCreated: true,
      draftReference: {
        id: "33333333-3333-4333-8333-333333333333",
        version: 1,
      },
      status: "applied",
    };
    const initialWorkSessionInput = {
      durationMinutes: 45,
      followUpQuestion: null,
      nextInput: null,
      preparationRequired: true,
      startAt: null,
      timingConstraints: "fri 08:00-12:00",
    } as const;
    const workSessionConversation = {
      handleConversationInput: vi.fn(async () => ({
        actions: [{
          callbackData:
            "w:33333333-3333-4333-8333-333333333333:2:option_1",
          text: "Choose option 1",
        }],
        text: "I found an available work window.",
      })),
    };
    const smokeFields = {
      ...completeFields,
      definitionOfDone: "Review the Slice 02 smoke notes",
      durationMinutes: null,
      possibleWorkSession: true,
      simpleAction: false,
      targetAt: "2026-07-31T17:00:00+08:00",
      timingConstraints: [],
    };
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => ({
          decision: decision(smokeFields, {
            turnRelation: "separate_request",
          }),
          draftTarget: {
            authority: {
              expectedVersion: snapshot.version,
              id: snapshot.id,
              kind: "draft" as const,
            },
            fields: snapshot.fields,
            phase: snapshot.phase,
          },
          initialWorkSessionInput,
          ok: true as const,
        })),
      },
      modelId: "gpt-test-model",
      ownerChatId: 42,
      promptVersion: "shiori-test-v1",
      repository,
      workSessionConversation,
    });

    const reply = await service.handle(
      70121,
      "I promise to review the Slice 02 smoke notes by tomorrow at 5:00 PM Singapore time. I need 45 minutes to prepare tomorrow morning.",
    );

    expect(repository.commands[0]).toMatchObject({
      action: "create_separate_draft",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 8,
      },
      fields: {
        definitionOfDone: "Review the Slice 02 smoke notes",
        durationMinutes: 45,
        possibleWorkSession: true,
        simpleAction: false,
        targetAt: "2026-07-31T17:00:00+08:00",
        timingConstraints: ["fri 08:00-12:00"],
      },
      phase: "complete",
      updateId: 70121,
    });
    expect(repository.commands[0]).not.toMatchObject({
      action: "update_draft",
    });
    expect(workSessionConversation.handleConversationInput)
      .toHaveBeenCalledWith(70121, 42, {
        draftId: "33333333-3333-4333-8333-333333333333",
        draftVersion: 1,
        ...initialWorkSessionInput,
      });
    expect(reply).toMatchObject({
      text: "I found an available work window.",
    });
  });

  it("logs invalid draft authority classification without mutating the old draft", async () => {
    const snapshot = activeDraft("complete", completeFields, 8);
    const test = controlled(
      snapshot,
      failureOutcome("semantic", 1, "draft_target_invalid"),
    );

    await expect(
      test.service.handle(70122, "private malformed separate promise"),
    ).resolves.toBe(conversationCopy.failureWithDraft);
    expect(test.repository.commands).toEqual([{
      action: "preserve",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 8,
      },
      processingResult: "conversation_failed",
      updateId: 70122,
    }]);
    expect(test.repository.audits).toHaveLength(0);
    expect(test.decisionFailureEvents).toHaveBeenCalledWith({
      attemptCount: 1,
      event: "decision_failure",
      reason: "draft_target_invalid",
    });
    expect(JSON.stringify(test.decisionFailureEvents.mock.calls))
      .not.toContain("private malformed separate promise");
  });

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
    expect(test.completeTurn).toHaveBeenCalledWith({
      activeDraftId: snapshot.id,
      assistantText:
        "The bounded answer.\n\nYour current draft is unchanged.",
      pendingQuestion: "preserve",
      status: "active",
      updateId: 7013,
    });
  });

  it("preserves the pending draft question across an ordinary answer and advances the same exact draft afterward", async () => {
    const snapshot = activeDraft(
      "awaiting_target",
      targetMissingFields,
      12,
    );
    const repository = new ControlledRepository(snapshot);
    repository.applyResult = {
      completed: true,
      draftCreated: false,
      draftReference: { id: snapshot.id, version: 12 },
      status: "applied",
    };
    const completeTurn = vi.fn();
    const decide = vi
      .fn()
      .mockResolvedValueOnce(success(ordinary("Singapore is UTC+08:00.")))
      .mockResolvedValueOnce({
        decision: decision({
          ...targetMissingFields,
          simpleAction: true,
          targetAt: "2026-07-30T10:00:00+08:00",
          targetTimeZone: "Asia/Singapore",
        }, {
          turnRelation: "clarification_continuation",
        }),
        draftTarget: {
          authority: {
            expectedVersion: 12,
            id: snapshot.id,
            kind: "draft",
          },
          fields: snapshot.fields,
          phase: snapshot.phase,
        },
        ok: true,
      });
    const service = new ConversationService({
      decisionEngine: { completeTurn, decide },
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository,
    });

    await service.handle(70131, "What timezone is Singapore?");
    repository.applyResult = {
      completed: true,
      draftCreated: false,
      draftReference: { id: snapshot.id, version: 13 },
      status: "applied",
    };
    await service.handle(70132, "30 July at 10am");

    expect(completeTurn.mock.calls[0][0]).toMatchObject({
      activeDraftId: snapshot.id,
      pendingQuestion: "preserve",
      status: "active",
    });
    expect(repository.commands[0]).toMatchObject({
      action: "preserve",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 12,
      },
    });
    expect(repository.commands[1]).toMatchObject({
      action: "update_draft",
      expected: {
        id: snapshot.id,
        kind: "draft",
        version: 12,
      },
      target: {
        expectedVersion: 12,
        id: snapshot.id,
        kind: "draft",
      },
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

  it("clears expired permission context and restores read-time draft focus", async () => {
    const restored = {
      id: "88888888-8888-4888-8888-888888888888",
      version: 6,
    };
    const test = controlled(
      {
        completed: true,
        draftReference: restored,
        kind: "interrupted",
      },
      success(decision(completeFields)),
    );

    await expect(
      test.service.handle(70141, "must not reach model"),
    ).resolves.toBe(conversationCopy.interrupted);
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.completeTurn).toHaveBeenCalledWith({
      activeDraftId: restored.id,
      assistantText: conversationCopy.interrupted,
      pendingQuestion: "clear",
      status: "active",
      updateId: 70141,
    });
  });

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
        reason: failure,
      });
      const serializedEvent = JSON.stringify(
        test.decisionFailureEvents.mock.calls,
      );
      expect(serializedEvent).not.toContain("private sentinel");
      expect(serializedEvent).not.toContain("unit-test");
      expect(Object.keys(test.decisionFailureEvents.mock.calls[0][0])).toEqual([
        "event",
        "attemptCount",
        "reason",
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
            reason: "target_format_invalid",
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
      workSessionPlanningOffer(workFields, {
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
      reason: "http",
    });
    expect(JSON.stringify(decisionFailureEvents.mock.calls)).not.toMatch(
      /private|credential|trace/,
    );
  });

  it("reports the real cause behind an engine rejection classified as HTTP", async () => {
    class SupabaseSessionError extends Error {}
    const snapshot = activeDraft("complete", completeFields, 10);
    const repository = new ControlledRepository(snapshot);
    const decisionFailureEvents = vi.fn();
    const engineFailureEvents = vi.fn();
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => {
          throw new SupabaseSessionError(
            "private provider trace and credential",
          );
        }),
      },
      modelId: "gpt-test-model",
      onDecisionFailure: decisionFailureEvents,
      onEngineFailure: engineFailureEvents,
      promptVersion: "shiori-test-v1",
      repository,
    });

    // The fail-closed reply and the opaque "http" class stay unchanged; the new
    // event is the only way to tell a Supabase outage from a provider outage.
    await expect(service.handle(7015, "private sentinel")).resolves.toBe(
      conversationCopy.failureWithDraft,
    );
    expect(decisionFailureEvents).toHaveBeenCalledWith({
      attemptCount: 0,
      event: "decision_failure",
      reason: "http",
    });
    expect(engineFailureEvents).toHaveBeenCalledTimes(1);
    const [event] = engineFailureEvents.mock.calls[0] as [
      { failureChain: string[]; failureFrames: string[] },
    ];
    expect(event.failureChain).toEqual(["SupabaseSessionError"]);
    expect(event.failureFrames.length).toBeGreaterThan(0);
    expect(JSON.stringify(engineFailureEvents.mock.calls)).not.toMatch(
      /private|credential|trace/,
    );
  });

  it("keeps the fail-closed reply when engine failure reporting throws", async () => {
    const snapshot = activeDraft("complete", completeFields, 10);
    const repository = new ControlledRepository(snapshot);
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => {
          throw new Error("bounded engine failure");
        }),
      },
      modelId: "gpt-test-model",
      onEngineFailure: () => {
        throw new Error("logging sink unavailable");
      },
      promptVersion: "shiori-test-v1",
      repository,
    });

    await expect(service.handle(7017, "owner input")).resolves.toBe(
      conversationCopy.failureWithDraft,
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

  it("clears expired permission context after interrupted resolution", async () => {
    const snapshot = activeDraft("complete", completeFields);
    const test = controlled(
      snapshot,
      success(ordinary("Answer")),
    );
    test.repository.applyResult = {
      completed: true,
      draftCreated: false,
      draftReference: {
        id: snapshot.id,
        version: snapshot.version,
      },
      status: "interrupted",
    };

    await expect(
      test.service.handle(70161, "owner input"),
    ).resolves.toBe(conversationCopy.interrupted);
    expect(test.completeTurn).toHaveBeenCalledWith({
      activeDraftId: snapshot.id,
      assistantText: conversationCopy.interrupted,
      pendingQuestion: "clear",
      status: "active",
      updateId: 70161,
    });
  });

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

describe("ConversationService failure attribution", () => {
  it("reports a distinct site for each application-side rejection", async () => {
    // Every case below returns the same fail-closed copy. Before these events
    // existed there was no way to tell them apart in production.
    const cases = [
      {
        expectedSite: "no_state_relation_invalid",
        outcome: success(ordinary("", "new_request")),
        snapshot: { completed: true, kind: "none" } as const,
        updateId: 8001,
      },
      {
        expectedSite: "permission_candidate_mismatch",
        outcome: success(
          decision(incompleteFields, {
            turnRelation: "permission_accepted",
          }),
        ),
        snapshot: permissionCandidate(),
        updateId: 8002,
      },
      {
        expectedSite: "permission_decline_class_invalid",
        outcome: success(
          decision(completeFields, {
            turnRelation: "permission_declined",
          }),
        ),
        snapshot: permissionCandidate(),
        updateId: 8003,
      },
      {
        expectedSite: "draft_ordinary_response_missing",
        outcome: success(ordinary("", "none")),
        snapshot: activeDraft("awaiting_target", targetMissingFields),
        updateId: 8004,
      },
      {
        expectedSite: "clarification_against_complete_draft",
        outcome: success(
          decision(completeFields, {
            turnRelation: "clarification_continuation",
          }),
        ),
        snapshot: activeDraft("complete", completeFields),
        updateId: 8005,
      },
    ] as const;

    const observed: string[] = [];
    for (const scenario of cases) {
      const test = controlled(scenario.snapshot, scenario.outcome);
      const reply = await test.service.handle(
        scenario.updateId,
        "owner input",
      );

      expect(reply).toBe(
        scenario.snapshot.kind === "draft"
          ? conversationCopy.failureWithDraft
          : conversationCopy.failureNoDraft,
      );
      expect(reportedFailureSites(test.conversationFailureEvents)).toEqual([
        scenario.expectedSite,
      ]);
      observed.push(scenario.expectedSite);
    }

    expect(new Set(observed).size).toBe(cases.length);
  });

  it("carries the snapshot kind and draft phase for triage", async () => {
    const test = controlled(
      activeDraft("awaiting_target", targetMissingFields),
      success(ordinary("", "none")),
    );

    await test.service.handle(8006, "owner input");

    expect(test.conversationFailureEvents).toHaveBeenCalledWith({
      event: "conversation_failure",
      phase: "awaiting_target",
      site: "draft_ordinary_response_missing",
      snapshotKind: "draft",
    });
  });

  it("reports a stale compare-and-swap loss separately", async () => {
    const test = controlled(
      activeDraft("complete", completeFields),
      success(ordinary("A bounded synthetic answer.")),
    );
    test.repository.applyResult.status = "stale";

    await expect(test.service.handle(8007, "owner input")).resolves.toBe(
      conversationCopy.failureWithDraft,
    );
    expect(reportedFailureSites(test.conversationFailureEvents)).toEqual([
      "apply_stale",
    ]);
  });

  it("keeps the fail-closed reply when the failure sink throws", async () => {
    const repository = new ControlledRepository({
      completed: true,
      kind: "none",
    });
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => success(ordinary("", "new_request"))),
      },
      modelId: "gpt-test-model",
      onConversationFailure: () => {
        throw new Error("logging sink unavailable");
      },
      promptVersion: "shiori-test-v1",
      repository,
    });

    await expect(service.handle(8008, "owner input")).resolves.toBe(
      conversationCopy.failureNoDraft,
    );
  });

  it("settles the durable failure record before the reply returns", async () => {
    const records: unknown[] = [];
    let releaseWrite = () => {};
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const repository = new ControlledRepository({
      completed: true,
      kind: "none",
    });
    const recordTurnFailure = vi.fn(async (record: unknown) => {
      records.push(record);
      await pendingWrite;
    });
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => success(ordinary("", "new_request"))),
      },
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository: Object.assign(repository, { recordTurnFailure }),
    });

    let settled = false;
    const handled = service
      .handle(8010, "owner input")
      .then((reply) => {
        settled = true;
        return reply;
      });
    // Drain every pending microtask and I/O callback. Without the flush in
    // handle() the reply would already be settled here, with the diagnostic
    // write still in flight and free to be lost on shutdown.
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(records).toHaveLength(1);
    expect(settled).toBe(false);

    releaseWrite();
    await expect(handled).resolves.toBe(conversationCopy.failureNoDraft);
    expect(records).toEqual([
      {
        site: "no_state_relation_invalid",
        snapshotKind: "none",
        source: "application",
        updateId: 8010,
      },
    ]);
  });

  it("records the decision reason for a bounded engine failure", async () => {
    const records: Array<Record<string, unknown>> = [];
    const repository = new ControlledRepository(
      activeDraft("awaiting_target", targetMissingFields),
    );
    const service = new ConversationService({
      decisionEngine: {
        decide: vi.fn(async () => ({
          attemptCount: 2 as const,
          failure: "semantic" as const,
          ok: false as const,
          reason: "clarification_context_mutation" as const,
          stage: "semantic" as const,
        })),
      },
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository: Object.assign(repository, {
        recordTurnFailure: vi.fn(async (record: Record<string, unknown>) => {
          records.push(record);
        }),
      }),
    });

    await service.handle(8011, "owner input");

    expect(records).toEqual([
      {
        attemptCount: 2,
        phase: "awaiting_target",
        reason: "clarification_context_mutation",
        site: "decision_failure",
        snapshotKind: "draft",
        source: "decision",
        updateId: 8011,
      },
    ]);
  });

  it("never puts owner text in a failure event", async () => {
    const sensitiveText = "private-owner-text-should-never-leak";
    const test = controlled(
      { completed: true, kind: "none" },
      success(ordinary(sensitiveText, "new_request")),
    );

    await test.service.handle(8009, sensitiveText);

    expect(
      JSON.stringify(test.conversationFailureEvents.mock.calls),
    ).not.toContain(sensitiveText);
  });
});
