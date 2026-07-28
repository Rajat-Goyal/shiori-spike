import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DecisionAttemptCount,
  type DecisionFailureClass,
  type DecisionFailureStage,
  OpenAIDecisionEngine,
} from "./engine.js";
import {
  type DecisionCandidateFields,
  type DecisionInput,
  decisionJsonSchema,
  decisionInputSpec,
  decisionSpec,
  type DecisionResult,
  parseDecisionInputStructure,
  parseDecisionStructure,
} from "./schema.js";
import {
  validateDecisionInputSemantics,
  validateDecisionSemantics,
} from "./semantic.js";
import { isExpectedSmokeDecision } from "./smoke-shape.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const apiKey = "unit-test-api-key-that-must-not-leak";
const privateInput = "synthetic private input that must not leak";
const privateDecisionInput: DecisionInput = {
  context: {
    fields: null,
    phase: "none",
  },
  ownerText: privateInput,
};
const explicitDecision: DecisionResult = {
  definitionOfDone: "Submit the expense report",
  durationMinutes: null,
  inputClass: "explicit_commitment",
  missingFields: [],
  nextAction: "ready",
  offerWorkWindowHelp: false,
  commitmentMode: "simple_action",
  response: "I have the details.",
  targetAt: "2026-07-25T10:00:00+08:00",
  targetTimeZone: "Asia/Singapore",
  timingConstraints: [],
  turnRelation: "new_request",
};
const completeFields: DecisionCandidateFields = {
  commitmentMode: explicitDecision.commitmentMode,
  definitionOfDone: explicitDecision.definitionOfDone,
  durationMinutes: explicitDecision.durationMinutes,
  offerWorkWindowHelp: explicitDecision.offerWorkWindowHelp,
  targetAt: explicitDecision.targetAt,
  targetTimeZone: explicitDecision.targetTimeZone,
  timingConstraints: explicitDecision.timingConstraints,
};
const permissionInput: DecisionInput = {
  context: {
    fields: completeFields,
    phase: "awaiting_permission",
  },
  ownerText: "yes",
};
const impliedDecision: DecisionResult = {
  ...explicitDecision,
  commitmentMode: "unresolved",
  definitionOfDone: "Renew the library book",
  inputClass: "implied_intention",
  missingFields: [],
  nextAction: "ask_permission",
  response: "Would you like help managing that?",
  targetAt: null,
  targetTimeZone: null,
  turnRelation: "new_request",
};
const ordinaryDecision: DecisionResult = {
  ...explicitDecision,
  definitionOfDone: null,
  inputClass: "ordinary_question",
  missingFields: [],
  nextAction: "answer",
  commitmentMode: "unresolved",
  response: "Singapore is eight hours ahead of UTC.",
  targetAt: null,
  targetTimeZone: null,
  turnRelation: "none",
};

function contextInput(
  phase: DecisionInput["context"]["phase"],
  fields: DecisionCandidateFields | null,
): DecisionInput {
  return {
    context: { fields, phase },
    ownerText: privateInput,
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

function engineWith(fetchFromOpenAI: typeof fetch) {
  return new OpenAIDecisionEngine({
    apiKey,
    fetch: fetchFromOpenAI,
    model: "gpt-test-model",
    now: () => now,
    promptVersion: "shiori-test-v1",
  });
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
) {
  return {
    attemptCount,
    failure,
    ok: false,
    stage: failureStage[failure],
  } as const;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DecisionEngine contract", () => {
  it.each([
    {
      decision: explicitDecision,
      inputClass: "explicit_commitment",
    },
    {
      decision: {
        ...explicitDecision,
        commitmentMode: "unresolved",
        definitionOfDone: "Renew the library book",
        inputClass: "implied_intention",
        missingFields: [],
        nextAction: "ask_permission",
        response: "Would you like help managing that?",
        targetAt: null,
        targetTimeZone: null,
        turnRelation: "new_request",
      } satisfies DecisionResult,
      inputClass: "implied_intention",
    },
    {
      decision: {
        ...explicitDecision,
        definitionOfDone: null,
        inputClass: "ordinary_question",
        missingFields: [],
        nextAction: "answer",
        commitmentMode: "unresolved",
        response: "Singapore is eight hours ahead of UTC.",
        targetAt: null,
        targetTimeZone: null,
        turnRelation: "none",
      } satisfies DecisionResult,
      inputClass: "ordinary_question",
    },
  ])(
    "accepts a semantically bounded $inputClass decision",
    async ({ decision, inputClass }) => {
      const fetchFromOpenAI = vi.fn(async () => providerResponse(decision));

      await expect(
        engineWith(fetchFromOpenAI).decide({
          ...privateDecisionInput,
          ownerText: "synthetic",
        }),
      ).resolves.toEqual({ decision, ok: true });
      expect(decision.inputClass).toBe(inputClass);
    },
  );

  it("generates schema and runtime validation from the same field spec", () => {
    expect(decisionJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        response: {
          maxLength: 1_000,
          minLength: 1,
          type: "string",
        },
      },
      required: Object.keys(decisionSpec.fields),
      type: "object",
    });
    expect(
      (
        decisionJsonSchema.properties as Record<
          string,
          Record<string, unknown>
        >
      ).response,
    ).not.toHaveProperty("anyOf");
    expect(parseDecisionStructure(explicitDecision)).toEqual(explicitDecision);
    expect(parseDecisionInputStructure(privateDecisionInput)).toEqual(
      privateDecisionInput,
    );
    expect(decisionInputSpec).toMatchObject({
      fields: {
        context: {
          fields: {
            fields: {
              nullable: true,
            },
            phase: {
              enum: [
                "none",
                "awaiting_permission",
                "awaiting_definition",
                "awaiting_target",
                "complete",
              ],
            },
          },
        },
      },
    });
    expect(
      parseDecisionStructure({
        ...explicitDecision,
        unauthorizedAction: "save",
      }),
    ).toBeNull();
    expect(
      parseDecisionStructure({
        ...explicitDecision,
        durationMinutes: 45,
      }),
    ).toBeNull();
  });

  it("sends a stateless strict tool-free Responses request with a thirty-second timeout", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchFromOpenAI = vi.fn(async () => providerResponse(explicitDecision));
    const engine = engineWith(fetchFromOpenAI);

    await expect(engine.decide(privateDecisionInput)).resolves.toMatchObject({
      ok: true,
    });

    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetchFromOpenAI).toHaveBeenCalledOnce();
    const [url, request] = fetchFromOpenAI.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(request).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal,
    });

    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: JSON.stringify(privateDecisionInput),
      model: "gpt-test-model",
      store: false,
      text: {
        format: {
          name: "shiori_decision",
          schema: decisionJsonSchema,
          strict: true,
          type: "json_schema",
        },
      },
      tools: [],
    });
    expect(body.instructions).toContain("shiori-test-v1");
    expect(body.instructions).toContain(
      "JSON string encoding exactly {ownerText, context: {phase, fields}}",
    );
    expect(body.instructions).toContain(
      "Classify ownerText relative to context, not in isolation.",
    );
    expect(body.instructions).toContain("descriptive and never authorizes");
    expect(body.instructions).toContain(
      "For permission_accepted, use inputClass explicit_commitment",
    );
    expect(body.instructions).toContain(
      "definitionOfDone, targetAt, targetTimeZone, commitmentMode, durationMinutes, offerWorkWindowHelp, and timingConstraints",
    );
    expect(body.instructions).toContain(
      "derive missingFields from the unchanged candidate in definition_of_done then target order",
    );
    expect(body.instructions).toContain(
      "use nextAction ask_definition when definition is missing, otherwise ask_target when target is missing, otherwise ready for a complete simple action, otherwise offer_work_window for a complete valid work candidate",
    );
    expect(body.instructions).toContain(
      "Every successful decision must include a non-empty response.",
    );
    expect(JSON.parse(String(body.input))).toEqual(privateDecisionInput);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(String(request?.body)).not.toMatch(
      /previous_response_id|priorMessages|providerOutput|authority/,
    );
  });

  it.each([
    {
      decision: {
        definitionOfDone: null,
        durationMinutes: null,
        inputClass: "explicit_commitment",
        missingFields: ["definition_of_done", "target"],
        nextAction: "ask_definition",
        offerWorkWindowHelp: false,
        commitmentMode: "unresolved",
        response: "What would count as done?",
        targetAt: null,
        targetTimeZone: null,
        timingConstraints: [],
        turnRelation: "permission_accepted",
      } satisfies DecisionResult,
      input: {
        context: {
          fields: {
            definitionOfDone: null,
            durationMinutes: null,
            offerWorkWindowHelp: false,
            commitmentMode: "unresolved",
            targetAt: null,
            targetTimeZone: null,
            timingConstraints: [],
          },
          phase: "awaiting_permission",
        },
        ownerText: "yes",
      } satisfies DecisionInput,
      label: "an accepted candidate missing definition and target",
      smoke: false,
    },
    {
      decision: {
        definitionOfDone: "Submit the synthetic test note",
        durationMinutes: null,
        inputClass: "explicit_commitment",
        missingFields: ["target"],
        nextAction: "ask_target",
        offerWorkWindowHelp: false,
        commitmentMode: "unresolved",
        response: "When should it be done?",
        targetAt: null,
        targetTimeZone: null,
        timingConstraints: [],
        turnRelation: "permission_accepted",
      } satisfies DecisionResult,
      input: {
        context: {
          fields: {
            definitionOfDone: "Submit the synthetic test note",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            commitmentMode: "unresolved",
            targetAt: null,
            targetTimeZone: null,
            timingConstraints: [],
          },
          phase: "awaiting_permission",
        },
        ownerText: "yes",
      } satisfies DecisionInput,
      label: "an accepted candidate missing its target",
      smoke: false,
    },
    {
      decision: {
        definitionOfDone: "Submit the synthetic test note",
        durationMinutes: null,
        inputClass: "explicit_commitment",
        missingFields: [],
        nextAction: "ready",
        offerWorkWindowHelp: false,
        commitmentMode: "simple_action",
        response: "I have the details.",
        targetAt: "2026-07-25T10:00:00+08:00",
        targetTimeZone: "Asia/Singapore",
        timingConstraints: [],
        turnRelation: "permission_accepted",
      } satisfies DecisionResult,
      input: {
        context: {
          fields: {
            definitionOfDone: "Submit the synthetic test note",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            commitmentMode: "simple_action",
            targetAt: "2026-07-25T10:00:00+08:00",
            targetTimeZone: "Asia/Singapore",
            timingConstraints: [],
          },
          phase: "awaiting_permission",
        },
        ownerText: "yes",
      } satisfies DecisionInput,
      label: "the exact complete simple-action smoke input",
      smoke: true,
    },
    {
      decision: {
        definitionOfDone: "Draft the synthetic test note",
        durationMinutes: null,
        inputClass: "explicit_commitment",
        missingFields: [],
        nextAction: "offer_work_window",
        offerWorkWindowHelp: false,
        commitmentMode: "possible_work_session",
        response: "Would you like help finding a work window?",
        targetAt: "2026-07-25T10:00:00+08:00",
        targetTimeZone: "Asia/Singapore",
        timingConstraints: ["Avoid the morning commute", "Before lunch"],
        turnRelation: "permission_accepted",
      } satisfies DecisionResult,
      input: {
        context: {
          fields: {
            definitionOfDone: "Draft the synthetic test note",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            commitmentMode: "possible_work_session",
            targetAt: "2026-07-25T10:00:00+08:00",
            targetTimeZone: "Asia/Singapore",
            timingConstraints: [
              "Avoid the morning commute",
              "Before lunch",
            ],
          },
          phase: "awaiting_permission",
        },
        ownerText: "yes",
      } satisfies DecisionInput,
      label: "a complete valid work candidate",
      smoke: false,
    },
  ])(
    "accepts controlled adapter output for $label",
    async ({ decision, input, smoke }) => {
      const fetchFromOpenAI = vi.fn(async () =>
        providerResponse(decision),
      );

      await expect(engineWith(fetchFromOpenAI).decide(input)).resolves.toEqual(
        {
          decision,
          ok: true,
        },
      );
      expect(fetchFromOpenAI).toHaveBeenCalledOnce();
      const [, request] = fetchFromOpenAI.mock.calls[0];
      const body = JSON.parse(String(request?.body)) as Record<
        string,
        unknown
      >;
      expect(JSON.parse(String(body.input))).toEqual(input);
      expect(decision.response?.trim().length).toBeGreaterThan(0);

      if (smoke) {
        expect(
          isExpectedSmokeDecision(decision, input.context.fields!),
        ).toBe(true);
      }
    },
  );

  it.each([
    {
      label: "a wrong time zone",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        targetTimeZone: "UTC",
      }),
    },
    {
      label: "a non-existent calendar date",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        targetAt: "2026-02-30T10:00:00+08:00",
      }),
    },
    {
      label: "a target without the exact Singapore offset",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        targetAt: "2026-07-25T10:00:00+07:00",
      }),
    },
    {
      label: "a past target",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        targetAt: "2026-07-24T10:00:00+08:00",
      }),
    },
    {
      label: "a work-session mode with a simple-action next action",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        commitmentMode: "possible_work_session",
      }),
    },
    {
      label: "a duration on a simple action",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        durationMinutes: 30,
      }),
    },
    {
      label: "a false missing-field claim",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        missingFields: ["target"] as DecisionResult["missingFields"],
      }),
    },
    {
      label: "an unauthorized class/action combination",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        nextAction: "ask_permission" as DecisionResult["nextAction"],
      }),
    },
  ])("semantically rejects $label", ({ mutate }) => {
    expect(
      validateDecisionSemantics(
        mutate(explicitDecision),
        privateDecisionInput,
        now,
      ),
    ).toBe(false);
  });

  it("requires definition before target in canonical missing-field order", () => {
    const missingBoth: DecisionResult = {
      ...explicitDecision,
      commitmentMode: "unresolved",
      definitionOfDone: null,
      missingFields: ["definition_of_done", "target"],
      nextAction: "ask_definition",
      targetAt: null,
      targetTimeZone: null,
    };
    const missingTarget: DecisionResult = {
      ...explicitDecision,
      commitmentMode: "unresolved",
      missingFields: ["target"],
      nextAction: "ask_target",
      targetAt: null,
      targetTimeZone: null,
    };

    expect(
      validateDecisionSemantics(missingBoth, privateDecisionInput, now),
    ).toBe(true);
    expect(
      validateDecisionSemantics(missingTarget, privateDecisionInput, now),
    ).toBe(true);
    expect(
      validateDecisionSemantics(
        {
          ...missingBoth,
          missingFields: ["target", "definition_of_done"],
        },
        privateDecisionInput,
        now,
      ),
    ).toBe(false);
  });

  describe("bounded context and turn-relation semantics", () => {
    const awaitingDefinitionFields: DecisionCandidateFields = {
      ...completeFields,
      commitmentMode: "unresolved",
      definitionOfDone: null,
    };
    const awaitingTargetFields: DecisionCandidateFields = {
      ...completeFields,
      commitmentMode: "unresolved",
      targetAt: null,
      targetTimeZone: null,
    };
    const changedTargetFields: DecisionCandidateFields = {
      ...awaitingDefinitionFields,
      targetAt: "2026-07-26T10:00:00+08:00",
    };
    const phaseInputs = {
      awaiting_definition: contextInput(
        "awaiting_definition",
        awaitingDefinitionFields,
      ),
      awaiting_permission: permissionInput,
      awaiting_target: contextInput(
        "awaiting_target",
        awaitingTargetFields,
      ),
      complete: contextInput("complete", completeFields),
      none: privateDecisionInput,
    } as const;

    it("uses exactly the PM-approved candidate fields and rejects extra context", () => {
      expect(
        Object.keys(
          decisionInputSpec.fields.context.fields.fields.fields,
        ),
      ).toEqual([
        "definitionOfDone",
        "durationMinutes",
        "offerWorkWindowHelp",
        "commitmentMode",
        "targetAt",
        "targetTimeZone",
        "timingConstraints",
      ]);
      expect(
        parseDecisionInputStructure({
          ...permissionInput,
          context: {
            ...permissionInput.context,
            fields: {
              ...completeFields,
              version: 4,
            },
          },
        }),
      ).toBeNull();
      expect(
        parseDecisionInputStructure({
          ...permissionInput,
          context: {
            ...permissionInput.context,
            priorOwnerText: "private prior turn",
          },
        }),
      ).toBeNull();
    });

    it.each([
      {
        input: contextInput("none", completeFields),
        label: "fields in phase none",
      },
      {
        input: contextInput("awaiting_permission", null),
        label: "missing permission fields",
      },
      {
        input: contextInput("awaiting_definition", completeFields),
        label: "populated awaited definition",
      },
      {
        input: contextInput("awaiting_target", {
          ...awaitingTargetFields,
          definitionOfDone: null,
        }),
        label: "missing definition while awaiting target",
      },
      {
        input: contextInput("complete", awaitingTargetFields),
        label: "incomplete complete phase",
      },
      {
        input: contextInput("complete", {
          ...completeFields,
          commitmentMode: "unresolved",
        }),
        label: "invalid complete mode",
      },
      {
        input: {
          ...privateDecisionInput,
          ownerText: "   ",
        },
        label: "blank owner text",
      },
    ])("rejects $label before provider use", async ({ input }) => {
      const fetchFromOpenAI = vi.fn(async () =>
        providerResponse(explicitDecision),
      );
      await expect(engineWith(fetchFromOpenAI).decide(input)).resolves.toEqual({
        ...failureOutcome("semantic", 0),
      });
      expect(fetchFromOpenAI).not.toHaveBeenCalled();
    });

    it("rejects structurally malformed input before provider use", async () => {
      const fetchFromOpenAI = vi.fn(async () =>
        providerResponse(explicitDecision),
      );
      const malformed = {
        ...privateDecisionInput,
        transcript: ["private prior message"],
      } as unknown as DecisionInput;

      await expect(
        engineWith(fetchFromOpenAI).decide(malformed),
      ).resolves.toEqual({
        ...failureOutcome("semantic", 0),
      });
      expect(fetchFromOpenAI).not.toHaveBeenCalled();
    });

    it("accepts the owner-text maximum and rejects overlength before fetch", async () => {
      const fetchAtMaximum = vi.fn(async () =>
        providerResponse(explicitDecision),
      );
      await expect(
        engineWith(fetchAtMaximum).decide({
          ...privateDecisionInput,
          ownerText: "x".repeat(4_096),
        }),
      ).resolves.toEqual({
        decision: explicitDecision,
        ok: true,
      });
      expect(fetchAtMaximum).toHaveBeenCalledOnce();

      const fetchOverMaximum = vi.fn(async () =>
        providerResponse(explicitDecision),
      );
      await expect(
        engineWith(fetchOverMaximum).decide({
          ...privateDecisionInput,
          ownerText: "x".repeat(4_097),
        }),
      ).resolves.toEqual({
        ...failureOutcome("semantic", 0),
      });
      expect(fetchOverMaximum).not.toHaveBeenCalled();
    });

    it("accepts bounded candidate maxima and rejects overlength before fetch", async () => {
      const boundedFields: DecisionCandidateFields = {
        ...completeFields,
        definitionOfDone: "d".repeat(500),
        timingConstraints: Array.from(
          { length: 4 },
          (_, index) => `${index}${"c".repeat(199)}`,
        ),
      };
      const boundedDecision: DecisionResult = {
        ...explicitDecision,
        definitionOfDone: boundedFields.definitionOfDone,
        timingConstraints: boundedFields.timingConstraints,
        turnRelation: "permission_accepted",
      };
      const boundedInput = contextInput(
        "awaiting_permission",
        boundedFields,
      );
      const fetchAtMaximum = vi.fn(async () =>
        providerResponse(boundedDecision),
      );
      await expect(
        engineWith(fetchAtMaximum).decide(boundedInput),
      ).resolves.toEqual({
        decision: boundedDecision,
        ok: true,
      });
      expect(fetchAtMaximum).toHaveBeenCalledOnce();

      for (const fields of [
        {
          ...boundedFields,
          definitionOfDone: "d".repeat(501),
        },
        {
          ...boundedFields,
          timingConstraints: ["c".repeat(201)],
        },
        {
          ...boundedFields,
          timingConstraints: Array.from(
            { length: 5 },
            () => "bounded",
          ),
        },
      ]) {
        const fetchOverMaximum = vi.fn(async () =>
          providerResponse(boundedDecision),
        );
        await expect(
          engineWith(fetchOverMaximum).decide(
            contextInput("awaiting_permission", fields),
          ),
        ).resolves.toEqual({
          ...failureOutcome("semantic", 0),
        });
        expect(fetchOverMaximum).not.toHaveBeenCalled();
      }
    });

    const allowedCases: Array<{
      decision: DecisionResult;
      input: DecisionInput;
      label: string;
    }> = [
      {
        decision: explicitDecision,
        input: privateDecisionInput,
        label: "new explicit request without context",
      },
      {
        decision: impliedDecision,
        input: privateDecisionInput,
        label: "new implied request without context",
      },
      {
        decision: ordinaryDecision,
        input: privateDecisionInput,
        label: "ordinary question without context",
      },
      {
        decision: {
          ...explicitDecision,
          turnRelation: "permission_accepted",
        },
        input: permissionInput,
        label: "permission accepted",
      },
      {
        decision: {
          ...ordinaryDecision,
          turnRelation: "permission_declined",
        },
        input: permissionInput,
        label: "permission declined",
      },
      {
        decision: {
          ...ordinaryDecision,
          turnRelation: "clarification_continuation",
        },
        input: permissionInput,
        label: "unclear on-topic permission response",
      },
      {
        decision: {
          ...explicitDecision,
          turnRelation: "separate_request",
        },
        input: permissionInput,
        label: "separate explicit request during permission",
      },
      {
        decision: {
          ...impliedDecision,
          turnRelation: "separate_request",
        },
        input: permissionInput,
        label: "separate implied request during permission",
      },
      {
        decision: ordinaryDecision,
        input: permissionInput,
        label: "unrelated ordinary question during permission",
      },
      {
        decision: {
          ...explicitDecision,
          turnRelation: "clarification_continuation",
        },
        input: phaseInputs.awaiting_definition,
        label: "definition clarification",
      },
      {
        decision: {
          ...explicitDecision,
          turnRelation: "clarification_continuation",
        },
        input: phaseInputs.awaiting_target,
        label: "target clarification",
      },
      {
        decision: {
          ...explicitDecision,
          turnRelation: "correction",
        },
        input: contextInput(
          "awaiting_definition",
          changedTargetFields,
        ),
        label: "correction while awaiting definition",
      },
      {
        decision: {
          ...explicitDecision,
          definitionOfDone: "Submit the corrected expense report",
          turnRelation: "correction",
        },
        input: phaseInputs.awaiting_target,
        label: "correction while awaiting target",
      },
      {
        decision: {
          ...explicitDecision,
          definitionOfDone: "Submit the corrected expense report",
          turnRelation: "correction",
        },
        input: phaseInputs.complete,
        label: "correction of a complete candidate",
      },
      ...(["awaiting_definition", "awaiting_target", "complete"] as const).flatMap(
        (phase) => [
          {
            decision: {
              ...explicitDecision,
              turnRelation: "separate_request" as const,
            },
            input: phaseInputs[phase],
            label: `separate explicit request during ${phase}`,
          },
          {
            decision: {
              ...impliedDecision,
              turnRelation: "separate_request" as const,
            },
            input: phaseInputs[phase],
            label: `separate implied request during ${phase}`,
          },
          {
            decision: ordinaryDecision,
            input: phaseInputs[phase],
            label: `unrelated ordinary question during ${phase}`,
          },
        ],
      ),
    ];

    it.each(allowedCases)("accepts $label", ({ decision, input }) => {
      expect(validateDecisionSemantics(decision, input, now)).toBe(true);
    });

    it("rejects every relation/class/phase tuple outside the allowlist", () => {
      const relations: DecisionResult["turnRelation"][] = [
        "none",
        "new_request",
        "clarification_continuation",
        "correction",
        "separate_request",
        "permission_accepted",
        "permission_declined",
      ];
      const classes: DecisionResult["inputClass"][] = [
        "explicit_commitment",
        "implied_intention",
        "ordinary_question",
      ];
      const allowed = new Set(
        allowedCases.map(
          ({ decision, input }) =>
            `${input.context.phase}:${decision.turnRelation}:${decision.inputClass}`,
        ),
      );
      const baseByClass = {
        explicit_commitment: explicitDecision,
        implied_intention: impliedDecision,
        ordinary_question: ordinaryDecision,
      } as const;

      for (const [phase, input] of Object.entries(phaseInputs)) {
        for (const relation of relations) {
          for (const inputClass of classes) {
            const key = `${phase}:${relation}:${inputClass}`;
            if (allowed.has(key)) {
              continue;
            }
            expect(
              validateDecisionSemantics(
                {
                  ...baseByClass[inputClass],
                  turnRelation: relation,
                },
                input,
                now,
              ),
              key,
            ).toBe(false);
          }
        }
      }
    });

    it("distinguishes clarification from correction using populated fields", () => {
      const fillOnly = {
        ...explicitDecision,
        turnRelation: "correction",
      } satisfies DecisionResult;
      const changesPopulated = {
        ...explicitDecision,
        targetAt: "2026-07-26T10:00:00+08:00",
        turnRelation: "clarification_continuation",
      } satisfies DecisionResult;

      expect(
        validateDecisionSemantics(
          fillOnly,
          phaseInputs.awaiting_definition,
          now,
        ),
      ).toBe(false);
      expect(
        validateDecisionSemantics(
          changesPopulated,
          phaseInputs.awaiting_definition,
          now,
        ),
      ).toBe(false);

    });

    it("rejects clarification mutation of every populated candidate field", () => {
      const workFields: DecisionCandidateFields = {
        ...completeFields,
        definitionOfDone: null,
        commitmentMode: "unresolved",
        timingConstraints: ["first", "second"],
      };
      const input = contextInput(
        "awaiting_definition",
        workFields,
      );
      const clarification: DecisionResult = {
        ...explicitDecision,
        commitmentMode: "possible_work_session",
        nextAction: "offer_work_window",
        timingConstraints: ["first", "second"],
        turnRelation: "clarification_continuation",
      };
      expect(
        validateDecisionSemantics(clarification, input, now),
      ).toBe(true);

      const mutations: Array<{
        decision: DecisionResult;
        label: string;
      }> = [
        {
          decision: {
            ...clarification,
            offerWorkWindowHelp: true,
          },
          label: "offerWorkWindowHelp",
        },
        {
          decision: {
            ...clarification,
            targetAt: "2026-07-26T10:00:00+08:00",
          },
          label: "targetAt",
        },
        {
          decision: {
            ...clarification,
            targetTimeZone: "UTC",
          },
          label: "targetTimeZone",
        },
        {
          decision: {
            ...clarification,
            timingConstraints: ["second", "first"],
          },
          label: "timingConstraints order",
        },
      ];
      for (const mutation of mutations) {
        expect(
          validateDecisionSemantics(mutation.decision, input, now),
          mutation.label,
        ).toBe(false);
      }

      expect(
        validateDecisionSemantics(
          {
            ...explicitDecision,
            definitionOfDone: "Changed populated definition",
            turnRelation: "clarification_continuation",
          },
          phaseInputs.awaiting_target,
          now,
        ),
      ).toBe(false);
    });

    it("requires exact option-A candidate equality for permission acceptance", () => {
      const accepted = {
        ...explicitDecision,
        turnRelation: "permission_accepted",
      } satisfies DecisionResult;
      expect(
        validateDecisionSemantics(accepted, permissionInput, now),
      ).toBe(true);

      const mismatches: DecisionResult[] = [
        {
          ...accepted,
          definitionOfDone: "Changed definition",
        },
        {
          ...accepted,
          targetAt: "2026-07-26T10:00:00+08:00",
        },
        {
          ...accepted,
          timingConstraints: ["after lunch"],
        },
        {
          ...accepted,
          definitionOfDone: null,
          missingFields: ["definition_of_done"],
          nextAction: "ask_definition",
        },
        {
          ...accepted,
          missingFields: ["target"],
          nextAction: "ask_target",
          targetAt: null,
          targetTimeZone: null,
        },
        {
          ...accepted,
          nextAction: "offer_work_window",
          commitmentMode: "possible_work_session",
        },
      ];
      for (const mismatch of mismatches) {
        expect(
          validateDecisionSemantics(mismatch, permissionInput, now),
        ).toBe(false);
      }

      const orderedFields: DecisionCandidateFields = {
        ...completeFields,
        timingConstraints: ["first", "second"],
      };
      expect(
        validateDecisionSemantics(
          {
            ...accepted,
            timingConstraints: ["second", "first"],
          },
          contextInput("awaiting_permission", orderedFields),
          now,
        ),
      ).toBe(false);

      const possibleWorkFields: DecisionCandidateFields = {
        ...completeFields,
        offerWorkWindowHelp: false,
        commitmentMode: "possible_work_session",
      };
      const acceptedPossibleWork: DecisionResult = {
        ...explicitDecision,
        nextAction: "offer_work_window",
        offerWorkWindowHelp: false,
        commitmentMode: "possible_work_session",
        turnRelation: "permission_accepted",
      };
      const possibleWorkInput = contextInput(
        "awaiting_permission",
        possibleWorkFields,
      );
      expect(
        validateDecisionSemantics(
          acceptedPossibleWork,
          possibleWorkInput,
          now,
        ),
      ).toBe(true);
      expect(
        validateDecisionSemantics(
          {
            ...acceptedPossibleWork,
            nextAction: "ask_duration",
            offerWorkWindowHelp: true,
          },
          possibleWorkInput,
          now,
        ),
      ).toBe(false);
      expect(
        validateDecisionSemantics(
          {
            ...acceptedPossibleWork,
            durationMinutes: 30,
            nextAction: "ready",
          },
          possibleWorkInput,
          now,
        ),
      ).toBe(false);
    });

    it("preserves nulls and derives canonical action on permission acceptance", () => {
      const incompleteFields: DecisionCandidateFields = {
        ...completeFields,
        commitmentMode: "unresolved",
        definitionOfDone: null,
        targetAt: null,
        targetTimeZone: null,
      };
      const acceptedIncomplete: DecisionResult = {
        ...explicitDecision,
        commitmentMode: "unresolved",
        definitionOfDone: null,
        missingFields: ["definition_of_done", "target"],
        nextAction: "ask_definition",
        targetAt: null,
        targetTimeZone: null,
        turnRelation: "permission_accepted",
      };
      const input = contextInput(
        "awaiting_permission",
        incompleteFields,
      );

      expect(
        validateDecisionSemantics(acceptedIncomplete, input, now),
      ).toBe(true);
      expect(
        validateDecisionSemantics(
          {
            ...acceptedIncomplete,
            definitionOfDone: explicitDecision.definitionOfDone,
            missingFields: ["target"],
            nextAction: "ask_target",
          },
          input,
          now,
        ),
      ).toBe(false);
    });

    it.each(
      (() => {
        const incompleteFields: DecisionCandidateFields = {
          ...completeFields,
          definitionOfDone: null,
          commitmentMode: "unresolved",
          targetAt: null,
          targetTimeZone: null,
        };
        const incompleteAccepted: DecisionResult = {
          ...explicitDecision,
          definitionOfDone: null,
          missingFields: ["definition_of_done", "target"],
          nextAction: "ask_definition",
          commitmentMode: "unresolved",
          targetAt: null,
          targetTimeZone: null,
          turnRelation: "permission_accepted",
        };
        const possibleWorkFields: DecisionCandidateFields = {
          ...completeFields,
          commitmentMode: "possible_work_session",
        };
        const possibleWorkAccepted: DecisionResult = {
          ...explicitDecision,
          nextAction: "offer_work_window",
          commitmentMode: "possible_work_session",
          turnRelation: "permission_accepted",
        };
        const orderedFields: DecisionCandidateFields = {
          ...completeFields,
          timingConstraints: ["first", "second"],
        };
        return [
          {
            decision: {
              ...incompleteAccepted,
              definitionOfDone: "Filled definition",
              missingFields: ["target"],
              nextAction: "ask_target",
            },
            input: contextInput(
              "awaiting_permission",
              incompleteFields,
            ),
            label: "definitionOfDone null fill",
          },
          {
            decision: {
              ...possibleWorkAccepted,
              durationMinutes: 30,
              nextAction: "ready",
            },
            input: contextInput(
              "awaiting_permission",
              possibleWorkFields,
            ),
            label: "durationMinutes null fill",
          },
          {
            decision: {
              ...possibleWorkAccepted,
              nextAction: "ask_duration",
              offerWorkWindowHelp: true,
            },
            input: contextInput(
              "awaiting_permission",
              possibleWorkFields,
            ),
            label: "offerWorkWindowHelp change",
          },
          {
            decision: {
              ...incompleteAccepted,
              commitmentMode: "possible_work_session",
            },
            input: contextInput(
              "awaiting_permission",
              incompleteFields,
            ),
            label: "commitmentMode work-session change",
          },
          {
            decision: {
              ...incompleteAccepted,
              commitmentMode: "simple_action",
            },
            input: contextInput(
              "awaiting_permission",
              incompleteFields,
            ),
            label: "commitmentMode simple-action change",
          },
          {
            decision: {
              ...explicitDecision,
              targetAt: "2026-07-26T10:00:00+08:00",
              turnRelation: "permission_accepted",
            },
            input: permissionInput,
            label: "targetAt change",
          },
          {
            decision: {
              ...incompleteAccepted,
              targetTimeZone: "Asia/Singapore",
            },
            input: contextInput(
              "awaiting_permission",
              incompleteFields,
            ),
            label: "targetTimeZone null fill",
          },
          {
            decision: {
              ...explicitDecision,
              timingConstraints: ["second", "first"],
              turnRelation: "permission_accepted",
            },
            input: contextInput(
              "awaiting_permission",
              orderedFields,
            ),
            label: "timingConstraints reorder",
          },
        ];
      })(),
    )("rejects isolated permission mismatch: $label", ({ decision, input }) => {
      expect(validateDecisionSemantics(decision, input, now)).toBe(false);
    });

    it("allows unresolved permission mode only while core fields are incomplete", () => {
      const unresolvedFields: DecisionCandidateFields = {
        ...completeFields,
        definitionOfDone: null,
        commitmentMode: "unresolved",
        targetAt: null,
        targetTimeZone: null,
      };
      const unresolvedImplied: DecisionResult = {
        ...impliedDecision,
        definitionOfDone: null,
        commitmentMode: "unresolved",
      };
      expect(
        validateDecisionSemantics(
          unresolvedImplied,
          privateDecisionInput,
          now,
        ),
      ).toBe(true);
      expect(
        validateDecisionSemantics(
          {
            ...impliedDecision,
            commitmentMode: "unresolved",
            targetAt: explicitDecision.targetAt,
            targetTimeZone: explicitDecision.targetTimeZone,
          },
          privateDecisionInput,
          now,
        ),
      ).toBe(false);

      const possibleWorkImplied: DecisionResult = {
        ...explicitDecision,
        inputClass: "implied_intention",
        commitmentMode: "possible_work_session",
        nextAction: "ask_permission",
      };
      expect(
        validateDecisionSemantics(
          possibleWorkImplied,
          privateDecisionInput,
          now,
        ),
      ).toBe(true);
      expect(
        validateDecisionInputSemantics(
          contextInput("awaiting_permission", {
            ...completeFields,
            offerWorkWindowHelp: false,
            commitmentMode: "possible_work_session",
          }),
          now,
        ),
      ).toBe(true);

      const input = contextInput(
        "awaiting_permission",
        unresolvedFields,
      );
      const accepted: DecisionResult = {
        ...explicitDecision,
        definitionOfDone: null,
        missingFields: ["definition_of_done", "target"],
        nextAction: "ask_definition",
        commitmentMode: "unresolved",
        targetAt: null,
        targetTimeZone: null,
        turnRelation: "permission_accepted",
      };
      expect(validateDecisionInputSemantics(input, now)).toBe(true);
      expect(validateDecisionSemantics(accepted, input, now)).toBe(true);
      expect(
        validateDecisionInputSemantics(
          contextInput("awaiting_permission", {
            ...completeFields,
            commitmentMode: "unresolved",
          }),
          now,
        ),
      ).toBe(false);
    });

    it("requires a clarification that completes core fields to resolve mode", () => {
      const unresolvedFields: DecisionCandidateFields = {
        ...completeFields,
        definitionOfDone: null,
        commitmentMode: "unresolved",
        targetAt: null,
        targetTimeZone: null,
      };
      const input = contextInput(
        "awaiting_definition",
        unresolvedFields,
      );
      const remainsIncomplete: DecisionResult = {
        ...explicitDecision,
        missingFields: ["target"],
        nextAction: "ask_target",
        commitmentMode: "unresolved",
        targetAt: null,
        targetTimeZone: null,
        turnRelation: "clarification_continuation",
      };
      expect(
        validateDecisionSemantics(remainsIncomplete, input, now),
      ).toBe(true);

      const completesWithoutMode: DecisionResult = {
        ...explicitDecision,
        nextAction: "offer_work_window",
        commitmentMode: "unresolved",
        turnRelation: "clarification_continuation",
      };
      expect(
        validateDecisionSemantics(completesWithoutMode, input, now),
      ).toBe(false);
      expect(
        validateDecisionSemantics(
          {
            ...explicitDecision,
            turnRelation: "clarification_continuation",
          },
          input,
          now,
        ),
      ).toBe(true);
    });

    it("rejects an invalid work action when clarification completes core fields", () => {
      const input = contextInput(
        "awaiting_target",
        awaitingTargetFields,
      );
      expect(
        validateDecisionSemantics(
          {
            ...explicitDecision,
            durationMinutes: 30,
            commitmentMode: "possible_work_session",
            nextAction: "offer_work_window",
            turnRelation: "clarification_continuation",
          },
          input,
          now,
        ),
      ).toBe(false);
    });

    it("accepts awaiting-definition context with no extracted target", () => {
      const fields: DecisionCandidateFields = {
        ...completeFields,
        commitmentMode: "unresolved",
        definitionOfDone: null,
        targetAt: null,
        targetTimeZone: null,
      };
      const input = contextInput("awaiting_definition", fields);
      const decision: DecisionResult = {
        ...explicitDecision,
        commitmentMode: "unresolved",
        missingFields: ["target"],
        nextAction: "ask_target",
        targetAt: null,
        targetTimeZone: null,
        turnRelation: "clarification_continuation",
      };
      expect(validateDecisionInputSemantics(input, now)).toBe(true);
      expect(validateDecisionSemantics(decision, input, now)).toBe(true);
    });

    it("accepts correction that clears a populated field to null", () => {
      expect(
        validateDecisionSemantics(
          {
            ...explicitDecision,
            commitmentMode: "unresolved",
            definitionOfDone: null,
            missingFields: ["definition_of_done"],
            nextAction: "ask_definition",
            turnRelation: "correction",
          },
          phaseInputs.complete,
          now,
        ),
      ).toBe(true);
    });

    it("keeps separate_request descriptive without value-comparison inference", async () => {
      expect(
        validateDecisionSemantics(
          {
            ...explicitDecision,
            turnRelation: "separate_request",
          },
          phaseInputs.complete,
          now,
        ),
      ).toBe(true);

      const separateDecision: DecisionResult = {
        ...explicitDecision,
        definitionOfDone: "Book the synthetic flight",
        targetAt: "2026-07-27T10:00:00+08:00",
        turnRelation: "separate_request",
      };
      const input: DecisionInput = {
        ...phaseInputs.complete,
        ownerText: "Start another synthetic request",
      };
      const fetchFromOpenAI = vi.fn(async () =>
        providerResponse(separateDecision),
      );
      await expect(
        engineWith(fetchFromOpenAI).decide(input),
      ).resolves.toEqual({
        decision: separateDecision,
        ok: true,
      });
      const request = fetchFromOpenAI.mock.calls[0][1];
      const body = JSON.parse(String(request?.body)) as {
        input: string;
      };
      expect(JSON.parse(body.input)).toEqual(input);
      expect(body.input).not.toContain(
        separateDecision.definitionOfDone!,
      );
    });

    it("validates every phase invariant for a structurally bounded input", () => {
      expect(
        validateDecisionInputSemantics(privateDecisionInput, now),
      ).toBe(true);
      expect(
        validateDecisionInputSemantics(permissionInput, now),
      ).toBe(true);
      expect(
        validateDecisionInputSemantics(
          phaseInputs.awaiting_definition,
          now,
        ),
      ).toBe(true);
      expect(
        validateDecisionInputSemantics(
          phaseInputs.awaiting_target,
          now,
        ),
      ).toBe(true);
      expect(
        validateDecisionInputSemantics(phaseInputs.complete, now),
      ).toBe(true);
    });
  });

  it.each([
    { expected: "incomplete", status: "queued" },
    { expected: "incomplete", status: "in_progress" },
    { expected: "incomplete", status: "incomplete" },
    { expected: "provider_error", status: "unknown" },
    { expected: "provider_error", status: undefined },
  ] as const)(
    "rejects top-level provider status $status",
    async ({ expected, status }) => {
      const envelope = (await providerResponse(explicitDecision).json()) as
        Record<string, unknown>;
      if (status === undefined) {
        delete envelope.status;
      } else {
        envelope.status = status;
      }
      const fetchFromOpenAI = vi.fn(async () => Response.json(envelope));

      await expect(
        engineWith(fetchFromOpenAI).decide(privateDecisionInput),
      ).resolves.toEqual(failureOutcome(expected));
    },
  );

  it.each([
    { expected: "incomplete", status: "queued" },
    { expected: "incomplete", status: "in_progress" },
    { expected: "incomplete", status: "incomplete" },
    { expected: "provider_error", status: "unknown" },
    { expected: "provider_error", status: undefined },
  ] as const)(
    "rejects output message status $status",
    async ({ expected, status }) => {
      const envelope = (await providerResponse(explicitDecision).json()) as {
        output: Array<Record<string, unknown>>;
      };
      if (status === undefined) {
        delete envelope.output[0].status;
      } else {
        envelope.output[0].status = status;
      }
      const fetchFromOpenAI = vi.fn(async () => Response.json(envelope));

      await expect(
        engineWith(fetchFromOpenAI).decide(privateDecisionInput),
      ).resolves.toEqual(failureOutcome(expected));
    },
  );
});

describe("OpenAI decision failure boundary", () => {
  it.each([
    {
      label: "null",
      value: { ...explicitDecision, response: null },
    },
    {
      label: "missing",
      value: Object.fromEntries(
        Object.entries(explicitDecision).filter(([key]) => key !== "response"),
      ),
    },
    {
      label: "empty",
      value: { ...explicitDecision, response: "" },
    },
  ])(
    "classifies a $label response field as schema failure without retry",
    async ({ value }) => {
      const fetchFromOpenAI = vi.fn(async () => providerResponse(value));

      await expect(
        engineWith(fetchFromOpenAI).decide(privateDecisionInput),
      ).resolves.toEqual(failureOutcome("schema"));
      expect(fetchFromOpenAI).toHaveBeenCalledOnce();
    },
  );

  it("retries one semantic failure with the same bounded request, deadline, input, and validation time", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const nowFromEngine = vi
      .fn<() => Date>()
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(new Date("2026-07-26T12:00:00.000Z"));
    const firstDecision = {
      ...explicitDecision,
      targetTimeZone: "UTC",
    };
    const fetchFromOpenAI = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(providerResponse(firstDecision))
      .mockResolvedValueOnce(providerResponse(explicitDecision));
    const input = structuredClone(privateDecisionInput);
    const engine = new OpenAIDecisionEngine({
      apiKey,
      fetch: fetchFromOpenAI,
      model: "gpt-test-model",
      now: nowFromEngine,
      promptVersion: "shiori-test-v1",
    });

    await expect(engine.decide(input)).resolves.toEqual({
      decision: explicitDecision,
      ok: true,
      recovery: {
        attemptCount: 2,
        failureClass: "semantic",
        stage: "output_semantic",
      },
    });

    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(nowFromEngine).toHaveBeenCalledOnce();
    expect(fetchFromOpenAI).toHaveBeenCalledTimes(2);
    const requests = fetchFromOpenAI.mock.calls.map(([, request]) => request);
    expect(requests[0]?.signal).toBe(signal);
    expect(requests[1]?.signal).toBe(signal);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(input).toEqual(privateDecisionInput);
  });

  it("returns the second semantic failure after exactly two attempts", async () => {
    const invalidDecision = {
      ...explicitDecision,
      targetTimeZone: "UTC",
    };
    const fetchFromOpenAI = vi.fn(async () =>
      providerResponse(invalidDecision),
    );

    await expect(
      engineWith(fetchFromOpenAI).decide(privateDecisionInput),
    ).resolves.toEqual(failureOutcome("semantic", 2));
    expect(fetchFromOpenAI).toHaveBeenCalledTimes(2);
  });

  it("returns a second-attempt timeout without a third request", async () => {
    const firstDecision = {
      ...explicitDecision,
      targetTimeZone: "UTC",
    };
    const fetchFromOpenAI = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(providerResponse(firstDecision))
      .mockRejectedValueOnce(
        new DOMException("private retry timeout", "TimeoutError"),
      );

    await expect(
      engineWith(fetchFromOpenAI).decide(privateDecisionInput),
    ).resolves.toEqual(failureOutcome("timeout", 2));
    expect(fetchFromOpenAI).toHaveBeenCalledTimes(2);
  });

  it.each<{
    expected: DecisionFailureClass;
    fetch: () => Promise<Response>;
    label: string;
  }>([
    {
      expected: "http",
      fetch: async () => new Response("private provider body", { status: 429 }),
      label: "HTTP failure",
    },
    {
      expected: "provider_error",
      fetch: async () =>
        Response.json({
          error: {
            message: "private provider error",
          },
        }),
      label: "provider error",
    },
    {
      expected: "provider_error",
      fetch: async () =>
        new Response("not a provider JSON envelope", {
          headers: { "Content-Type": "application/json" },
        }),
      label: "invalid provider envelope",
    },
    {
      expected: "incomplete",
      fetch: async () =>
        Response.json({
          incomplete_details: { reason: "max_output_tokens" },
          status: "incomplete",
        }),
      label: "incomplete response",
    },
    {
      expected: "refusal",
      fetch: async () =>
        Response.json({
          output: [
            {
              content: [
                {
                  refusal: "private refusal",
                  type: "refusal",
                },
              ],
              status: "completed",
              type: "message",
            },
          ],
          status: "completed",
        }),
      label: "refusal",
    },
    {
      expected: "missing_output",
      fetch: async () =>
        Response.json({
          output: [
            {
              content: [],
              status: "completed",
              type: "message",
            },
          ],
          status: "completed",
        }),
      label: "missing output",
    },
    {
      expected: "provider_error",
      fetch: async () =>
        Response.json({
          output: [],
          status: "completed",
        }),
      label: "completed response without a message",
    },
    {
      expected: "non_json",
      fetch: async () =>
        Response.json({
          output: [
            {
              content: [],
              status: "completed",
              type: "message",
            },
          ],
          output_text: "private non-JSON output",
          status: "completed",
        }),
      label: "non-JSON output",
    },
    {
      expected: "schema",
      fetch: async () =>
        providerResponse({
          ...explicitDecision,
          unauthorizedAction: "save",
        }),
      label: "schema-invalid output",
    },
    {
      expected: "semantic",
      fetch: async () =>
        providerResponse({
          ...explicitDecision,
          targetTimeZone: "UTC",
        }),
      label: "semantically invalid output",
    },
  ])("returns only bounded metadata for $label", async ({ expected, fetch }) => {
    const fetchFromOpenAI = vi.fn(fetch as typeof fetch);
    const outcome = await engineWith(fetchFromOpenAI).decide(
      privateDecisionInput,
    );

    const attemptCount = expected === "semantic" ? 2 : 1;
    expect(outcome).toEqual(failureOutcome(expected, attemptCount));
    expect(fetchFromOpenAI).toHaveBeenCalledTimes(attemptCount);
    expect(JSON.stringify(outcome)).not.toContain(privateInput);
    expect(JSON.stringify(outcome)).not.toContain(apiKey);
    expect(JSON.stringify(outcome)).not.toContain("private");
  });

  it.each([
    new DOMException("private timeout", "TimeoutError"),
    new DOMException("private abort", "AbortError"),
  ])("maps %s to timeout without leaking details", async (error) => {
    const fetchFromOpenAI = vi.fn(async () => {
      throw error;
    });

    await expect(
      engineWith(fetchFromOpenAI).decide(privateDecisionInput),
    ).resolves.toEqual(failureOutcome("timeout"));
    expect(fetchFromOpenAI).toHaveBeenCalledOnce();
  });

  it.each([
    new DOMException("private body timeout", "TimeoutError"),
    new DOMException("private body abort", "AbortError"),
  ])("maps response JSON %s to timeout without leaking details", async (error) => {
    const fetchFromOpenAI = vi.fn(async () => {
      return {
        json: async () => {
          throw error;
        },
        ok: true,
      } as Response;
    });

    await expect(
      engineWith(fetchFromOpenAI).decide(privateDecisionInput),
    ).resolves.toEqual(failureOutcome("timeout"));
    expect(fetchFromOpenAI).toHaveBeenCalledOnce();
  });

  it("maps other transport exceptions to an opaque HTTP failure", async () => {
    const fetchFromOpenAI = vi.fn(async () => {
      throw new Error("private network detail");
    });

    await expect(
      engineWith(fetchFromOpenAI).decide(privateDecisionInput),
    ).resolves.toEqual(failureOutcome("http"));
    expect(fetchFromOpenAI).toHaveBeenCalledOnce();
  });
});

describe("OpenAI smoke decision shape", () => {
  const accepted: DecisionResult = {
    ...explicitDecision,
    turnRelation: "permission_accepted",
  };

  it("accepts only an exact permission acceptance for the fixed synthetic context", () => {
    expect(isExpectedSmokeDecision(accepted, completeFields)).toBe(true);
  });

  it.each([
    {
      label: "a non-acceptance relation",
      decision: {
        ...accepted,
        turnRelation: "correction",
      } satisfies DecisionResult,
    },
    {
      label: "a changed candidate field",
      decision: {
        ...accepted,
        definitionOfDone: "Changed synthetic definition",
      } satisfies DecisionResult,
    },
    {
      label: "reordered timing constraints",
      decision: {
        ...accepted,
        timingConstraints: ["second", "first"],
      } satisfies DecisionResult,
      expected: {
        ...completeFields,
        timingConstraints: ["first", "second"],
      } satisfies DecisionCandidateFields,
    },
    {
      label: "a non-explicit class",
      decision: {
        ...accepted,
        inputClass: "implied_intention",
      } satisfies DecisionResult,
    },
    {
      label: "a non-ready action",
      decision: {
        ...accepted,
        nextAction: "ask_target",
      } satisfies DecisionResult,
    },
  ])("rejects $label", ({ decision, expected }) => {
    expect(
      isExpectedSmokeDecision(decision, expected ?? completeFields),
    ).toBe(false);
  });
});
