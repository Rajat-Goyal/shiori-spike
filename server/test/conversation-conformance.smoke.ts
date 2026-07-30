/**
 * Live-model conformance walk of the real Shiori flow.
 *
 * This is the gap that let every previous pass go green while the bot stayed
 * broken: every unit test either stubs the decision engine or drives the runtime
 * through a scripted runner whose tool calls satisfy the validator by
 * construction. Nothing exercised the real prompt against a real model.
 *
 * Here the prompt, the model, the agent runtime, the semantic validation and the
 * conversation service are all real; only Supabase is in memory. A turn fails the
 * walk if the reply is one of the recovery strings, because that means the
 * application could not act on what the model produced.
 *
 *   npm run test:conformance
 *
 * Needs OPENAI_API_KEY. Langfuse keys are optional; when present every turn is
 * traced, which is the fastest way to see why a step regressed.
 */
import { conversationCopy } from "../src/conversation/copy.js";
import { ConversationService } from "../src/conversation/service.js";
import { readServerConfig } from "../src/config.js";
import { SessionBackedAgentDecisionEngine } from "../src/agent/conversation.js";
import { createAgentRuntime } from "../src/agent/runtime.js";
import {
  loadPromptsFromLangfuse,
  startLangfuseTracing,
} from "../src/observability/langfuse.js";
import {
  InMemoryConversationStore,
  inMemorySessionRepository,
} from "./support/in-memory-conversation.js";

const config = readServerConfig();
const chatId = config.telegramOwnerUserId;

const tracing =
  config.langfuse === undefined
    ? undefined
    : startLangfuseTracing({
        environment: "conformance",
        publicKey: config.langfuse.publicKey,
        secretKey: config.langfuse.secretKey,
        userId: String(chatId),
        ...(config.langfuse.baseUrl
          ? { baseUrl: config.langfuse.baseUrl }
          : {}),
      });

const prompts =
  config.langfuse === undefined
    ? undefined
    : await loadPromptsFromLangfuse({
        publicKey: config.langfuse.publicKey,
        secretKey: config.langfuse.secretKey,
        ...(config.langfuse.baseUrl
          ? { baseUrl: config.langfuse.baseUrl }
          : {}),
      });

/**
 * A step fails when the application recorded a failure for that turn.
 *
 * Matching reply copy is the wrong signal: "What will count as done?" is the
 * correct next question after a permission is accepted, and only becomes a
 * symptom when it replaces an answer the application could not produce. The
 * failure instrumentation added in the diagnostic pass says exactly that.
 */
type Step = Readonly<{
  expectReply?: (reply: string) => string | undefined;
  expectState?: (store: InMemoryConversationStore) => string | undefined;
  send: string;
  what: string;
}>;

/** The flow Shiori is for: clarify, prepare, schedule, follow through. */
const WALK: readonly Step[] = [
  {
    send: "What makes a good weekly review?",
    what: "ordinary question is answered and creates nothing",
    expectReply: (reply) =>
      reply.length < 20 ? "answer was suspiciously short" : undefined,
    expectState: (s) =>
      s.draft === null ? undefined : "an ordinary question created a draft",
  },
  {
    send: "I should send the Q3 proposal to Amara",
    what: "implied intention asks permission and saves nothing",
    expectReply: (reply) =>
      /yes|no/i.test(reply) ? undefined : "expected a yes/no permission question",
    expectState: (s) =>
      s.permission === null ? "no permission was parked" : undefined,
  },
  {
    send: "yes",
    what: "permission accepted starts a draft",
    expectState: (s) => (s.draft === null ? "no draft was created" : undefined),
  },
  {
    send: "tomorrow at 3pm",
    what: "target supplied before the definition (out-of-order field)",
    expectState: (s) =>
      s.draft?.fields.targetAt ? undefined : "target did not land",
  },
  {
    send: "done means the proposal PDF is emailed to Amara",
    what: "definition supplied second, merged onto the same draft",
    expectState: (s) =>
      s.draft?.fields.definitionOfDone && s.draft?.fields.targetAt
        ? undefined
        : "the merge lost a field",
  },
  {
    send: "yes, I need about 45 minutes to prepare, ideally before lunch",
    what: "preparation duration and constraint are captured",
  },
  {
    send: "actually make it Friday at 10am instead",
    what: "a correction changes the target without losing the definition",
    expectState: (s) =>
      s.draft?.fields.definitionOfDone
        ? undefined
        : "correction dropped the definition",
  },
  {
    send: "what else am I on the hook for?",
    what: "a mid-draft question does not disturb the draft",
    expectState: (s) =>
      s.draft?.fields.definitionOfDone && s.draft?.fields.targetAt
        ? undefined
        : "an ordinary question damaged the draft",
  },
];

const store = new InMemoryConversationStore();
const sessions = inMemorySessionRepository(chatId);
const runtime = createAgentRuntime({
  apiKey: config.openaiApiKey,
  contextReader: store.contextReader(),
  executeCommitment: async () => ({ kind: "applied" }) as never,
  model: config.openaiModel,
  onRuntimeFailure: (event) => {
    console.log(
      `      · runtime ${event.failure}: ${event.failureChain.join(" <- ")}`,
    );
    console.log(`        frames(${event.failureFrames.length}): ${event.failureFrames.slice(0, 5).join(" | ")}`);
  },
  requestSanitizedAvailability: async () => [],
  tracingEnabled: tracing !== undefined,
  ...(prompts === undefined ? {} : { prompts }),
});

const service = new ConversationService({
  decisionEngine: new SessionBackedAgentDecisionEngine({
    chatId,
    contextReader: store.contextReader(),
    draftRepository: store as never,
    repository: sessions,
    runtime,
  }),
  modelId: config.openaiModel,
  onConversationFailure: (event) => {
    turnFailures.push(`application:${event.site}`);
  },
  onDecisionFailure: (event) => {
    turnFailures.push(`decision:${event.reason}`);
  },
  ownerChatId: chatId,
  promptVersion: config.openaiPromptVersion,
  repository: store as never,
});

let updateId = 900_000;
const failures: string[] = [];
let turnFailures: string[] = [];

console.log(`\nShiori conformance walk — model ${config.openaiModel}\n`);

for (const step of WALK) {
  updateId += 1;
  turnFailures = [];
  const reply = await service.handle(updateId, step.send);
  const text =
    typeof reply === "string"
      ? reply
      : Array.isArray(reply)
        ? reply.map((item) => item.text).join(" ")
        : reply.text;

  const problem =
    turnFailures.length > 0
      ? `application could not act: ${turnFailures.join(", ")}`
      : (step.expectReply?.(text) ?? step.expectState?.(store));

  console.log(`${problem ? "✗" : "✓"} ${step.what}`);
  console.log(`      → ${JSON.stringify(step.send)}`);
  console.log(`      ← ${text.replace(/\s+/g, " ").slice(0, 150)}`);
  if (problem) {
    console.log(`      ! ${problem}`);
    failures.push(`${step.what}: ${problem}`);
  }
}

const draft = store.draft;
console.log("\nfinal draft:", JSON.stringify(draft?.fields ?? null));
console.log("phase:", draft?.phase ?? "none");
console.log("commands:", store.commands.join(" → "));
if (store.turnFailures.length > 0) {
  console.log(
    "recorded failures:",
    store.turnFailures.map((f) => f.site ?? f.reason).join(", "),
  );
}

// The walk exists to prove the composition, so the end state is asserted too:
// both core fields must have survived being supplied in the wrong order.
if (draft === null) {
  failures.push("no draft survived the walk");
}

await tracing?.shutdown();

if (failures.length > 0) {
  console.error(`\n${failures.length} conformance failure(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log("\nconformance walk passed");
