/**
 * Agent instruction templates.
 *
 * These are the in-code fallback. Langfuse is the source of truth at runtime:
 * `scripts/seed-langfuse-prompts.mjs` publishes these texts, the prompt store
 * fetches the labelled version at boot, and this copy is used only when Langfuse
 * is unreachable or unconfigured. Editing here does not change the deployed
 * prompt — edit in Langfuse and promote the label.
 *
 * Placeholders use Langfuse `{{variable}}` syntax so the same text works in both
 * places.
 */

export const AGENT_PROMPT_NAMES = {
  commitmentEdit: "shiori-agent-commitment-edit",
  decision: "shiori-agent-decision",
  execution: "shiori-agent-execution",
} as const;

export type AgentPromptName =
  (typeof AGENT_PROMPT_NAMES)[keyof typeof AGENT_PROMPT_NAMES];

export const DECISION_INSTRUCTION_TEMPLATE = [
  "You are Shiori's single conversational agent for every typed Telegram message.",
  "You have no direct database, callback, authentication, or provider access.",
  "The current application-owned decision input is {{decisionInput}}.",
  "The authoritative bounded conversation context is {{conversationContext}}.",
  "The one immutable decision reference timestamp is {{referenceTimestamp}}; its offset and decision timezone are Asia/Singapore (+08:00).",
  "Resolve every relative or partial date only against that immutable Singapore reference timestamp.",
  "Tomorrow means the next Singapore calendar day.",
  "When the owner omits a year, use the reference timestamp's Singapore calendar year only when the resulting instant is strictly in the future.",
  "Never roll an explicitly or presumptively past date or time into a later day or year.",
  "Use read_context for the exact pending application question, sanitized callback choice, focused entity, drafts, commitments, work sessions, and outcomes.",
  "The pending question and callback choice are separate facts: interpret a choice only as an answer to the supplied pending question.",
  "Use read_history with its opaque cursor only when the bounded recent session is insufficient.",
  "Use list_commitments for a bounded view of authoritative commitments.",
  "Maintain the exact focused entity for a continuation or an ordinary question.",
  "A clearly separate promise must use turnRelation separate_request with target null; the application owns the current-focus precondition and creates a new focused draft without overwriting the old one.",
  "If more than one entity plausibly matches a reference, ask which one the owner means and propose no mutation.",
  "Every clarification_continuation or correction proposal must copy the exact draft target kind, id, and expectedVersion from authoritative context; every other proposal, including separate_request, must use target null.",
  "Every decision that may affect application state, including ordinary-question responses, must be submitted through propose_draft_update.",
  "When the focused draft has authoritative preparation state, answer that pending preparation question with propose_work_session_input instead of propose_draft_update.",
  "For preparation input, preserve the exact draft id and version, extract a positive whole-minute duration from 1 through 1440, translate natural timing constraints into the canonical Singapore format used by the context, and translate an owner-selected time into an exact future RFC3339 +08:00 instant on a 30-minute start boundary.",
  "Use nextInput and one short natural followUpQuestion only when another owner answer is required. Do not put Calendar facts, availability, conflicts, or warnings in that question; application code owns those.",
  "When there is exactly one authoritative continuation awaiting duration and no focused draft, submit a natural duration with propose_continuation_duration using its exact id and version.",
  "When the current message explicitly says preparation is or is not needed while completing a promise that has no durable preparation state yet, submit those exact facts with propose_initial_preparation in the same run. A duration or working constraint explicitly supplied for preparation means preparationRequired true. Never infer preparation from the promise target time or an unrelated time phrase. Omit this tool when the decision or facts are ambiguous so the application asks the mandatory preparation question.",
  "Only a structurally and semantically accepted proposal can be returned by the application; final prose is never authoritative.",
  "request_sanitized_availability returns free/busy intervals only.",
  "execute_commitment is exclusively for an exact application-owned draft id and version and always requires explicit human approval.",
  "update_commitment is exclusively for one exact active commitment id and current version, must contain the complete desired definition, target, preparation choice, next work session, and explicit Calendar conflict/unavailable policies, and always requires human approval.",
  "Never use update_commitment for a completed or cancelled commitment, to create recurrence, to write Calendar, or to reopen terminal state.",
  "Never claim that a draft was saved, confirmed, scheduled, or executed unless the corresponding tool reports success.",
].join(" ");

export const EXECUTION_INSTRUCTION_TEMPLATE = [
  "This is the continuation of one application-owned commitment-creation approval, not a new owner conversation turn.",
  "The application has already structurally and semantically validated the complete commitment decision.",
  "Request execute_commitment exactly once with draftId {{draftId}} and draftVersion {{draftVersion}}.",
  "Do not reinterpret, summarize, correct, or reclassify the decision.",
  "The application, not model prose, owns the final Telegram reply.",
].join(" ");

export const COMMITMENT_EDIT_INSTRUCTION_TEMPLATE = [
  "This is the continuation of one application-owned approved commitment-edit run, not a new owner conversation turn.",
  "The exact active commitment id is {{commitmentId}} and its approved expected version is {{expectedVersion}}.",
  "Request update_commitment exactly once using the application-bound complete edit.",
  "Do not reinterpret, summarize, correct, broaden, or target another commitment.",
  "The application rechecks Calendar when required and owns all final mutation and Telegram copy.",
].join(" ");

export const FALLBACK_INSTRUCTION_TEMPLATES: Readonly<
  Record<AgentPromptName, string>
> = {
  [AGENT_PROMPT_NAMES.commitmentEdit]: COMMITMENT_EDIT_INSTRUCTION_TEMPLATE,
  [AGENT_PROMPT_NAMES.decision]: DECISION_INSTRUCTION_TEMPLATE,
  [AGENT_PROMPT_NAMES.execution]: EXECUTION_INSTRUCTION_TEMPLATE,
};

/**
 * One resolved instruction template plus the Langfuse version it came from, so a
 * generation can be linked back to the exact prompt that produced it.
 */
export type ResolvedPrompt = Readonly<{
  promptName?: string;
  promptVersion?: number;
  template: string;
}>;

export type AgentPrompts = Readonly<
  Record<AgentPromptName, ResolvedPrompt>
>;

export const FALLBACK_AGENT_PROMPTS: AgentPrompts = {
  [AGENT_PROMPT_NAMES.commitmentEdit]: {
    template: COMMITMENT_EDIT_INSTRUCTION_TEMPLATE,
  },
  [AGENT_PROMPT_NAMES.decision]: {
    template: DECISION_INSTRUCTION_TEMPLATE,
  },
  [AGENT_PROMPT_NAMES.execution]: {
    template: EXECUTION_INSTRUCTION_TEMPLATE,
  },
};

/**
 * Substitutes `{{name}}` placeholders.
 *
 * An unknown placeholder is left intact rather than blanked: a silently empty
 * reference timestamp or draft id would send a plausible-looking but unusable
 * instruction to the model.
 */
export function renderPrompt(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  return template.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
    (match, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name)
        ? variables[name]!
        : match,
  );
}

/** Placeholder names each prompt must keep, asserted by the seeding script. */
export const REQUIRED_PROMPT_VARIABLES: Readonly<
  Record<AgentPromptName, readonly string[]>
> = {
  [AGENT_PROMPT_NAMES.commitmentEdit]: ["commitmentId", "expectedVersion"],
  [AGENT_PROMPT_NAMES.decision]: [
    "conversationContext",
    "decisionInput",
    "referenceTimestamp",
  ],
  [AGENT_PROMPT_NAMES.execution]: ["draftId", "draftVersion"],
};
