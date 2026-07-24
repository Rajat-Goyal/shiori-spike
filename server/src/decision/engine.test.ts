import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DecisionFailureClass,
  OpenAIDecisionEngine,
} from "./engine.js";
import {
  type DecisionContextFields,
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
  possibleWorkSession: false,
  response: "I have the details.",
  simpleAction: true,
  targetAt: "2026-07-25T10:00:00+08:00",
  targetTimeZone: "Asia/Singapore",
  timingConstraints: [],
  turnRelation: "new_request",
};
const completeFields: DecisionContextFields = {
  definitionOfDone: explicitDecision.definitionOfDone,
  durationMinutes: explicitDecision.durationMinutes,
  offerWorkWindowHelp: explicitDecision.offerWorkWindowHelp,
  possibleWorkSession: explicitDecision.possibleWorkSession,
  simpleAction: explicitDecision.simpleAction,
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
  possibleWorkSession: false,
  response: "Singapore is eight hours ahead of UTC.",
  simpleAction: false,
  targetAt: null,
  targetTimeZone: null,
  turnRelation: "none",
};

function contextInput(
  phase: DecisionInput["context"]["phase"],
  fields: DecisionContextFields | null,
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
        possibleWorkSession: false,
        response: "Singapore is eight hours ahead of UTC.",
        simpleAction: false,
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
      required: Object.keys(decisionSpec.fields),
      type: "object",
    });
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

  it("sends a stateless strict tool-free Responses request with a five-second timeout", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchFromOpenAI = vi.fn(async () => providerResponse(explicitDecision));
    const engine = engineWith(fetchFromOpenAI);

    await expect(engine.decide(privateDecisionInput)).resolves.toMatchObject({
      ok: true,
    });

    expect(timeout).toHaveBeenCalledWith(5_000);
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
    expect(body.instructions).toContain("descriptive and never authorizes");
    expect(body.instructions).toContain(
      "copy every context candidate field exactly",
    );
    expect(body).not.toHaveProperty("previous_response_id");
    expect(String(request?.body)).not.toMatch(
      /previous_response_id|transcript|priorMessages|providerOutput|authority/,
    );
  });

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
      label: "simultaneous simple-action and work-session modes",
      mutate: (decision: DecisionResult) => ({
        ...decision,
        possibleWorkSession: true,
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
      definitionOfDone: null,
      missingFields: ["definition_of_done", "target"],
      nextAction: "ask_definition",
      targetAt: null,
      targetTimeZone: null,
    };
    const missingTarget: DecisionResult = {
      ...explicitDecision,
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
    const awaitingDefinitionFields: DecisionContextFields = {
      ...completeFields,
      definitionOfDone: null,
    };
    const awaitingTargetFields: DecisionContextFields = {
      ...completeFields,
      targetAt: null,
      targetTimeZone: null,
    };
    const changedTargetFields: DecisionContextFields = {
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
        "possibleWorkSession",
        "simpleAction",
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
          possibleWorkSession: false,
          simpleAction: false,
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
        failure: "semantic",
        ok: false,
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
        failure: "semantic",
        ok: false,
      });
      expect(fetchFromOpenAI).not.toHaveBeenCalled();
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
          possibleWorkSession: true,
          simpleAction: false,
        },
      ];
      for (const mismatch of mismatches) {
        expect(
          validateDecisionSemantics(mismatch, permissionInput, now),
        ).toBe(false);
      }

      const orderedFields: DecisionContextFields = {
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

      const possibleWorkFields: DecisionContextFields = {
        ...completeFields,
        offerWorkWindowHelp: true,
        possibleWorkSession: true,
        simpleAction: false,
      };
      const acceptedPossibleWork: DecisionResult = {
        ...explicitDecision,
        nextAction: "ask_duration",
        offerWorkWindowHelp: true,
        possibleWorkSession: true,
        simpleAction: false,
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
            nextAction: "offer_work_window",
            offerWorkWindowHelp: false,
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
      const incompleteFields: DecisionContextFields = {
        ...completeFields,
        definitionOfDone: null,
        targetAt: null,
        targetTimeZone: null,
      };
      const acceptedIncomplete: DecisionResult = {
        ...explicitDecision,
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
      ).resolves.toEqual({ failure: expected, ok: false });
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
      ).resolves.toEqual({ failure: expected, ok: false });
    },
  );
});

describe("OpenAI decision failure boundary", () => {
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
  ])("returns only a bounded class for $label", async ({ expected, fetch }) => {
    const outcome = await engineWith(fetch as typeof fetch).decide(
      privateDecisionInput,
    );

    expect(outcome).toEqual({ failure: expected, ok: false });
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
    ).resolves.toEqual({ failure: "timeout", ok: false });
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
    ).resolves.toEqual({ failure: "timeout", ok: false });
  });

  it("maps other transport exceptions to an opaque HTTP failure", async () => {
    const fetchFromOpenAI = vi.fn(async () => {
      throw new Error("private network detail");
    });

    await expect(
      engineWith(fetchFromOpenAI).decide(privateDecisionInput),
    ).resolves.toEqual({ failure: "http", ok: false });
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
      } satisfies DecisionContextFields,
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
