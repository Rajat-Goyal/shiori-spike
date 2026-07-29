type PrimitiveSpec =
  | {
      enum?: readonly string[];
      kind: "string";
      maxLength?: number;
      minLength?: number;
      nullable?: boolean;
    }
  | {
      enum?: readonly number[];
      kind: "integer";
      nullable?: boolean;
    }
  | {
      kind: "boolean";
      nullable?: boolean;
    };

type ArraySpec = {
  items: Spec;
  kind: "array";
  maxItems?: number;
  nullable?: boolean;
};

type ObjectSpec = {
  fields: Readonly<Record<string, Spec>>;
  kind: "object";
  nullable?: boolean;
};

type Spec = PrimitiveSpec | ArraySpec | ObjectSpec;

type NullableValue<S, Value> = S extends { nullable: true }
  ? Value | null
  : Value;

type InferSpec<S extends Spec> = S extends {
  enum: readonly (infer Value extends string)[];
  kind: "string";
}
  ? NullableValue<S, Value>
  : S extends { kind: "string" }
    ? NullableValue<S, string>
    : S extends {
          enum: readonly (infer Value extends number)[];
          kind: "integer";
        }
      ? NullableValue<S, Value>
      : S extends { kind: "integer" }
        ? NullableValue<S, number>
        : S extends { kind: "boolean" }
          ? NullableValue<S, boolean>
          : S extends { items: infer Item extends Spec; kind: "array" }
            ? NullableValue<S, Array<InferSpec<Item>>>
            : S extends {
                  fields: infer Fields extends Readonly<Record<string, Spec>>;
                  kind: "object";
                }
              ? NullableValue<
                  S,
                  { [Key in keyof Fields]: InferSpec<Fields[Key]> }
                >
              : never;

const candidateFieldSpecs = {
  definitionOfDone: {
    kind: "string",
    maxLength: 500,
    minLength: 1,
    nullable: true,
  },
  durationMinutes: {
    enum: [30, 60, 90, 120],
    kind: "integer",
    nullable: true,
  },
  offerWorkWindowHelp: {
    kind: "boolean",
  },
  commitmentMode: {
    enum: ["unresolved", "simple_action", "possible_work_session"],
    kind: "string",
  },
  targetAt: {
    kind: "string",
    maxLength: 25,
    minLength: 25,
    nullable: true,
  },
  targetTimeZone: {
    kind: "string",
    maxLength: 64,
    minLength: 1,
    nullable: true,
  },
  timingConstraints: {
    items: {
      kind: "string",
      maxLength: 200,
      minLength: 1,
    },
    kind: "array",
    maxItems: 4,
  },
} as const satisfies Readonly<Record<string, Spec>>;

export const decisionInputSpec = {
  fields: {
    context: {
      fields: {
        fields: {
          fields: candidateFieldSpecs,
          kind: "object",
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
          kind: "string",
        },
      },
      kind: "object",
    },
    ownerText: {
      kind: "string",
      maxLength: 4_096,
      minLength: 1,
    },
  },
  kind: "object",
} as const satisfies Spec;

export const decisionSpec = {
  fields: {
    ...candidateFieldSpecs,
    inputClass: {
      enum: [
        "explicit_commitment",
        "implied_intention",
        "ordinary_question",
      ],
      kind: "string",
    },
    missingFields: {
      items: {
        enum: ["definition_of_done", "target"],
        kind: "string",
      },
      kind: "array",
      maxItems: 2,
    },
    nextAction: {
      enum: [
        "ask_definition",
        "ask_target",
        "ask_permission",
        "answer",
        "ready",
        "offer_work_window",
        "ask_duration",
      ],
      kind: "string",
    },
    response: {
      kind: "string",
      maxLength: 1_000,
      minLength: 1,
    },
    turnRelation: {
      enum: [
        "none",
        "new_request",
        "clarification_continuation",
        "correction",
        "separate_request",
        "permission_accepted",
        "permission_declined",
      ],
      kind: "string",
    },
  },
  kind: "object",
} as const satisfies Spec;

const providerCandidateFieldSpecs = {
  definitionOfDone: candidateFieldSpecs.definitionOfDone,
  durationMinutes: candidateFieldSpecs.durationMinutes,
  commitmentMode: candidateFieldSpecs.commitmentMode,
  targetAt: {
    kind: "string",
    maxLength: 64,
    minLength: 1,
    nullable: true,
  },
  timingConstraints: candidateFieldSpecs.timingConstraints,
} as const satisfies Readonly<Record<string, Spec>>;

export const providerDecisionSpec = {
  fields: {
    ...providerCandidateFieldSpecs,
    inputClass: decisionSpec.fields.inputClass,
    response: {
      kind: "string",
      maxLength: 1_000,
      minLength: 1,
      nullable: true,
    },
    turnRelation: decisionSpec.fields.turnRelation,
  },
  kind: "object",
} as const satisfies Spec;

export type DecisionInput = InferSpec<typeof decisionInputSpec>;
export type DecisionContext = DecisionInput["context"];
export type DecisionCandidateFields = NonNullable<DecisionContext["fields"]>;
/**
 * Application/persistence compatibility shape. Provider semantic output is
 * materialized into this bounded shape before it reaches conversation state.
 */
export type DecisionContextFields = Omit<
  DecisionCandidateFields,
  "commitmentMode"
> & {
  possibleWorkSession: boolean;
  simpleAction: boolean;
};
export type DecisionResult = InferSpec<typeof decisionSpec>;
export type ProviderDecisionResult = InferSpec<
  typeof providerDecisionSpec
>;
export type TurnRelation = DecisionResult["turnRelation"];

type JsonSchema = Readonly<Record<string, unknown>>;

function schemaFor(spec: Spec): JsonSchema {
  let schema: Record<string, unknown>;

  switch (spec.kind) {
    case "string":
      schema = {
        type: "string",
        ...(spec.enum ? { enum: spec.enum } : {}),
        ...(spec.maxLength === undefined
          ? {}
          : { maxLength: spec.maxLength }),
        ...(spec.minLength === undefined
          ? {}
          : { minLength: spec.minLength }),
      };
      break;
    case "integer":
      schema = {
        type: "integer",
        ...(spec.enum ? { enum: spec.enum } : {}),
      };
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "array":
      schema = {
        type: "array",
        items: schemaFor(spec.items),
        ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems }),
      };
      break;
    case "object": {
      const entries = Object.entries(spec.fields);
      schema = {
        additionalProperties: false,
        properties: Object.fromEntries(
          entries.map(([key, field]) => [key, schemaFor(field)]),
        ),
        required: entries.map(([key]) => key),
        type: "object",
      };
      break;
    }
  }

  return spec.nullable
    ? { anyOf: [schema, { type: "null" }] }
    : schema;
}

export const decisionJsonSchema = schemaFor(providerDecisionSpec);

function structurallyMatches(spec: Spec, value: unknown): boolean {
  if (value === null) {
    return spec.nullable === true;
  }

  switch (spec.kind) {
    case "string":
      return (
        typeof value === "string" &&
        (spec.enum === undefined || spec.enum.includes(value)) &&
        (spec.minLength === undefined || value.length >= spec.minLength) &&
        (spec.maxLength === undefined || value.length <= spec.maxLength)
      );
    case "integer":
      return (
        Number.isInteger(value) &&
        (spec.enum === undefined ||
          spec.enum.includes(value as number))
      );
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        (spec.maxItems === undefined || value.length <= spec.maxItems) &&
        value.every((item) => structurallyMatches(spec.items, item))
      );
    case "object": {
      if (
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return false;
      }
      const record = value as Record<string, unknown>;
      const expectedKeys = Object.keys(spec.fields);
      const actualKeys = Object.keys(record);
      return (
        actualKeys.length === expectedKeys.length &&
        expectedKeys.every(
          (key) =>
            Object.hasOwn(record, key) &&
            structurallyMatches(spec.fields[key], record[key]),
        )
      );
    }
  }
}

export function parseDecisionStructure(value: unknown): DecisionResult | null {
  return structurallyMatches(decisionSpec, value)
    ? (value as DecisionResult)
    : null;
}

export function parseProviderDecisionStructure(
  value: unknown,
): ProviderDecisionResult | null {
  return structurallyMatches(providerDecisionSpec, value)
    ? (value as ProviderDecisionResult)
    : null;
}

export function parseDecisionInputStructure(
  value: unknown,
): DecisionInput | null {
  return structurallyMatches(decisionInputSpec, value)
    ? (value as DecisionInput)
    : null;
}
