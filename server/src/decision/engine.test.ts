import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DecisionFailureClass,
  OpenAIDecisionEngine,
} from "./engine.js";
import {
  decisionJsonSchema,
  decisionSpec,
  type DecisionResult,
  parseDecisionStructure,
} from "./schema.js";
import { validateDecisionSemantics } from "./semantic.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const apiKey = "unit-test-api-key-that-must-not-leak";
const privateInput = "synthetic private input that must not leak";
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
};

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
      } satisfies DecisionResult,
      inputClass: "ordinary_question",
    },
  ])(
    "accepts a semantically bounded $inputClass decision",
    async ({ decision, inputClass }) => {
      const fetchFromOpenAI = vi.fn(async () => providerResponse(decision));

      await expect(engineWith(fetchFromOpenAI).decide("synthetic")).resolves.toEqual({
        decision,
        ok: true,
      });
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

    await expect(engine.decide(privateInput)).resolves.toMatchObject({
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
      input: privateInput,
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
    expect(body).not.toHaveProperty("previous_response_id");
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
    expect(validateDecisionSemantics(mutate(explicitDecision), now)).toBe(false);
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

    expect(validateDecisionSemantics(missingBoth, now)).toBe(true);
    expect(validateDecisionSemantics(missingTarget, now)).toBe(true);
    expect(
      validateDecisionSemantics(
        {
          ...missingBoth,
          missingFields: ["target", "definition_of_done"],
        },
        now,
      ),
    ).toBe(false);
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

      await expect(engineWith(fetchFromOpenAI).decide(privateInput)).resolves.toEqual({
        failure: expected,
        ok: false,
      });
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

      await expect(engineWith(fetchFromOpenAI).decide(privateInput)).resolves.toEqual({
        failure: expected,
        ok: false,
      });
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
    const outcome = await engineWith(fetch as typeof fetch).decide(privateInput);

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

    await expect(engineWith(fetchFromOpenAI).decide(privateInput)).resolves.toEqual({
      failure: "timeout",
      ok: false,
    });
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

    await expect(engineWith(fetchFromOpenAI).decide(privateInput)).resolves.toEqual({
      failure: "timeout",
      ok: false,
    });
  });

  it("maps other transport exceptions to an opaque HTTP failure", async () => {
    const fetchFromOpenAI = vi.fn(async () => {
      throw new Error("private network detail");
    });

    await expect(engineWith(fetchFromOpenAI).decide(privateInput)).resolves.toEqual({
      failure: "http",
      ok: false,
    });
  });
});
