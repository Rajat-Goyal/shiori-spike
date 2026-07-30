/**
 * Proves the Agents SDK -> Langfuse bridge end to end against live services.
 *
 * Runs one real bounded agent turn with tracing enabled, then prints the trace
 * id so it can be fetched and audited. Excluded from `npm run check`: it needs
 * an OpenAI key, Langfuse keys, and network.
 *
 *   node --env-file=.env.local server/dist/test/langfuse-tracing.smoke.js
 */
import { Agent, run, tool, withTrace } from "@openai/agents";
import { z } from "zod";
import { readServerConfig } from "../src/config.js";
import { startLangfuseTracing } from "../src/observability/langfuse.js";

const config = readServerConfig();
if (config.langfuse === undefined) {
  throw new Error(
    "Langfuse keys are required: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
  );
}

const tracing = startLangfuseTracing({
  environment: "development",
  onError: (event) => {
    console.error("tracing failure", event);
  },
  publicKey: config.langfuse.publicKey,
  secretKey: config.langfuse.secretKey,
  userId: String(config.telegramOwnerUserId),
  ...(config.langfuse.baseUrl ? { baseUrl: config.langfuse.baseUrl } : {}),
});

// Mirrors the shape of the real decision contract: one bounded proposal tool
// that the application validates and can reject.
const proposeDraftUpdate = tool({
  description:
    "Submit the one bounded semantic decision proposal. The application materializes and validates it before accepting it.",
  name: "propose_draft_update",
  parameters: z
    .object({
      definitionOfDone: z.string().nullable(),
      inputClass: z.enum([
        "explicit_commitment",
        "implied_intention",
        "ordinary_question",
      ]),
      targetAt: z.string().nullable(),
    })
    .strict(),
  strict: true,
  execute: (value) => {
    // Reject once, exactly as the real validator does, so the trace shows a
    // rejected tool call followed by the model's correction.
    if (value.targetAt !== null && !value.targetAt.endsWith("+08:00")) {
      return { accepted: false, reason: "target_timezone_invalid" };
    }
    return { accepted: true, decision: value };
  },
});

const agent = new Agent({
  instructions: [
    "Shiori bounded decision smoke.",
    "Classify the owner turn as explicit_commitment, implied_intention, or ordinary_question.",
    "Use an absolute RFC3339 targetAt with +08:00, or null.",
    "Every decision must be submitted through propose_draft_update.",
  ].join(" "),
  model: config.openaiModel,
  name: "Shiori bounded decision",
  tools: [proposeDraftUpdate],
});

const traceId = await withTrace(
  "shiori-bounded-decision",
  async (trace) => {
    const result = await run(
      agent,
      "Remind me to send the proposal tomorrow at 3pm.",
      { maxTurns: 6 },
    );
    console.log("final output:", result.finalOutput);
    return trace.traceId;
  },
  { groupId: `smoke-session-${config.telegramOwnerUserId}` },
);

await tracing.shutdown();

console.log("agent traceId:", traceId);
console.log(
  "audit with: npx langfuse-cli api traces list --limit 1",
);
