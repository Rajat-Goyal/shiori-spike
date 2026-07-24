import type { DecisionResult } from "./schema.js";

export function isExpectedSmokeDecision(
  decision: DecisionResult,
): boolean {
  if (
    decision.inputClass !== "explicit_commitment" ||
    decision.targetAt === null
  ) {
    return false;
  }

  const asksForDefinition =
    decision.nextAction === "ask_definition" &&
    decision.definitionOfDone === null &&
    decision.missingFields.length === 1 &&
    decision.missingFields[0] === "definition_of_done";
  const extractedDefinition =
    decision.nextAction === "ready" &&
    decision.definitionOfDone !== null &&
    decision.missingFields.length === 0;

  return asksForDefinition || extractedDefinition;
}
