import {
  RunContext,
  type FunctionTool,
} from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import type { AgentSessionTurn } from "./session.js";
import {
  AGENT_RUNTIME_MAX_TURNS,
  AGENT_RUNTIME_TIMEOUT_MS,
  AGENT_RUNTIME_TOOL_NAMES,
  createAgentRuntime,
  type AgentExecutionAuthority,
  type AgentRunner,
  type AgentRunnerRequest,
  type AgentRunnerResult,
  type AgentRunnerResumeRequest,
} from "./runtime.js";
import type { DecisionInput } from "../decision/schema.js";

const now = new Date("2026-07-29T02:00:00.000Z");

const input: DecisionInput = {
  context: {
    fields: null,
    phase: "none",
  },
  ownerText: "I will publish the video by 5pm tomorrow",
};

const proposal = {
  commitmentMode: "simple_action",
  definitionOfDone: "Publish the video",
  durationMinutes: null,
  inputClass: "explicit_commitment",
  response: null,
  targetAt: "2026-07-30T17:00:00+08:00",
  timingConstraints: [],
  turnRelation: "new_request",
} as const;

const validatedDecision = {
  ...proposal,
  commitmentMode: "possible_work_session",
  missingFields: [],
  nextAction: "offer_work_window",
  offerWorkWindowHelp: false,
  response: "",
  targetTimeZone: "Asia/Singapore",
} as const;

const authority: AgentExecutionAuthority = {
  chatId: 42,
  draftId: "8d924a9e-26f5-4c47-a8b8-60afecfe1e12",
  draftVersion: 3,
  sessionId: "session-1",
  updateId: 41,
};

const emptyResult = (
  overrides: Partial<AgentRunnerResult> = {},
): AgentRunnerResult => ({
  interruptions: [],
  serializedState: "sdk-state",
  ...overrides,
});

function functionTool(
  request: AgentRunnerRequest | AgentRunnerResumeRequest,
  name: string,
): FunctionTool<unknown, never, unknown> {
  const selected = request.agent.tools.find(
    (candidate) =>
      candidate.type === "function" && candidate.name === name,
  );
  if (selected === undefined || selected.type !== "function") {
    throw new Error(`missing tool ${name}`);
  }
  return selected as FunctionTool<unknown, never, unknown>;
}

async function invoke(
  request: AgentRunnerRequest | AgentRunnerResumeRequest,
  name: string,
  value: unknown,
): Promise<unknown> {
  return functionTool(request, name).invoke(
    new RunContext(request.context),
    JSON.stringify(value),
  );
}

class ScriptedRunner implements AgentRunner {
  constructor(
    readonly onRun: (
      request: AgentRunnerRequest,
    ) => Promise<AgentRunnerResult>,
    readonly onResume: (
      request: AgentRunnerResumeRequest,
    ) => Promise<AgentRunnerResult> = async () => emptyResult(),
  ) {}

  resume(
    request: AgentRunnerResumeRequest,
  ): Promise<AgentRunnerResult> {
    return this.onResume(request);
  }

  run(request: AgentRunnerRequest): Promise<AgentRunnerResult> {
    return this.onRun(request);
  }
}

function runtimeWith(runner: AgentRunner, overrides: {
  executeCommitment?: Parameters<
    typeof createAgentRuntime
  >[0]["executeCommitment"];
  requestSanitizedAvailability?: Parameters<
    typeof createAgentRuntime
  >[0]["requestSanitizedAvailability"];
} = {}) {
  return createAgentRuntime({
    apiKey: "not-used-by-the-injected-runner",
    executeCommitment:
      overrides.executeCommitment ??
      (async () => ({ status: "executed" })),
    model: "gpt-test",
    now: () => now,
    requestSanitizedAvailability:
      overrides.requestSanitizedAvailability ?? (async () => []),
    runner,
  });
}

function turn(index: number): AgentSessionTurn {
  return {
    assistantText: `assistant-${index}`,
    ownerText: `owner-${index}`,
    recordedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    updateId: index,
  };
}

describe("bounded Agents SDK runtime", () => {
  it("exposes only four allowlisted tools and replays six turns plus the current raw text", async () => {
    const runner = new ScriptedRunner(async (request) => {
      expect(request.agent.tools.map((candidate) => candidate.name)).toEqual(
        AGENT_RUNTIME_TOOL_NAMES,
      );
      expect(request.agent.modelSettings.store).toBe(false);
      expect(request.maxTurns).toBe(AGENT_RUNTIME_MAX_TURNS);
      expect(request.safety).toEqual({
        modelStore: false,
        traceIncludeSensitiveData: false,
        tracingDisabled: true,
      });
      expect(request.signal.aborted).toBe(false);
      expect(AGENT_RUNTIME_TIMEOUT_MS).toBe(30_000);
      expect(request.input).toHaveLength(13);
      expect(request.input[0]).toMatchObject({
        content: "owner-2",
        role: "user",
      });
      expect(request.input.at(-1)).toMatchObject({
        content: input.ownerText,
        role: "user",
      });
      await invoke(request, "propose_draft_update", proposal);
      return emptyResult();
    });

    const result = await runtimeWith(runner).run({
      authority,
      input,
      recentTurns: Array.from({ length: 8 }, (_, index) => turn(index)),
    });

    expect(result.outcome).toMatchObject({
      decision: {
        commitmentMode: "possible_work_session",
        definitionOfDone: "Publish the video",
        nextAction: "offer_work_window",
      },
      ok: true,
    });
  });

  it.each([
    {
      ownerText: "Tomorrow 9am",
      targetAt: "2026-07-30T09:00:00+08:00",
    },
    {
      ownerText: "29 July at 11am",
      targetAt: "2026-07-29T11:00:00+08:00",
    },
  ])(
    "uses the single Singapore reference timestamp to resolve '$ownerText'",
    async ({ ownerText, targetAt }) => {
      const datedInput: DecisionInput = {
        context: {
          fields: {
            commitmentMode: "unresolved",
            definitionOfDone: "Publish the video",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            targetAt: null,
            targetTimeZone: null,
            timingConstraints: [],
          },
          phase: "awaiting_target",
        },
        ownerText,
      };
      const runner = new ScriptedRunner(async (request) => {
        expect(request.agent.instructions).toContain(
          "2026-07-29T10:00:00.000+08:00",
        );
        expect(request.agent.instructions).not.toContain(
          "2026-07-29T02:00:00.000Z",
        );
        expect(request.agent.instructions).toContain(
          "Tomorrow means the next Singapore calendar day.",
        );
        expect(request.agent.instructions).toContain(
          "use the reference timestamp's Singapore calendar year",
        );
        await invoke(request, "propose_draft_update", {
          ...proposal,
          targetAt,
          turnRelation: "clarification_continuation",
        });
        return emptyResult();
      });

      const result = await runtimeWith(runner).run({
        authority,
        input: datedInput,
        recentTurns: [],
      });

      expect(result.outcome).toMatchObject({
        decision: {
          definitionOfDone: "Publish the video",
          targetAt,
          targetTimeZone: "Asia/Singapore",
        },
        ok: true,
      });
    },
  );

  it("does not roll a same-day partial time that is already past", async () => {
    const datedInput: DecisionInput = {
      context: {
        fields: {
          commitmentMode: "unresolved",
          definitionOfDone: "Publish the video",
          durationMinutes: null,
          offerWorkWindowHelp: false,
          targetAt: null,
          targetTimeZone: null,
          timingConstraints: [],
        },
        phase: "awaiting_target",
      },
      ownerText: "29 July at 9am",
    };
    const runner = new ScriptedRunner(async (request) => {
      const result = await invoke(request, "propose_draft_update", {
        ...proposal,
        targetAt: "2026-07-29T09:00:00+08:00",
        turnRelation: "clarification_continuation",
      });
      expect(result).toEqual({
        accepted: false,
        reason: "target_not_future",
      });
      return emptyResult();
    });

    const result = await runtimeWith(runner).run({
      authority,
      input: datedInput,
      recentTurns: [],
    });

    expect(result.outcome).toMatchObject({
      failure: "semantic",
      ok: false,
      reason: "target_not_future",
    });
  });

  it("returns a useful ordinary response only through a validated proposal", async () => {
    const runner = new ScriptedRunner(async (request) => {
      await invoke(request, "propose_draft_update", {
        commitmentMode: "unresolved",
        definitionOfDone: null,
        durationMinutes: null,
        inputClass: "ordinary_question",
        response: "I can help turn a promise into a tracked commitment.",
        targetAt: null,
        timingConstraints: [],
        turnRelation: "none",
      });
      return emptyResult({ finalOutput: "untrusted model prose" });
    });

    const result = await runtimeWith(runner).run({
      authority: {
        chatId: 42,
        draftId: null,
        draftVersion: null,
        sessionId: null,
        updateId: 4,
      },
      input: {
        context: { fields: null, phase: "none" },
        ownerText: "How can you help me?",
      },
      recentTurns: [],
    });

    expect(result.outcome).toMatchObject({
      decision: {
        inputClass: "ordinary_question",
        response: "I can help turn a promise into a tracked commitment.",
      },
      ok: true,
    });
  });

  it("fails closed when a proposal is semantically invalid", async () => {
    const runner = new ScriptedRunner(async (request) => {
      const response = await invoke(request, "propose_draft_update", {
        ...proposal,
        targetAt: "2026-07-28T17:00:00+08:00",
      });
      expect(response).toMatchObject({ accepted: false });
      return emptyResult({ finalOutput: "save it anyway" });
    });

    const result = await runtimeWith(runner).run({
      authority,
      input,
      recentTurns: [],
    });

    expect(result.outcome).toMatchObject({
      failure: "semantic",
      ok: false,
      stage: "semantic",
    });
  });

  it.each([
    ["TimeoutError", "timeout", "request"],
    ["MaxTurnsExceeded", "incomplete", "completion"],
  ] as const)("maps %s to a closed failure", async (name, failure, stage) => {
    const runner = new ScriptedRunner(async () => {
      const error = new Error(name);
      error.name = name;
      throw error;
    });

    const result = await runtimeWith(runner).run({
      authority,
      input,
      recentTurns: [],
    });

    expect(result.outcome).toMatchObject({
      failure,
      ok: false,
      stage,
    });
  });

  it("never executes before approval, even if a runner invokes the tool directly", async () => {
    const executeCommitment = vi.fn(async () => ({
      status: "executed" as const,
    }));
    const runner = new ScriptedRunner(async (request) => {
      await invoke(request, "propose_draft_update", proposal);
      await expect(
        invoke(request, "execute_commitment", {
          draftId: authority.draftId,
          draftVersion: authority.draftVersion,
        }),
      ).rejects.toThrow("execution_authority_mismatch");
      return emptyResult();
    });

    await runtimeWith(runner, { executeCommitment }).run({
      authority,
      input,
      recentTurns: [],
    });

    expect(executeCommitment).not.toHaveBeenCalled();
  });

  it("resumes without a fresh owner input and executes once with the callback update id", async () => {
    const executeCommitment = vi.fn(async () => ({
      reply: { text: "Commitment confirmed." },
      status: "executed" as const,
    }));
    const runner = new ScriptedRunner(
      async (request) => {
        await invoke(request, "propose_draft_update", proposal);
        return emptyResult({
          interruptions: [
            {
              arguments: JSON.stringify({
                draftId: authority.draftId,
                draftVersion: authority.draftVersion,
              }),
              toolName: "execute_commitment",
            },
          ],
        });
      },
      async (request) => {
        expect(request.approval).toBe("approve");
        expect(request.serializedState).toBe("sdk-state");
        await invoke(request, "execute_commitment", {
          draftId: authority.draftId,
          draftVersion: authority.draftVersion,
        });
        return emptyResult();
      },
    );
    const runtime = runtimeWith(runner, { executeCommitment });
    const staged = await runtime.run({
      authority,
      input,
      recentTurns: [],
    });
    expect(staged.pendingApprovalState).toBeTypeOf("string");

    const result = await runtime.resume({
      approval: "approve",
      authority: { ...authority, updateId: 99 },
      pendingApprovalState: staged.pendingApprovalState!,
    });

    expect(executeCommitment).toHaveBeenCalledTimes(1);
    expect(executeCommitment).toHaveBeenCalledWith(
      {
        ...authority,
        updateId: 99,
      },
      validatedDecision,
    );
    expect(result).toMatchObject({
      execution: {
        reply: { text: "Commitment confirmed." },
        status: "executed",
      },
      outcome: { ok: true },
    });
  });

  it("prepares execution without a synthetic conversation turn or semantic reclassification", async () => {
    const executeCommitment = vi.fn(async () => ({
      reply: {
        text: "The existing deterministic confirmation reply.",
      },
      status: "executed" as const,
    }));
    const runner = new ScriptedRunner(
      async (request) => {
        expect(request.input).toEqual([
          {
            content:
              "Continue the application-owned approval workflow using only the bound execution tool.",
            role: "system",
          },
        ]);
        const serializedInput = JSON.stringify(request.input);
        expect(serializedInput).not.toContain(input.ownerText);
        expect(serializedInput).not.toContain(authority.draftId);
        expect(serializedInput).not.toContain(authority.sessionId);
        expect(serializedInput).not.toContain(
          validatedDecision.definitionOfDone,
        );
        expect(request.agent.tools.map((candidate) => candidate.name)).toEqual(
          ["execute_commitment"],
        );
        expect(request.agent.instructions).toContain(
          "not a new owner conversation turn",
        );
        return emptyResult({
          interruptions: [
            {
              arguments: JSON.stringify({
                draftId: authority.draftId,
                draftVersion: authority.draftVersion,
              }),
              toolName: "execute_commitment",
            },
          ],
        });
      },
      async (request) => {
        await invoke(request, "execute_commitment", {
          draftId: authority.draftId,
          draftVersion: authority.draftVersion,
        });
        return emptyResult();
      },
    );
    const runtime = runtimeWith(runner, { executeCommitment });

    const staged = await runtime.prepareExecution({
      authority: {
        ...authority,
        draftId: authority.draftId!,
        draftVersion: authority.draftVersion!,
        sessionId: authority.sessionId!,
        updateId: authority.updateId!,
      },
      decision: validatedDecision,
    });
    const result = await runtime.resume({
      approval: "approve",
      authority: { ...authority, updateId: 777 },
      pendingApprovalState: staged.pendingApprovalState!,
    });

    expect(staged.outcome).toEqual({
      decision: validatedDecision,
      ok: true,
    });
    expect(executeCommitment).toHaveBeenCalledTimes(1);
    expect(executeCommitment).toHaveBeenCalledWith(
      {
        ...authority,
        updateId: 777,
      },
      validatedDecision,
    );
    expect(result.execution).toEqual({
      reply: {
        text: "The existing deterministic confirmation reply.",
      },
      status: "executed",
    });
  });

  it("does not execute a rejected approval", async () => {
    const executeCommitment = vi.fn(async () => ({
      status: "executed" as const,
    }));
    const runner = new ScriptedRunner(
      async (request) => {
        await invoke(request, "propose_draft_update", proposal);
        return emptyResult({
          interruptions: [
            {
              arguments: JSON.stringify({
                draftId: authority.draftId,
                draftVersion: authority.draftVersion,
              }),
              toolName: "execute_commitment",
            },
          ],
        });
      },
      async (request) => {
        expect(request.approval).toBe("reject");
        return emptyResult();
      },
    );
    const runtime = runtimeWith(runner, { executeCommitment });
    const staged = await runtime.run({
      authority,
      input,
      recentTurns: [],
    });

    const result = await runtime.resume({
      approval: "reject",
      authority: { ...authority, updateId: 100 },
      pendingApprovalState: staged.pendingApprovalState!,
    });

    expect(executeCommitment).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ ok: true });
  });

  it("strips calendar titles and all non-free-busy fields", async () => {
    const leakedSlots = [
      {
        attendees: ["private@example.com"],
        endAt: "2026-07-30T10:00:00+08:00",
        eventId: "private-event",
        startAt: "2026-07-30T09:00:00+08:00",
        status: "busy" as const,
        title: "Private appointment",
      },
    ];
    const runner = new ScriptedRunner(async (request) => {
      const availability = await invoke(
        request,
        "request_sanitized_availability",
        {
          endAt: "2026-07-30T18:00:00+08:00",
          startAt: "2026-07-30T08:00:00+08:00",
          timeZone: "Asia/Singapore",
        },
      );
      expect(availability).toEqual([
        {
          endAt: "2026-07-30T10:00:00+08:00",
          startAt: "2026-07-30T09:00:00+08:00",
          status: "busy",
        },
      ]);
      expect(JSON.stringify(availability)).not.toContain("Private");
      await invoke(request, "propose_draft_update", proposal);
      return emptyResult();
    });

    await runtimeWith(runner, {
      requestSanitizedAvailability: async () => leakedSlots,
    }).run({
      authority,
      input,
      recentTurns: [],
    });
  });
});
