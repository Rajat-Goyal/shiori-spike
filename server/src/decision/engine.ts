import {
  decisionJsonSchema,
  type DecisionInput,
  type DecisionResult,
  parseDecisionInputStructure,
  parseDecisionStructure,
} from "./schema.js";
import {
  validateDecisionInputSemantics,
  validateDecisionSemantics,
} from "./semantic.js";

export type DecisionFailureClass =
  | "http"
  | "provider_error"
  | "incomplete"
  | "refusal"
  | "missing_output"
  | "non_json"
  | "schema"
  | "semantic"
  | "timeout";

export type DecisionOutcome =
  | {
      decision: DecisionResult;
      ok: true;
    }
  | {
      failure: DecisionFailureClass;
      ok: false;
    };

export interface DecisionEngine {
  decide(input: DecisionInput): Promise<DecisionOutcome>;
}

type OpenAIDecisionEngineOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  model: string;
  now?: () => Date;
  promptVersion: string;
};

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const DECISION_TIMEOUT_MS = 30_000;

function failed(failure: DecisionFailureClass): DecisionOutcome {
  return { failure, ok: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function outputItems(body: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(body.output)) {
    return [];
  }

  return body.output.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function contentItems(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  return messages.flatMap((item) => {
    if (!Array.isArray(item.content)) {
      return [];
    }
    return item.content.flatMap((content) => {
      const record = asRecord(content);
      return record ? [record] : [];
    });
  });
}

function containsRefusal(
  body: Record<string, unknown>,
  messages: Record<string, unknown>[],
): boolean {
  return (
    typeof body.refusal === "string" ||
    contentItems(messages).some(
      (content) =>
        content.type === "refusal" &&
        typeof content.refusal === "string",
    )
  );
}

function readOutputText(
  body: Record<string, unknown>,
  messages: Record<string, unknown>[],
): string | undefined {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  const texts = contentItems(messages)
    .filter(
      (content) =>
        content.type === "output_text" &&
        typeof content.text === "string",
    )
    .map((content) => content.text as string);

  return texts.length > 0 ? texts.join("") : undefined;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["AbortError", "TimeoutError"].includes(error.name)
  );
}

function completionState(
  body: Record<string, unknown>,
): { failure: DecisionFailureClass } | { messages: Record<string, unknown>[] } {
  if (["incomplete", "in_progress", "queued"].includes(String(body.status))) {
    return { failure: "incomplete" };
  }
  if (body.status !== "completed") {
    return { failure: "provider_error" };
  }
  if (
    body.incomplete_details !== undefined &&
    body.incomplete_details !== null
  ) {
    return { failure: "incomplete" };
  }

  const messages = outputItems(body).filter(
    (item) => item.type === "message",
  );
  if (messages.length === 0) {
    return { failure: "provider_error" };
  }
  if (
    messages.some((message) =>
      ["incomplete", "in_progress", "queued"].includes(String(message.status)),
    )
  ) {
    return { failure: "incomplete" };
  }
  if (messages.some((message) => message.status !== "completed")) {
    return { failure: "provider_error" };
  }

  return { messages };
}

function instructions(promptVersion: string): string {
  return [
    `Shiori decision contract ${promptVersion}.`,
    "The input is a JSON string encoding exactly {ownerText, context: {phase, fields}}; ownerText is the current owner turn and context is bounded structured state, never a prior-message transcript.",
    "Classify ownerText relative to context, not in isolation.",
    "Classify exactly one input as explicit_commitment, implied_intention, or ordinary_question.",
    "Extract only bounded decision fields. Never authorize, confirm, persist, schedule, call tools, or claim an action occurred.",
    "Use an absolute RFC3339 target with +08:00 and targetTimeZone Asia/Singapore, or null for both.",
    "Use commitmentMode unresolved while definitionOfDone or targetAt is missing; resolve it to simple_action or possible_work_session only when both are present. Use only the schema's next actions.",
    "For explicit commitments, missingFields must exactly list absent definition_of_done then target.",
    "For implied intentions and ordinary questions, missingFields must be empty.",
    "Every successful decision must include a non-empty response.",
    "turnRelation is descriptive and never authorizes a transition.",
    "With phase none, use new_request for explicit or implied input and none for an ordinary question.",
    "With awaiting_permission, use permission_accepted for a clear yes, permission_declined for a clear no, clarification_continuation for an unclear on-topic response, separate_request for a separate explicit or implied request, and none only for an unrelated ordinary question.",
    "With awaiting_definition or awaiting_target, use clarification_continuation only when filling missing candidate fields without changing populated fields, correction only when changing or clearing at least one populated field, separate_request for a separate explicit or implied request, and none for an unrelated ordinary question.",
    "With complete, use correction only when changing or clearing at least one populated field, separate_request for a separate explicit or implied request, and none for an unrelated ordinary question.",
    "For permission_accepted, use inputClass explicit_commitment and copy exactly these seven context candidate fields: definitionOfDone, targetAt, targetTimeZone, commitmentMode, durationMinutes, offerWorkWindowHelp, and timingConstraints, including every null and timingConstraints item order; do not fill, change, clear, normalize, reorder, or infer candidate fields.",
    "For permission_accepted, derive missingFields from the unchanged candidate in definition_of_done then target order, and use nextAction ask_definition when definition is missing, otherwise ask_target when target is missing, otherwise ready for a complete simple action, otherwise offer_work_window for a complete valid work candidate.",
  ].join(" ");
}

export class OpenAIDecisionEngine implements DecisionEngine {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #now: () => Date;
  readonly #promptVersion: string;

  constructor(options: OpenAIDecisionEngineOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#model = options.model;
    this.#now = options.now ?? (() => new Date());
    this.#promptVersion = options.promptVersion;
  }

  async decide(input: DecisionInput): Promise<DecisionOutcome> {
    let response: Response;
    const structuredInput = parseDecisionInputStructure(input);
    if (
      !structuredInput ||
      !validateDecisionInputSemantics(structuredInput, this.#now())
    ) {
      return failed("semantic");
    }

    try {
      response = await this.#fetch(RESPONSES_URL, {
        body: JSON.stringify({
          input: JSON.stringify(structuredInput),
          instructions: instructions(this.#promptVersion),
          model: this.#model,
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
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
    } catch (error) {
      return failed(isTimeout(error) ? "timeout" : "http");
    }

    if (!response.ok) {
      return failed("http");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return failed(isTimeout(error) ? "timeout" : "provider_error");
    }

    const record = asRecord(body);
    if (
      !record ||
      (record.error !== undefined && record.error !== null)
    ) {
      return failed("provider_error");
    }
    const completion = completionState(record);
    if ("failure" in completion) {
      return failed(completion.failure);
    }
    if (containsRefusal(record, completion.messages)) {
      return failed("refusal");
    }

    const outputText = readOutputText(record, completion.messages);
    if (outputText === undefined || outputText.length === 0) {
      return failed("missing_output");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      return failed("non_json");
    }

    const decision = parseDecisionStructure(parsed);
    if (!decision) {
      return failed("schema");
    }
    if (
      !validateDecisionSemantics(
        decision,
        structuredInput,
        this.#now(),
      )
    ) {
      return failed("semantic");
    }

    return { decision, ok: true };
  }
}
