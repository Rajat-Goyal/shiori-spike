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

/**
 * Derives the turn relation from what actually changed.
 *
 * Previously the model chose the relation and a per-phase legality table rejected
 * the turn when its choice did not fit the wizard. The application can see what
 * the merge did, so it decides: filling a blank is a clarification, changing a
 * populated field is a correction. The model still owns the two judgements only it
 * can make — whether a permission answer was yes or no, and whether the owner
 * started a separate promise.
 */
function derivedTurnRelation(
  decision: DecisionResult,
  input: DecisionInput,
): DecisionResult["turnRelation"] {
  if (decision.inputClass === "ordinary_question") {
    // Preserve a declined permission: only the model can read "no".
    return input.context.phase === "awaiting_permission" &&
      decision.turnRelation === "permission_declined"
      ? "permission_declined"
      : input.context.phase === "awaiting_permission"
        ? decision.turnRelation
        : "none";
  }
  const context = input.context.fields;
  if (input.context.phase === "none" || context === null) {
    return "new_request";
  }
  // Only the model can tell a follow-up from a genuinely separate promise, and
  // only it can read a permission acceptance.
  if (
    decision.turnRelation === "separate_request" ||
    decision.turnRelation === "permission_accepted"
  ) {
    return decision.turnRelation;
  }
  return changesPopulatedField(context, candidateFields(decision))
    ? "correction"
    : "clarification_continuation";
}

export function canonicalizeDecision(
  decision: DecisionResult,
  input: DecisionInput,
): DecisionResult {
  const targetTimeZone =
    decision.targetAt !== null && TARGET_PATTERN.test(decision.targetAt)
      ? "Asia/Singapore"
      : decision.targetTimeZone;
  const turnRelation = derivedTurnRelation(decision, input);
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

const MERGEABLE_FIELDS = [
  "definitionOfDone",
  "durationMinutes",
  "targetAt",
  "timingConstraints",
] as const;

type MergeableField = (typeof MERGEABLE_FIELDS)[number];

function isEmptyValue(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * Merges a proposal onto authoritative draft state.
 *
 * This is the delta contract. Previously the model had to re-emit every existing
 * field byte-for-byte to prove it changed nothing, and any deviation — a
 * different capitalization, a reordered constraint — failed the whole turn. The
 * application already owns the draft, so a proposal now only needs to carry what
 * changed: an empty field means "unchanged", and an explicit `clearFields` entry
 * means "erase".
 *
 * The practical effect is that the owner can supply the definition and the target
 * in either order, across any number of turns, and mid-conversation questions no
 * longer risk dropping the draft.
 */
export function mergeProposalOntoContext(
  decision: ProviderDecisionResult,
  context: DecisionCandidateFields | null,
): {
  definitionOfDone: string | null;
  durationMinutes: number | null;
  targetAt: string | null;
  timingConstraints: string[];
} {
  const cleared = new Set<string>(decision.clearFields);
  const merged = {
    definitionOfDone: decision.definitionOfDone,
    durationMinutes: decision.durationMinutes,
    targetAt: decision.targetAt,
    timingConstraints: [...decision.timingConstraints],
  };
  // A separate request starts a new promise. Merging the focused draft into it
  // would silently graft the old target and definition onto the new one.
  if (
    context === null ||
    decision.turnRelation === "separate_request" ||
    decision.turnRelation === "new_request"
  ) {
    return merged;
  }
  for (const field of MERGEABLE_FIELDS) {
    if (cleared.has(field)) {
      continue;
    }
    if (isEmptyValue(merged[field]) && !isEmptyValue(context[field])) {
      // Carry the authoritative value forward rather than treating the model's
      // silence as an erase.
      (merged as Record<MergeableField, unknown>)[field] =
        Array.isArray(context[field])
          ? [...(context[field] as readonly string[])]
          : context[field];
    }
  }
  return merged;
}

export function materializeProviderDecision(
  decision: ProviderDecisionResult,
  input: DecisionInput,
): DecisionResult {
  // An ordinary question must not inherit draft fields; it changes nothing.
  const mergedFields =
    decision.inputClass === "ordinary_question"
      ? {
          definitionOfDone: null,
          durationMinutes: null,
          targetAt: null,
          timingConstraints: [] as string[],
        }
      : mergeProposalOntoContext(decision, input.context.fields);
  // clearFields is a wire-level instruction, not part of the materialized
  // decision, and must not leak into persisted state.
  const { clearFields: _clearFields, ...proposal } = decision;
  decision = { ...proposal, ...mergedFields } as ProviderDecisionResult;
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
  allowPastTarget = false,
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
    if (
      targetReason &&
      !(allowPastTarget && targetReason === "target_not_future")
    ) {
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
  if (fields === null || candidateFailureReason(fields, now, true)) {
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

/**
 * Guards only the relations the application cannot derive.
 *
 * The per-phase legality table is gone. Clarification and correction are now
 * derived from what the merge actually changed, so the model can no longer pick
 * an "illegal" relation. What remains genuinely phase-bound is permission: an
 * acceptance or a decline is only meaningful while a permission request is open.
 */
function allowedRelationTuple(
  input: DecisionInput,
  decision: DecisionResult,
): boolean {
  const awaitingPermission =
    input.context.phase === "awaiting_permission";
  if (decision.turnRelation === "permission_accepted") {
    return awaitingPermission &&
      decision.inputClass === "explicit_commitment";
  }
  if (decision.turnRelation === "permission_declined") {
    return awaitingPermission &&
      decision.inputClass === "ordinary_question";
  }
  return true;
}

/**
 * Only the permission copy is still checked field-by-field.
 *
 * `clarification_context_mutation`, `clarification_filled_nothing` and
 * `correction_changed_nothing` are dropped: the application merges the proposal
 * onto authoritative state, so populated fields are preserved by construction and
 * the relation is derived from the merge rather than claimed by the model.
 * Validating the model's echo against state the application already owns was the
 * single largest source of fail-closed turns.
 */
function relationFailureReason(
  input: DecisionInput,
  decision: DecisionResult,
): DecisionSemanticFailureReason | undefined {
  const contextFields = input.context.fields;
  if (
    contextFields === null ||
    decision.turnRelation !== "permission_accepted"
  ) {
    return undefined;
  }
  return sameCandidateFields(contextFields, candidateFields(decision))
    ? undefined
    : "permission_candidate_mismatch";
}

function failed(
  reason: DecisionSemanticFailureReason,
): DecisionSemanticResult {
  return { ok: false, reason };
}

/**
 * Actionable repair guidance per semantic failure reason.
 *
 * Returned to the model alongside a rejected proposal. A bare enum tells the
 * model *that* it failed and never *what to change*, which makes the in-run
 * retry almost useless.
 */
export const correctiveInstructions = {
  clarification_context_mutation:
    "Preserve every populated context candidate field exactly.",
  clarification_filled_nothing:
    "A clarification must fill at least one null context candidate field.",
  complete_mode_unresolved:
    "Resolve a complete candidate to simple_action or possible_work_session.",
  correction_changed_nothing:
    "Use correction only when a populated context candidate field changes.",
  definition_blank:
    "Use a non-blank definitionOfDone or null.",
  draft_target_invalid:
    "Use the exact application-owned target only for a clarification or correction; a separate request must use no target.",
  implied_payload_conflict:
    "For implied_intention, keep duration null and use ask_permission.",
  incomplete_mode_resolved:
    "Use unresolved commitmentMode whenever either core field is missing.",
  input_invalid:
    "Follow the supplied bounded phase and context exactly.",
  missing_fields_invalid:
    "Derive missingFields only from absent core fields in canonical order.",
  next_action_invalid:
    "Choose the nextAction implied by class, core fields, mode, and duration.",
  ordinary_payload_conflict:
    "For ordinary_question, return no commitment candidate fields.",
  permission_candidate_mismatch:
    "For permission_accepted, copy every context candidate field exactly.",
  response_blank:
    "Return a non-blank response.",
  simple_work_fields:
    "Do not attach duration or work-help fields to simple_action.",
  target_format_invalid:
    "Use a real calendar date in absolute RFC3339 format.",
  target_not_future:
    "Use a target strictly after the immutable decision reference time.",
  target_pair_invalid:
    "Return an absolute targetAt or null.",
  target_timezone_invalid:
    "Use the exact +08:00 offset in targetAt.",
  timing_constraint_invalid:
    "Use only non-blank bounded timing constraints.",
  unsafe_relation:
    "Choose only the relation allowed for the supplied phase and class.",
  unresolved_work_help:
    "Keep work-help false until the candidate mode is resolved.",
} as const satisfies Record<DecisionSemanticFailureReason, string>;

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
