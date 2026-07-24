import type {
  DecisionContextFields,
  DecisionInput,
  DecisionResult,
} from "./schema.js";

const TARGET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/;

function validFutureSingaporeTarget(value: string, now: Date): boolean {
  const match = TARGET_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] =
    parts;
  const utcMillis = Date.UTC(
    yearNumber,
    monthNumber - 1,
    dayNumber,
    hourNumber - 8,
    minuteNumber,
    secondNumber,
  );
  const singapore = new Date(utcMillis + 8 * 60 * 60 * 1_000);

  return (
    Number.isFinite(utcMillis) &&
    singapore.getUTCFullYear() === yearNumber &&
    singapore.getUTCMonth() === monthNumber - 1 &&
    singapore.getUTCDate() === dayNumber &&
    singapore.getUTCHours() === hourNumber &&
    singapore.getUTCMinutes() === minuteNumber &&
    singapore.getUTCSeconds() === secondNumber &&
    utcMillis > now.getTime()
  );
}

function expectedMissingFields(
  decision: DecisionResult,
): DecisionResult["missingFields"] {
  if (decision.inputClass !== "explicit_commitment") {
    return [];
  }

  const fields: DecisionResult["missingFields"] = [];
  if (decision.definitionOfDone === null) {
    fields.push("definition_of_done");
  }
  if (decision.targetAt === null) {
    fields.push("target");
  }
  return fields;
}

function sameItems(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function validCandidateFields(
  fields: DecisionContextFields | DecisionResult,
  now: Date,
): boolean {
  if (
    fields.definitionOfDone !== null &&
    fields.definitionOfDone.trim().length === 0
  ) {
    return false;
  }
  if (
    fields.timingConstraints.some(
      (constraint) => constraint.trim().length === 0,
    )
  ) {
    return false;
  }
  if (
    (fields.targetAt === null) !==
    (fields.targetTimeZone === null)
  ) {
    return false;
  }
  if (
    fields.targetAt !== null &&
    (fields.targetTimeZone !== "Asia/Singapore" ||
      !validFutureSingaporeTarget(fields.targetAt, now))
  ) {
    return false;
  }
  return !(
    (fields.simpleAction && fields.possibleWorkSession) ||
    (fields.simpleAction && fields.durationMinutes !== null) ||
    (!fields.possibleWorkSession && fields.offerWorkWindowHelp) ||
    (!fields.possibleWorkSession && fields.durationMinutes !== null)
  );
}

export function validateDecisionInputSemantics(
  input: DecisionInput,
  now: Date,
): boolean {
  if (input.ownerText.trim().length === 0) {
    return false;
  }
  const { fields, phase } = input.context;
  if (phase === "none") {
    return fields === null;
  }
  if (fields === null || !validCandidateFields(fields, now)) {
    return false;
  }

  switch (phase) {
    case "awaiting_permission":
      return true;
    case "awaiting_definition":
      return fields.definitionOfDone === null;
    case "awaiting_target":
      return (
        fields.definitionOfDone !== null &&
        fields.targetAt === null &&
        fields.targetTimeZone === null
      );
    case "complete":
      return (
        fields.definitionOfDone !== null &&
        fields.targetAt !== null &&
        fields.targetTimeZone !== null &&
        fields.simpleAction !== fields.possibleWorkSession
      );
  }
}

function candidateFields(decision: DecisionResult): DecisionContextFields {
  return {
    definitionOfDone: decision.definitionOfDone,
    durationMinutes: decision.durationMinutes,
    offerWorkWindowHelp: decision.offerWorkWindowHelp,
    possibleWorkSession: decision.possibleWorkSession,
    simpleAction: decision.simpleAction,
    targetAt: decision.targetAt,
    targetTimeZone: decision.targetTimeZone,
    timingConstraints: decision.timingConstraints,
  };
}

function sameCandidateValue(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? sameItems(left, right)
    : left === right;
}

function sameCandidateFields(
  left: DecisionContextFields,
  right: DecisionContextFields,
): boolean {
  return Object.entries(left).every(([key, value]) =>
    sameCandidateValue(
      value,
      right[key as keyof DecisionContextFields],
    ),
  );
}

function preservesPopulatedFields(
  context: DecisionContextFields,
  decision: DecisionContextFields,
): boolean {
  return Object.entries(context).every(
    ([key, value]) =>
      value === null ||
      sameCandidateValue(
        value,
        decision[key as keyof DecisionContextFields],
      ),
  );
}

function fillsNullField(
  context: DecisionContextFields,
  decision: DecisionContextFields,
): boolean {
  return Object.entries(context).some(
    ([key, value]) =>
      value === null &&
      decision[key as keyof DecisionContextFields] !== null,
  );
}

function changesPopulatedField(
  context: DecisionContextFields,
  decision: DecisionContextFields,
): boolean {
  return Object.entries(context).some(
    ([key, value]) =>
      value !== null &&
      !sameCandidateValue(
        value,
        decision[key as keyof DecisionContextFields],
      ),
  );
}

function allowedRelationTuple(
  input: DecisionInput,
  decision: DecisionResult,
): boolean {
  const tuple = `${decision.turnRelation}:${decision.inputClass}`;
  switch (input.context.phase) {
    case "none":
      return [
        "new_request:explicit_commitment",
        "new_request:implied_intention",
        "none:ordinary_question",
      ].includes(tuple);
    case "awaiting_permission":
      return [
        "permission_accepted:explicit_commitment",
        "permission_declined:ordinary_question",
        "clarification_continuation:ordinary_question",
        "separate_request:explicit_commitment",
        "separate_request:implied_intention",
        "none:ordinary_question",
      ].includes(tuple);
    case "awaiting_definition":
    case "awaiting_target":
      return [
        "clarification_continuation:explicit_commitment",
        "correction:explicit_commitment",
        "separate_request:explicit_commitment",
        "separate_request:implied_intention",
        "none:ordinary_question",
      ].includes(tuple);
    case "complete":
      return [
        "correction:explicit_commitment",
        "separate_request:explicit_commitment",
        "separate_request:implied_intention",
        "none:ordinary_question",
      ].includes(tuple);
  }
}

function relationFieldsAreValid(
  input: DecisionInput,
  decision: DecisionResult,
): boolean {
  const contextFields = input.context.fields;
  if (contextFields === null) {
    return true;
  }
  const outputFields = candidateFields(decision);
  switch (decision.turnRelation) {
    case "permission_accepted":
      return sameCandidateFields(contextFields, outputFields);
    case "clarification_continuation":
      return input.context.phase === "awaiting_permission"
        ? true
        : preservesPopulatedFields(contextFields, outputFields) &&
            fillsNullField(contextFields, outputFields);
    case "correction":
      return changesPopulatedField(contextFields, outputFields);
    case "none":
    case "new_request":
    case "permission_declined":
    case "separate_request":
      return true;
  }
}

export function validateDecisionSemantics(
  decision: DecisionResult,
  input: DecisionInput,
  now: Date,
): boolean {
  if (!validateDecisionInputSemantics(input, now)) {
    return false;
  }
  if (
    decision.response !== null &&
    decision.response.trim().length === 0
  ) {
    return false;
  }
  if (!validCandidateFields(decision, now)) {
    return false;
  }
  if (
    (decision.inputClass === "explicit_commitment" &&
      decision.simpleAction === decision.possibleWorkSession) ||
    !allowedRelationTuple(input, decision) ||
    !relationFieldsAreValid(input, decision)
  ) {
    return false;
  }
  if (
    new Set(decision.missingFields).size !==
      decision.missingFields.length ||
    !sameItems(decision.missingFields, expectedMissingFields(decision))
  ) {
    return false;
  }

  switch (decision.inputClass) {
    case "ordinary_question":
      return (
        decision.definitionOfDone === null &&
        decision.targetAt === null &&
        decision.targetTimeZone === null &&
        decision.durationMinutes === null &&
        decision.missingFields.length === 0 &&
        !decision.offerWorkWindowHelp &&
        !decision.possibleWorkSession &&
        !decision.simpleAction &&
        decision.timingConstraints.length === 0 &&
        decision.nextAction === "answer" &&
        decision.response !== null
      );
    case "implied_intention":
      return (
        decision.durationMinutes === null &&
        !decision.offerWorkWindowHelp &&
        decision.nextAction === "ask_permission" &&
        decision.response !== null
      );
    case "explicit_commitment": {
      const [firstMissing] = decision.missingFields;
      if (firstMissing === "definition_of_done") {
        return (
          decision.nextAction === "ask_definition" &&
          decision.response !== null
        );
      }
      if (firstMissing === "target") {
        return (
          decision.nextAction === "ask_target" &&
          decision.response !== null
        );
      }
      if (decision.simpleAction) {
        return (
          decision.nextAction === "ready" &&
          !decision.offerWorkWindowHelp &&
          decision.response !== null
        );
      }
      if (decision.durationMinutes === null) {
        return (
          decision.nextAction ===
            (decision.offerWorkWindowHelp
              ? "ask_duration"
              : "offer_work_window") &&
          decision.response !== null
        );
      }
      return (
        decision.nextAction === "ready" &&
        decision.response !== null
      );
    }
  }
}
