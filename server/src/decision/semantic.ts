import type {
  DecisionCandidateFields,
  DecisionInput,
  DecisionResult,
  ProviderDecisionResult,
} from "./schema.js";

const TARGET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/;

export type DecisionSemanticFailureReason =
  | "clarification_context_mutation"
  | "clarification_filled_nothing"
  | "complete_mode_unresolved"
  | "correction_changed_nothing"
  | "definition_blank"
  | "draft_target_invalid"
  | "implied_payload_conflict"
  | "incomplete_mode_resolved"
  | "input_invalid"
  | "missing_fields_invalid"
  | "next_action_invalid"
  | "ordinary_payload_conflict"
  | "permission_candidate_mismatch"
  | "response_blank"
  | "simple_work_fields"
  | "target_format_invalid"
  | "target_not_future"
  | "target_pair_invalid"
  | "target_timezone_invalid"
  | "timing_constraint_invalid"
  | "unsafe_relation"
  | "unresolved_work_help";

export type DecisionSemanticResult =
  | { ok: true }
  | { ok: false; reason: DecisionSemanticFailureReason };

function singaporeTargetFailureReason(
  value: string,
  now: Date,
): DecisionSemanticFailureReason | undefined {
  const match = TARGET_PATTERN.exec(value);
  if (!match) {
    return /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      ? "target_timezone_invalid"
      : "target_format_invalid";
  }

  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [
    yearNumber,
    monthNumber,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
  ] = parts;
  const utcMillis = Date.UTC(
    yearNumber,
    monthNumber - 1,
    dayNumber,
    hourNumber - 8,
    minuteNumber,
    secondNumber,
  );
  const singapore = new Date(utcMillis + 8 * 60 * 60 * 1_000);

  if (
    !Number.isFinite(utcMillis) ||
    !(
      singapore.getUTCFullYear() === yearNumber &&
      singapore.getUTCMonth() === monthNumber - 1 &&
      singapore.getUTCDate() === dayNumber &&
      singapore.getUTCHours() === hourNumber &&
      singapore.getUTCMinutes() === minuteNumber &&
      singapore.getUTCSeconds() === secondNumber
    )
  ) {
    return "target_format_invalid";
  }
  return utcMillis > now.getTime()
    ? undefined
    : "target_not_future";
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

function canonicalNextAction(
  decision: DecisionResult,
): DecisionResult["nextAction"] {
  switch (decision.inputClass) {
    case "ordinary_question":
      return "answer";
    case "implied_intention":
      return "ask_permission";
    case "explicit_commitment":
      if (decision.definitionOfDone === null) {
        return "ask_definition";
      }
      if (decision.targetAt === null) {
        return "ask_target";
      }
      if (
        decision.commitmentMode === "possible_work_session" &&
        decision.durationMinutes === null
      ) {
        return "offer_work_window";
      }
      return "ready";
  }
}

export function canonicalizeDecision(
  decision: DecisionResult,
  input: DecisionInput,
): DecisionResult {
  const targetTimeZone =
    decision.targetAt !== null && TARGET_PATTERN.test(decision.targetAt)
      ? "Asia/Singapore"
      : decision.targetTimeZone;
  const turnRelation =
    input.context.phase === "none"
      ? decision.inputClass === "ordinary_question"
        ? "none"
        : "new_request"
      : decision.turnRelation;
  const projected = {
    ...decision,
    offerWorkWindowHelp: false,
    targetTimeZone,
    turnRelation,
  };
  return {
    ...projected,
    missingFields: expectedMissingFields(projected),
    nextAction: canonicalNextAction(projected),
  };
}

export function materializeProviderDecision(
  decision: ProviderDecisionResult,
  input: DecisionInput,
): DecisionResult {
  const complete =
    decision.definitionOfDone !== null && decision.targetAt !== null;
  const existingMode =
    input.context.fields?.commitmentMode ?? "unresolved";
  const commitmentMode =
    decision.inputClass === "ordinary_question" || !complete
      ? "unresolved"
      : input.context.phase === "complete" &&
          decision.turnRelation === "correction"
        ? existingMode
        : input.context.phase === "awaiting_permission" &&
            decision.turnRelation === "permission_accepted"
          ? existingMode
          : "possible_work_session";
  return canonicalizeDecision(
    {
      ...decision,
      commitmentMode,
      missingFields: [],
      nextAction: "answer",
      offerWorkWindowHelp: false,
      response: decision.response ?? "",
      targetTimeZone:
        decision.targetAt === null ? null : "Asia/Singapore",
    },
    input,
  );
}

function sameItems(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function candidateFailureReason(
  fields: DecisionCandidateFields | DecisionResult,
  now: Date,
): DecisionSemanticFailureReason | undefined {
  if (
    fields.definitionOfDone !== null &&
    fields.definitionOfDone.trim().length === 0
  ) {
    return "definition_blank";
  }
  if (
    fields.timingConstraints.some(
      (constraint) => constraint.trim().length === 0,
    )
  ) {
    return "timing_constraint_invalid";
  }
  if (
    (fields.targetAt === null) !==
    (fields.targetTimeZone === null)
  ) {
    return "target_pair_invalid";
  }
  if (
    fields.targetAt !== null &&
    fields.targetTimeZone !== "Asia/Singapore"
  ) {
    return "target_timezone_invalid";
  }
  if (fields.targetAt !== null) {
    const targetReason = singaporeTargetFailureReason(
      fields.targetAt,
      now,
    );
    if (targetReason) {
      return targetReason;
    }
  }
  const coreIsIncomplete =
    fields.definitionOfDone === null || fields.targetAt === null;
  if (coreIsIncomplete && fields.commitmentMode !== "unresolved") {
    return "incomplete_mode_resolved";
  }
  if (
    fields.commitmentMode === "unresolved" &&
    fields.offerWorkWindowHelp
  ) {
    return "unresolved_work_help";
  }
  if (
    fields.commitmentMode === "simple_action" &&
    (fields.offerWorkWindowHelp || fields.durationMinutes !== null)
  ) {
    return "simple_work_fields";
  }
  if (
    fields.commitmentMode !== "possible_work_session" &&
    fields.offerWorkWindowHelp
  ) {
    return "unresolved_work_help";
  }
  if (!coreIsIncomplete && fields.commitmentMode === "unresolved") {
    return "complete_mode_unresolved";
  }
  return undefined;
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
  if (fields === null || candidateFailureReason(fields, now)) {
    return false;
  }

  switch (phase) {
    case "awaiting_permission": {
      if (
        fields.durationMinutes !== null ||
        fields.offerWorkWindowHelp
      ) {
        return false;
      }
      const modeIsUnresolved = fields.commitmentMode === "unresolved";
      const coreIsIncomplete =
        fields.definitionOfDone === null || fields.targetAt === null;
      return !modeIsUnresolved || coreIsIncomplete;
    }
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
        fields.commitmentMode !== "unresolved"
      );
  }
}

function candidateFields(decision: DecisionResult): DecisionCandidateFields {
  return {
    commitmentMode: decision.commitmentMode,
    definitionOfDone: decision.definitionOfDone,
    durationMinutes: decision.durationMinutes,
    offerWorkWindowHelp: decision.offerWorkWindowHelp,
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
  left: DecisionCandidateFields,
  right: DecisionCandidateFields,
): boolean {
  return Object.entries(left).every(([key, value]) =>
    sameCandidateValue(
      value,
      right[key as keyof DecisionCandidateFields],
    ),
  );
}

function preservesPopulatedFields(
  context: DecisionCandidateFields,
  decision: DecisionCandidateFields,
): boolean {
  const unresolvedContextMode = context.commitmentMode === "unresolved";
  const resolvedDecisionMode = decision.commitmentMode !== "unresolved";
  return Object.entries(context).every(
    ([key, value]) =>
      value === null ||
      (unresolvedContextMode &&
        resolvedDecisionMode &&
        key === "commitmentMode") ||
      sameCandidateValue(
        value,
        decision[key as keyof DecisionCandidateFields],
      ),
  );
}

function fillsNullField(
  context: DecisionCandidateFields,
  decision: DecisionCandidateFields,
): boolean {
  return Object.entries(context).some(
    ([key, value]) =>
      value === null &&
      decision[key as keyof DecisionCandidateFields] !== null,
  );
}

function changesPopulatedField(
  context: DecisionCandidateFields,
  decision: DecisionCandidateFields,
): boolean {
  return Object.entries(context).some(
    ([key, value]) =>
      value !== null &&
      !(
        key === "commitmentMode" &&
        value === "unresolved" &&
        decision.commitmentMode !== "unresolved"
      ) &&
      !sameCandidateValue(
        value,
        decision[key as keyof DecisionCandidateFields],
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

function relationFailureReason(
  input: DecisionInput,
  decision: DecisionResult,
): DecisionSemanticFailureReason | undefined {
  const contextFields = input.context.fields;
  if (contextFields === null) {
    return undefined;
  }
  const outputFields = candidateFields(decision);
  switch (decision.turnRelation) {
    case "permission_accepted":
      return sameCandidateFields(contextFields, outputFields)
        ? undefined
        : "permission_candidate_mismatch";
    case "clarification_continuation":
      if (input.context.phase === "awaiting_permission") {
        return undefined;
      }
      if (!preservesPopulatedFields(contextFields, outputFields)) {
        return "clarification_context_mutation";
      }
      if (!fillsNullField(contextFields, outputFields)) {
        return "clarification_filled_nothing";
      }
      return undefined;
    case "correction":
      return changesPopulatedField(contextFields, outputFields)
        ? undefined
        : "correction_changed_nothing";
    case "none":
    case "new_request":
    case "permission_declined":
    case "separate_request":
      return undefined;
  }
}

function failed(
  reason: DecisionSemanticFailureReason,
): DecisionSemanticResult {
  return { ok: false, reason };
}

export function evaluateDecisionSemantics(
  decision: DecisionResult,
  input: DecisionInput,
  now: Date,
  sourceDecision: DecisionResult = decision,
): DecisionSemanticResult {
  if (!validateDecisionInputSemantics(input, now)) {
    return failed("input_invalid");
  }
  if (
    decision.inputClass === "ordinary_question" &&
    decision.response.trim().length === 0
  ) {
    return failed("response_blank");
  }
  const candidateReason = candidateFailureReason(decision, now);
  if (candidateReason) {
    return failed(candidateReason);
  }
  if (!allowedRelationTuple(input, decision)) {
    return failed("unsafe_relation");
  }
  const relationReason = relationFailureReason(input, sourceDecision);
  if (relationReason) {
    return failed(relationReason);
  }
  if (
    new Set(decision.missingFields).size !==
      decision.missingFields.length ||
    !sameItems(decision.missingFields, expectedMissingFields(decision))
  ) {
    return failed("missing_fields_invalid");
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
        decision.commitmentMode === "unresolved" &&
        decision.timingConstraints.length === 0 &&
        decision.nextAction === "answer"
      )
        ? { ok: true }
        : failed("ordinary_payload_conflict");
    case "implied_intention":
      return (
        decision.durationMinutes === null &&
        !decision.offerWorkWindowHelp &&
        (decision.commitmentMode !== "unresolved" ||
          decision.definitionOfDone === null ||
          decision.targetAt === null) &&
        decision.nextAction === "ask_permission"
      )
        ? { ok: true }
        : failed("implied_payload_conflict");
    case "explicit_commitment": {
      const [firstMissing] = decision.missingFields;
      if (firstMissing === "definition_of_done") {
        return decision.nextAction === "ask_definition"
          ? { ok: true }
          : failed("next_action_invalid");
      }
      if (firstMissing === "target") {
        return decision.nextAction === "ask_target"
          ? { ok: true }
          : failed("next_action_invalid");
      }
      if (decision.commitmentMode === "simple_action") {
        return (
          decision.nextAction === "ready" &&
          !decision.offerWorkWindowHelp
        )
          ? { ok: true }
          : failed("next_action_invalid");
      }
      if (decision.durationMinutes === null) {
        return decision.nextAction === "offer_work_window"
          ? { ok: true }
          : failed("next_action_invalid");
      }
      return decision.nextAction === "ready"
        ? { ok: true }
        : failed("next_action_invalid");
    }
  }
}

export function validateDecisionSemantics(
  decision: DecisionResult,
  input: DecisionInput,
  now: Date,
): boolean {
  const canonical = canonicalizeDecision(decision, input);
  return evaluateDecisionSemantics(
    canonical,
    input,
    now,
    decision,
  ).ok;
}
