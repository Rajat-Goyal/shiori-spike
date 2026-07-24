import { readServerConfig } from "../src/config.js";
import { OpenAIDecisionEngine } from "../src/decision/engine.js";
import { isExpectedSmokeDecision } from "../src/decision/smoke-shape.js";

function tomorrowAtTenSingapore(now: Date): string {
  const singaporeNow = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const tomorrow = new Date(
    Date.UTC(
      singaporeNow.getUTCFullYear(),
      singaporeNow.getUTCMonth(),
      singaporeNow.getUTCDate() + 1,
      10,
    ),
  );
  const date = [
    tomorrow.getUTCFullYear().toString().padStart(4, "0"),
    (tomorrow.getUTCMonth() + 1).toString().padStart(2, "0"),
    tomorrow.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
  return `${date}T10:00:00+08:00`;
}

const config = readServerConfig();
const target = tomorrowAtTenSingapore(new Date());
const engine = new OpenAIDecisionEngine({
  apiKey: config.openaiApiKey,
  model: config.openaiModel,
  promptVersion: config.openaiPromptVersion,
});

const outcome = await engine.decide(
  `Synthetic smoke only: submit a synthetic test note by ${target}.`,
);

const expectedShape =
  outcome.ok &&
  isExpectedSmokeDecision(outcome.decision);

if (!outcome.ok || !expectedShape) {
  console.log(
    JSON.stringify({
      failure: outcome.ok ? "unexpected_decision_shape" : outcome.failure,
      ok: false,
    }),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      hasDefinition: outcome.decision.definitionOfDone !== null,
      hasTarget: outcome.decision.targetAt !== null,
      inputClass: outcome.decision.inputClass,
      missingFieldCount: outcome.decision.missingFields.length,
      nextAction: outcome.decision.nextAction,
      ok: true,
    }),
  );
}
