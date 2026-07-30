import { describe, expect, it, vi } from "vitest";
import {
  AGENT_PROMPT_NAMES,
  FALLBACK_INSTRUCTION_TEMPLATES,
  renderPrompt,
} from "../agent/instructions.js";
import { loadAgentPrompts, missingVariables } from "./prompt-store.js";

describe("renderPrompt", () => {
  it("substitutes known placeholders", () => {
    expect(
      renderPrompt("at {{referenceTimestamp}} for {{draftId}}", {
        draftId: '"abc"',
        referenceTimestamp: "2026-07-30T12:00:00+08:00",
      }),
    ).toBe('at 2026-07-30T12:00:00+08:00 for "abc"');
  });

  it("leaves an unknown placeholder intact rather than blanking it", () => {
    // A silently empty reference timestamp would produce a plausible but
    // unusable instruction, failing much later as a validation rejection.
    expect(renderPrompt("at {{missing}}", {})).toBe("at {{missing}}");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderPrompt("{{ draftId }}", { draftId: "x" })).toBe("x");
  });
});

describe("missingVariables", () => {
  it("accepts every shipped template", () => {
    for (const name of Object.values(AGENT_PROMPT_NAMES)) {
      expect(
        missingVariables(name, FALLBACK_INSTRUCTION_TEMPLATES[name]),
      ).toEqual([]);
    }
  });

  it("reports a placeholder an editor removed", () => {
    expect(
      missingVariables(
        AGENT_PROMPT_NAMES.decision,
        "You are Shiori. The input is {{decisionInput}}.",
      ),
    ).toEqual(["conversationContext", "referenceTimestamp"]);
  });
});

describe("loadAgentPrompts", () => {
  const remoteFor = (name: string): string =>
    `${FALLBACK_INSTRUCTION_TEMPLATES[name as never]} Edited in Langfuse.`;

  it("prefers the Langfuse version and records where it came from", async () => {
    const resolutions: unknown[] = [];
    const prompts = await loadAgentPrompts({
      fetch: async (name) => ({ prompt: remoteFor(name), version: 7 }),
      onResolution: (event) => resolutions.push(event),
    });

    expect(prompts[AGENT_PROMPT_NAMES.decision].promptVersion).toBe(7);
    expect(prompts[AGENT_PROMPT_NAMES.decision].promptName).toBe(
      AGENT_PROMPT_NAMES.decision,
    );
    expect(prompts[AGENT_PROMPT_NAMES.decision].template).toContain(
      "Edited in Langfuse.",
    );
    expect(resolutions).toHaveLength(3);
  });

  it("requests the production label by default", async () => {
    const fetch = vi.fn(async (name: string) => ({
      prompt: remoteFor(name),
      version: 1,
    }));
    await loadAgentPrompts({ fetch });

    for (const call of fetch.mock.calls) {
      expect((call[1] as { label: string }).label).toBe("production");
    }
  });

  it("falls back to the in-code template when Langfuse is unreachable", async () => {
    const resolutions: Array<{ reason?: string }> = [];
    const prompts = await loadAgentPrompts({
      fetch: async () => {
        throw new Error("langfuse unreachable");
      },
      onResolution: (event) => resolutions.push(event),
    });

    expect(prompts[AGENT_PROMPT_NAMES.decision].template).toBe(
      FALLBACK_INSTRUCTION_TEMPLATES[AGENT_PROMPT_NAMES.decision],
    );
    expect(prompts[AGENT_PROMPT_NAMES.decision].promptVersion).toBeUndefined();
    expect(resolutions.every((e) => e.reason === "fetch_failed")).toBe(true);
  });

  it("rejects a Langfuse version that dropped a required placeholder", async () => {
    const resolutions: Array<{ reason?: string }> = [];
    const prompts = await loadAgentPrompts({
      fetch: async () => ({ prompt: "You are Shiori.", version: 9 }),
      onResolution: (event) => resolutions.push(event),
    });

    // Publishing a template without the reference timestamp must not silently
    // ship an instruction missing the one fact the model needs.
    expect(prompts[AGENT_PROMPT_NAMES.decision].template).toBe(
      FALLBACK_INSTRUCTION_TEMPLATES[AGENT_PROMPT_NAMES.decision],
    );
    expect(
      resolutions.every((e) => e.reason === "missing_variables"),
    ).toBe(true);
  });

  it("treats the SDK's own fallback as a miss", async () => {
    const prompts = await loadAgentPrompts({
      fetch: async (name) => ({
        isFallback: true,
        prompt: FALLBACK_INSTRUCTION_TEMPLATES[name as never],
      }),
    });

    expect(
      prompts[AGENT_PROMPT_NAMES.execution].promptVersion,
    ).toBeUndefined();
  });

  it("keeps startup alive when the telemetry sink throws", async () => {
    await expect(
      loadAgentPrompts({
        fetch: async (name) => ({ prompt: remoteFor(name), version: 1 }),
        onResolution: () => {
          throw new Error("sink unavailable");
        },
      }),
    ).resolves.toBeTruthy();
  });
});
