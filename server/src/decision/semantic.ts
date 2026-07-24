import type { DecisionResult } from "./schema.js";

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

export function validateDecisionSemantics(
  decision: DecisionResult,
  now: Date,
): boolean {
  if (
    decision.definitionOfDone !== null &&
    decision.definitionOfDone.trim().length === 0
  ) {
    return false;
  }
  if (
    decision.response !== null &&
    decision.response.trim().length === 0
  ) {
    return false;
  }
  if (
    decision.timingConstraints.some(
      (constraint) => constraint.trim().length === 0,
    )
  ) {
    return false;
  }
  if (
    (decision.targetAt === null) !==
    (decision.targetTimeZone === null)
  ) {
    return false;
  }
  if (
    decision.targetAt !== null &&
    (decision.targetTimeZone !== "Asia/Singapore" ||
      !validFutureSingaporeTarget(decision.targetAt, now))
  ) {
    return false;
  }
  if (
    (decision.simpleAction && decision.possibleWorkSession) ||
    (decision.inputClass === "explicit_commitment" &&
      decision.simpleAction === decision.possibleWorkSession) ||
    (decision.simpleAction && decision.durationMinutes !== null) ||
    (!decision.possibleWorkSession && decision.offerWorkWindowHelp) ||
    (!decision.possibleWorkSession && decision.durationMinutes !== null)
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
