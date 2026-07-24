import {
  decisionJsonSchema,
  type DecisionResult,
  parseDecisionStructure,
} from "./schema.js";
import { validateDecisionSemantics } from "./semantic.js";

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
  decide(input: string): Promise<DecisionOutcome>;
}

type OpenAIDecisionEngineOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  model: string;
  now?: () => Date;
  promptVersion: string;
};

const RESPONSES_URL = "https://api.openai.com/v1/responses";

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

function contentItems(body: Record<string, unknown>): Record<string, unknown>[] {
  return outputItems(body).flatMap((item) => {
    if (!Array.isArray(item.content)) {
      return [];
    }
    return item.content.flatMap((content) => {
      const record = asRecord(content);
      return record ? [record] : [];
    });
  });
}

function containsRefusal(body: Record<string, unknown>): boolean {
  return (
    typeof body.refusal === "string" ||
    contentItems(body).some(
      (content) =>
        content.type === "refusal" &&
        typeof content.refusal === "string",
    )
  );
}

function readOutputText(body: Record<string, unknown>): string | undefined {
  if (typeof body.output_text === "string") {
    return body.output_text;
  }

  const texts = contentItems(body)
    .filter(
      (content) =>
        content.type === "output_text" &&
        typeof content.text === "string",
    )
    .map((content) => content.text as string);

  return texts.length > 0 ? texts.join("") : undefined;
}

function instructions(promptVersion: string): string {
  return [
    `Shiori decision contract ${promptVersion}.`,
    "Classify exactly one input as explicit_commitment, implied_intention, or ordinary_question.",
    "Extract only bounded decision fields. Never authorize, confirm, persist, schedule, call tools, or claim an action occurred.",
    "Use an absolute RFC3339 target with +08:00 and targetTimeZone Asia/Singapore, or null for both.",
    "simpleAction and possibleWorkSession must not both be true. Use only the schema's next actions.",
    "For explicit commitments, missingFields must exactly list absent definition_of_done then target.",
    "For implied intentions and ordinary questions, missingFields must be empty.",
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

  async decide(input: string): Promise<DecisionOutcome> {
    let response: Response;

    try {
      response = await this.#fetch(RESPONSES_URL, {
        body: JSON.stringify({
          input,
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
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      return failed(
        error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name)
          ? "timeout"
          : "http",
      );
    }

    if (!response.ok) {
      return failed("http");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failed("provider_error");
    }

    const record = asRecord(body);
    if (
      !record ||
      (record.error !== undefined && record.error !== null) ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      return failed("provider_error");
    }
    if (
      record.status === "incomplete" ||
      record.incomplete_details !== undefined &&
        record.incomplete_details !== null
    ) {
      return failed("incomplete");
    }
    if (containsRefusal(record)) {
      return failed("refusal");
    }

    const outputText = readOutputText(record);
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
    if (!validateDecisionSemantics(decision, this.#now())) {
      return failed("semantic");
    }

    return { decision, ok: true };
  }
}
