import {
  AGENT_PROMPT_NAMES,
  type AgentPromptName,
  type AgentPrompts,
  FALLBACK_AGENT_PROMPTS,
  FALLBACK_INSTRUCTION_TEMPLATES,
  REQUIRED_PROMPT_VARIABLES,
  type ResolvedPrompt,
} from "../agent/instructions.js";

export type PromptFetcher = (
  name: string,
  options: Readonly<{ fallback: string; label: string }>,
) => Promise<
  Readonly<{ prompt: string; version?: number; isFallback?: boolean }>
>;

export type PromptResolutionEvent = Readonly<{
  event: "agent_prompt_resolved" | "agent_prompt_fallback";
  name: AgentPromptName;
  reason?: "fetch_failed" | "missing_variables" | "server_fallback";
  version?: number;
}>;

export type PromptStoreOptions = Readonly<{
  fetch: PromptFetcher;
  label?: string;
  onResolution?: (event: PromptResolutionEvent) => void;
}>;

const PROMPT_NAMES: readonly AgentPromptName[] = Object.values(
  AGENT_PROMPT_NAMES,
);

/**
 * Rejects a Langfuse version that dropped a required `{{placeholder}}`.
 *
 * Prompts are editable in the UI, so a well-meaning edit can delete the
 * reference timestamp or the draft id. Rendering would then send the model a
 * plausible-looking instruction missing the one fact it needs, and the failure
 * would surface much later as a validation rejection. Falling back to the
 * in-code text is the safe answer.
 */
export function missingVariables(
  name: AgentPromptName,
  template: string,
): readonly string[] {
  return REQUIRED_PROMPT_VARIABLES[name].filter(
    (variable) => !template.includes(`{{${variable}}}`),
  );
}

/**
 * Resolves every agent prompt once, at boot.
 *
 * Langfuse is the source of truth; the in-code template is the fallback. Resolved
 * synchronously thereafter so a model run never waits on, or fails because of, a
 * network call to an observability service.
 */
export async function loadAgentPrompts(
  options: PromptStoreOptions,
): Promise<AgentPrompts> {
  const label = options.label ?? "production";
  const report = (event: PromptResolutionEvent): void => {
    try {
      options.onResolution?.(event);
    } catch {
      // Prompt telemetry must never break startup.
    }
  };

  const entries = await Promise.all(
    PROMPT_NAMES.map(async (name): Promise<[AgentPromptName, ResolvedPrompt]> => {
      const fallbackTemplate = FALLBACK_INSTRUCTION_TEMPLATES[name];
      let fetched: Awaited<ReturnType<PromptFetcher>>;
      try {
        fetched = await options.fetch(name, {
          fallback: fallbackTemplate,
          label,
        });
      } catch {
        report({
          event: "agent_prompt_fallback",
          name,
          reason: "fetch_failed",
        });
        return [name, FALLBACK_AGENT_PROMPTS[name]];
      }

      if (fetched.isFallback === true) {
        report({
          event: "agent_prompt_fallback",
          name,
          reason: "server_fallback",
        });
        return [name, FALLBACK_AGENT_PROMPTS[name]];
      }

      const absent = missingVariables(name, fetched.prompt);
      if (absent.length > 0) {
        report({
          event: "agent_prompt_fallback",
          name,
          reason: "missing_variables",
          ...(fetched.version === undefined
            ? {}
            : { version: fetched.version }),
        });
        return [name, FALLBACK_AGENT_PROMPTS[name]];
      }

      report({
        event: "agent_prompt_resolved",
        name,
        ...(fetched.version === undefined
          ? {}
          : { version: fetched.version }),
      });
      return [
        name,
        {
          promptName: name,
          template: fetched.prompt,
          ...(fetched.version === undefined
            ? {}
            : { promptVersion: fetched.version }),
        },
      ];
    }),
  );

  return Object.fromEntries(entries) as AgentPrompts;
}
