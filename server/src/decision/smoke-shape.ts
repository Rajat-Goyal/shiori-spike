import type {
  DecisionContextFields,
  DecisionResult,
} from "./schema.js";

export function isExpectedSmokeDecision(
  decision: DecisionResult,
  expectedFields: DecisionContextFields,
): boolean {
  return (
    decision.inputClass === "explicit_commitment" &&
    decision.turnRelation === "permission_accepted" &&
    decision.nextAction === "ready" &&
    decision.missingFields.length === 0 &&
    decision.definitionOfDone === expectedFields.definitionOfDone &&
    decision.durationMinutes === expectedFields.durationMinutes &&
    decision.offerWorkWindowHelp === expectedFields.offerWorkWindowHelp &&
    decision.possibleWorkSession === expectedFields.possibleWorkSession &&
    decision.simpleAction === expectedFields.simpleAction &&
    decision.targetAt === expectedFields.targetAt &&
    decision.targetTimeZone === expectedFields.targetTimeZone &&
    decision.timingConstraints.length ===
      expectedFields.timingConstraints.length &&
    decision.timingConstraints.every(
      (constraint, index) =>
        constraint === expectedFields.timingConstraints[index],
    )
  );
}
