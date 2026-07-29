import {
  RunContext,
  Usage,
  type AgentOutputItem,
  type AgentInputItem,
  type FunctionTool,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import type { AgentSdkSession } from "./session.js";
import {
  AGENT_RUNTIME_MAX_TURNS,
  AGENT_RUNTIME_TIMEOUT_MS,
  AGENT_RUNTIME_TOOL_NAMES,
  createAgentRuntime,
  OpenAIAgentsRunner,
  type AgentExecutionAuthority,
  type AgentRunner,
  type AgentRunnerRequest,
  type AgentRunnerResult,
  type AgentRunnerResumeRequest,
} from "./runtime.js";
import type { DecisionInput } from "../decision/schema.js";
import type {
  AgentContextReader,
  AgentProductContext,
} from "./context-reader.js";

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
const proposalInput = {
  ...proposal,
  target: null,
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

const productContext: AgentProductContext = {
  ambiguity: null,
  commitments: [],
  drafts: [
    {
      definitionOfDone: validatedDecision.definitionOfDone,
      focused: true,
      id: authority.draftId!,
      mode: "possible_work_session",
      phase: "complete",
      targetAt: validatedDecision.targetAt,
      version: authority.draftVersion!,
    },
  ],
  focusedEntity: {
    entity: {
      definitionOfDone: validatedDecision.definitionOfDone,
      focused: true,
      id: authority.draftId!,
      mode: "possible_work_session",
      phase: "complete",
      targetAt: validatedDecision.targetAt,
      version: authority.draftVersion!,
    },
    kind: "draft",
  },
  recentOutcomes: [],
  truncated: {
    commitments: false,
    drafts: false,
    recentOutcomes: false,
    workSessions: false,
  },
  workSessions: [],
};

const runtimeConversation = {
  draftResolution: { kind: "none" as const },
  interaction: {
    callbackChoice: null,
    pendingQuestion: null,
  },
  olderHistoryAvailable: false,
  product: productContext,
} as const;

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

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("scripted model response exhausted");
    }
    return response;
  }

  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error("streaming is not used by these integration tests");
  }
}

function modelResponse(output: AgentOutputItem[]): ModelResponse {
  return {
    output,
    usage: new Usage(),
  };
}

function modelToolCall(
  name: "execute_commitment" | "update_commitment",
  argumentsValue: unknown,
  callId = `call-${name}`,
): ModelResponse {
  return modelResponse([{
    arguments: JSON.stringify(argumentsValue),
    callId,
    name,
    status: "completed",
    type: "function_call",
  }]);
}

function modelFinal(text = "Done."): ModelResponse {
  return modelResponse([{
    content: [{
      text,
      type: "output_text",
    }],
    role: "assistant",
    status: "completed",
    type: "message",
  }]);
}

function sdkRunner(model: Model): OpenAIAgentsRunner {
  const provider: ModelProvider = {
    getModel: () => model,
  };
  return new OpenAIAgentsRunner("not-used-by-the-fake-provider", provider);
}

function runtimeWith(runner: AgentRunner, overrides: {
  contextReader?: AgentContextReader;
  executeCommitment?: Parameters<
    typeof createAgentRuntime
  >[0]["executeCommitment"];
  requestSanitizedAvailability?: Parameters<
    typeof createAgentRuntime
  >[0]["requestSanitizedAvailability"];
  updateCommitment?: Parameters<
    typeof createAgentRuntime
  >[0]["updateCommitment"];
} = {}) {
  return createAgentRuntime({
    apiKey: "not-used-by-the-injected-runner",
    contextReader:
      overrides.contextReader ??
      {
        readHistory: vi.fn(async () => ({
          items: [],
          nextCursor: null,
        })),
        readProductContext: vi.fn(async () => productContext),
      },
    executeCommitment:
      overrides.executeCommitment ??
      (async () => ({ status: "executed" })),
    model: "gpt-test",
    now: () => now,
    requestSanitizedAvailability:
      overrides.requestSanitizedAvailability ?? (async () => []),
    runner,
    ...(overrides.updateCommitment
      ? { updateCommitment: overrides.updateCommitment }
      : {}),
  });
}

function sdkSession(
  items: readonly AgentInputItem[] = [],
): AgentSdkSession {
  return {
    addItems: vi.fn(async () => undefined),
    chatId: 42,
    clearSession: vi.fn(async () => undefined),
    currentSnapshot: () => ({
      activeDraftId: authority.draftId,
      chatId: 42,
      compactionCheckpoint: null,
      expiresAt: "2026-08-29T00:00:00.000Z",
      firstWorkingSequence: items.length > 0 ? 1 : null,
      id: authority.sessionId!,
      interaction: {
        callbackChoice: null,
        pendingQuestion: null,
      },
      itemCount: items.length,
      items: items.map((item, index) => ({
        item,
        recordedAt: "2026-07-29T00:00:00.000Z",
        sequence: index + 1,
      })),
      version: 1,
    }),
    getItems: vi.fn(async (limit?: number) =>
      items.slice(-(limit ?? items.length)) as AgentInputItem[]
    ),
    getSessionId: vi.fn(async () => authority.sessionId!),
    popItem: vi.fn(async () => undefined),
    readHistory: vi.fn(async () => ({
      items: [],
      nextCursor: null,
    })),
    recordApplicationReply: vi.fn(async () => ({ kind: "stale" })),
    recordCallbackChoice: vi.fn(async () => ({ kind: "stale" })),
    reset: vi.fn(async () => undefined),
    runCompaction: vi.fn(async () => null),
    sessionId: authority.sessionId!,
  };
}

describe("bounded Agents SDK runtime", () => {
  it("exposes only the typed allowlist and binds context/history reads to the durable session", async () => {
    const session = sdkSession(
      Array.from({ length: 16 }, (_, index) => ({
        content: `history-${index}`,
        role: "user" as const,
      })),
    );
    const contextReader: AgentContextReader = {
      readHistory: vi.fn(async () => ({
        items: [{ content: "older-item", role: "user" }],
        nextCursor: "next-opaque-cursor",
      })),
      readProductContext: vi.fn(async () => productContext),
    };
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
      expect(request.session).toBe(session);
      expect(request.input).toHaveLength(1);
      expect(request.input[0]).toMatchObject({
        content: input.ownerText,
        role: "user",
      });
      await expect(invoke(request, "read_context", {})).resolves.toEqual(
        runtimeConversation,
      );
      await expect(
        invoke(request, "read_history", {
          cursor: null,
          limit: 10,
        }),
      ).resolves.toEqual({
        items: [{ content: "older-item", role: "user" }],
        nextCursor: "next-opaque-cursor",
      });
      await expect(
        invoke(request, "list_commitments", { limit: 5 }),
      ).resolves.toEqual({
        commitments: [],
        truncated: false,
      });
      await invoke(request, "propose_draft_update", proposalInput);
      return emptyResult();
    });

    const result = await runtimeWith(runner, { contextReader }).run({
      authority,
      conversation: runtimeConversation,
      input,
      session,
    });
    expect(contextReader.readHistory).toHaveBeenCalledWith(
      session,
      undefined,
      10,
    );

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
          target: {
            expectedVersion: authority.draftVersion!,
            id: authority.draftId!,
            kind: "draft",
          },
          targetAt,
          turnRelation: "clarification_continuation",
        });
        return emptyResult();
      });

      const result = await runtimeWith(runner).run({
        authority,
        conversation: runtimeConversation,
        input: datedInput,
        session: sdkSession(),
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
        target: {
          expectedVersion: authority.draftVersion!,
          id: authority.draftId!,
          kind: "draft",
        },
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
      conversation: runtimeConversation,
      input: datedInput,
      session: sdkSession(),
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
        target: null,
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
      conversation: runtimeConversation,
      input: {
        context: { fields: null, phase: "none" },
        ownerText: "How can you help me?",
      },
      session: sdkSession(),
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
        target: null,
        targetAt: "2026-07-28T17:00:00+08:00",
      });
      expect(response).toMatchObject({ accepted: false });
      return emptyResult({ finalOutput: "save it anyway" });
    });

    const result = await runtimeWith(runner).run({
      authority,
      conversation: runtimeConversation,
      input,
      session: sdkSession(),
    });

    expect(result.outcome).toMatchObject({
      failure: "semantic",
      ok: false,
      stage: "semantic",
    });
  });

  it("fails closed when a draft mutation target version is stale or mismatched", async () => {
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
      ownerText: "Tomorrow at 5pm",
    };
    const runner = new ScriptedRunner(async (request) => {
      const response = await invoke(request, "propose_draft_update", {
        ...proposal,
        target: {
          expectedVersion: authority.draftVersion! - 1,
          id: authority.draftId!,
          kind: "draft",
        },
        targetAt: "2026-07-30T17:00:00+08:00",
        turnRelation: "clarification_continuation",
      });
      expect(response).toEqual({
        accepted: false,
        reason: "input_invalid",
      });
      return emptyResult();
    });

    const result = await runtimeWith(runner).run({
      authority,
      conversation: runtimeConversation,
      input: datedInput,
      session: sdkSession(),
    });

    expect(result.outcome).toMatchObject({
      failure: "semantic",
      ok: false,
      reason: "input_invalid",
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
      conversation: runtimeConversation,
      input,
      session: sdkSession(),
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
      await invoke(request, "propose_draft_update", proposalInput);
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
      conversation: runtimeConversation,
      input,
      session: sdkSession(),
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
        await invoke(request, "propose_draft_update", proposalInput);
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
      conversation: runtimeConversation,
      input,
      session: sdkSession(),
    });
    expect(staged.pendingApprovalState).toBeTypeOf("string");
    expect(staged.approval).toEqual({
      proposal: validatedDecision,
      target: {
        id: authority.draftId,
        version: authority.draftVersion,
      },
      toolName: "execute_commitment",
    });

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

  it("continues creation in the active session without semantic reclassification", async () => {
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
              "Continue the active application-owned conversation using only the exact bound creation tool.",
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
          "continuation of one application-owned commitment-creation approval",
        );
        expect(request.session).toBe(session);
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
    const session = sdkSession();

    const staged = await runtime.continueCreation({
      authority: {
        ...authority,
        draftId: authority.draftId!,
        draftVersion: authority.draftVersion!,
        sessionId: authority.sessionId!,
        updateId: authority.updateId!,
      },
      conversation: runtimeConversation,
      decision: validatedDecision,
      session,
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
        await invoke(request, "propose_draft_update", proposalInput);
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
      conversation: runtimeConversation,
      input,
      session: sdkSession(),
    });

    const result = await runtime.resume({
      approval: "reject",
      authority: { ...authority, updateId: 100 },
      pendingApprovalState: staged.pendingApprovalState!,
    });

    expect(executeCommitment).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ ok: true });
  });

  it("pauses and resumes one exact active commitment edit in the same serialized run", async () => {
    const commitmentAuthority = {
      chatId: 42,
      draftId: "11111111-1111-4111-8111-111111111111",
      draftVersion: 4,
      entityKind: "commitment" as const,
      sessionId: "session-1",
      updateId: 501,
    };
    const edit = {
      calendarPolicy: {
        conflict: "reject" as const,
        unavailable: "reject" as const,
      },
      commitmentId: commitmentAuthority.draftId,
      definitionOfDone: "Publish the final video",
      expectedVersion: commitmentAuthority.draftVersion,
      preparation: {
        nextWorkSession: {
          durationMinutes: 60 as const,
          endAt: "2026-07-30T04:00:00.000Z",
          startAt: "2026-07-30T03:00:00.000Z",
          timingConstraints: "before lunch",
        },
        required: true,
      },
      targetAt: "2026-07-30T09:00:00.000Z",
    };
    const updateCommitment = vi.fn(async () => ({
      reply: { text: "Promise updated." },
      status: "executed" as const,
    }));
    const runner = new ScriptedRunner(
      async () =>
        emptyResult({
          interruptions: [{
            arguments: JSON.stringify(edit),
            toolName: "update_commitment",
          }],
        }),
      async (request) => {
        expect(request.serializedState).toBe("sdk-state");
        await invoke(request, "update_commitment", edit);
        return emptyResult();
      },
    );
    const runtime = runtimeWith(runner, { updateCommitment });
    const staged = await runtime.run({
      authority: commitmentAuthority,
      conversation: {
        ...runtimeConversation,
        product: {
          ...productContext,
          commitments: [{
            definitionOfDone: "Publish the video",
            id: commitmentAuthority.draftId,
            status: "active",
            targetAt: "2026-07-30T08:00:00.000Z",
            version: commitmentAuthority.draftVersion,
          }],
        },
      },
      input: {
        context: { fields: null, phase: "none" },
        ownerText: "Move the video promise and add preparation",
      },
      session: sdkSession(),
    });

    expect(staged.approval).toEqual({
      proposal: edit,
      target: {
        id: commitmentAuthority.draftId,
        version: commitmentAuthority.draftVersion,
      },
      toolName: "update_commitment",
    });
    expect(updateCommitment).not.toHaveBeenCalled();

    const applied = await runtime.resume({
      approval: "approve",
      authority: {
        ...commitmentAuthority,
        updateId: 502,
      },
      pendingApprovalState: staged.pendingApprovalState!,
    });

    expect(updateCommitment).toHaveBeenCalledOnce();
    expect(updateCommitment).toHaveBeenCalledWith(
      { ...commitmentAuthority, updateId: 502 },
      edit,
    );
    expect(applied.execution?.reply).toEqual({
      text: "Promise updated.",
    });

    await expect(
      runtime.resume({
        approval: "approve",
        authority: {
          ...commitmentAuthority,
          draftVersion: 5,
          updateId: 503,
        },
        pendingApprovalState: staged.pendingApprovalState!,
      }),
    ).resolves.toMatchObject({
      outcome: {
        ok: false,
        reason: "input_invalid",
      },
    });
    expect(updateCommitment).toHaveBeenCalledOnce();
  });

  describe("real Agents SDK serialized approval rehydration", () => {
    it.each(["approve", "reject"] as const)(
      "%ss an exact creation interruption without invoking a tool directly",
      async (approval) => {
        const executeCommitment = vi.fn(async () => ({
          reply: { text: "Commitment confirmed." },
          status: "executed" as const,
        }));
        const model = new ScriptedModel([
          modelToolCall("execute_commitment", {
            draftId: authority.draftId,
            draftVersion: authority.draftVersion,
          }),
          modelFinal(),
        ]);
        const runtime = runtimeWith(sdkRunner(model), {
          executeCommitment,
        });
        const staged = await runtime.continueCreation({
          authority: {
            ...authority,
            draftId: authority.draftId!,
            draftVersion: authority.draftVersion!,
            sessionId: authority.sessionId!,
            updateId: authority.updateId!,
          },
          conversation: runtimeConversation,
          decision: validatedDecision,
          session: sdkSession(),
        });

        expect(staged).toMatchObject({
          approval: {
            target: {
              id: authority.draftId,
              version: authority.draftVersion,
            },
            toolName: "execute_commitment",
          },
          outcome: { ok: true },
          pendingApprovalState: expect.any(String),
        });
        expect(executeCommitment).not.toHaveBeenCalled();

        const resumed = await runtime.resume({
          approval,
          authority: { ...authority, updateId: 901 },
          pendingApprovalState: staged.pendingApprovalState!,
        });

        expect(resumed.outcome).toMatchObject({ ok: true });
        expect(executeCommitment).toHaveBeenCalledTimes(
          approval === "approve" ? 1 : 0,
        );
        expect(model.requests).toHaveLength(2);
      },
    );

    it.each(["approve", "reject"] as const)(
      "%ss an exact edit interruption without invoking a tool directly",
      async (approval) => {
        const commitmentAuthority = {
          chatId: 42,
          draftId: "11111111-1111-4111-8111-111111111111",
          draftVersion: 4,
          entityKind: "commitment" as const,
          sessionId: "session-1",
          updateId: 501,
        };
        const edit = {
          calendarPolicy: {
            conflict: "reject" as const,
            unavailable: "reject" as const,
          },
          commitmentId: commitmentAuthority.draftId,
          definitionOfDone: "Publish the final video",
          expectedVersion: commitmentAuthority.draftVersion,
          preparation: {
            nextWorkSession: {
              durationMinutes: 60 as const,
              endAt: "2026-07-30T04:00:00.000Z",
              startAt: "2026-07-30T03:00:00.000Z",
              timingConstraints: "before lunch",
            },
            required: true,
          },
          targetAt: "2026-07-30T09:00:00.000Z",
        };
        const updateCommitment = vi.fn(async () => ({
          reply: { text: "Promise updated." },
          status: "executed" as const,
        }));
        const model = new ScriptedModel([
          modelToolCall("update_commitment", edit),
          modelFinal(),
        ]);
        const runtime = runtimeWith(sdkRunner(model), {
          updateCommitment,
        });
        const staged = await runtime.run({
          authority: commitmentAuthority,
          conversation: {
            ...runtimeConversation,
            product: {
              ...productContext,
              commitments: [{
                definitionOfDone: "Publish the video",
                id: commitmentAuthority.draftId,
                status: "active",
                targetAt: "2026-07-30T08:00:00.000Z",
                version: commitmentAuthority.draftVersion,
              }],
            },
          },
          input: {
            context: { fields: null, phase: "none" },
            ownerText: "Move the video promise and add preparation",
          },
          session: sdkSession(),
        });

        expect(staged).toMatchObject({
          approval: {
            proposal: edit,
            toolName: "update_commitment",
          },
          outcome: { ok: true },
          pendingApprovalState: expect.any(String),
        });
        expect(updateCommitment).not.toHaveBeenCalled();

        const resumed = await runtime.resume({
          approval,
          authority: { ...commitmentAuthority, updateId: 902 },
          pendingApprovalState: staged.pendingApprovalState!,
        });

        expect(resumed.outcome).toMatchObject({ ok: true });
        expect(updateCommitment).toHaveBeenCalledTimes(
          approval === "approve" ? 1 : 0,
        );
        expect(model.requests).toHaveLength(2);
      },
    );

    it.each(["absent", "mismatched"] as const)(
      "fails closed when the serialized creation tool is %s on rehydration",
      async (failure) => {
        const executeCommitment = vi.fn(async () => ({
          status: "executed" as const,
        }));
        const updateCommitment = vi.fn(async () => ({
          status: "executed" as const,
        }));
        const model = new ScriptedModel([
          modelToolCall("execute_commitment", {
            draftId: authority.draftId,
            draftVersion: authority.draftVersion,
          }),
          modelFinal(),
        ]);
        const runtime = runtimeWith(sdkRunner(model), {
          executeCommitment,
          updateCommitment,
        });
        const staged = await runtime.continueCreation({
          authority: {
            ...authority,
            draftId: authority.draftId!,
            draftVersion: authority.draftVersion!,
            sessionId: authority.sessionId!,
            updateId: authority.updateId!,
          },
          conversation: runtimeConversation,
          decision: validatedDecision,
          session: sdkSession(),
        });
        const envelope = JSON.parse(staged.pendingApprovalState!) as {
          authority: Record<string, unknown>;
          editProposal: unknown;
          proposal: unknown;
          sdkRunState: string;
          toolName: string;
        };
        let resumeAuthority: AgentExecutionAuthority = {
          ...authority,
          updateId: 903,
        };
        if (failure === "absent") {
          envelope.sdkRunState = envelope.sdkRunState.replaceAll(
            "execute_commitment",
            "absent_commitment_tool",
          );
        } else {
          const edit = {
            calendarPolicy: {
              conflict: "reject",
              unavailable: "reject",
            },
            commitmentId: authority.draftId!,
            definitionOfDone: "Publish the final video",
            expectedVersion: authority.draftVersion!,
            preparation: {
              nextWorkSession: null,
              required: false,
            },
            targetAt: "2026-07-30T09:00:00.000Z",
          };
          envelope.authority.entityKind = "commitment";
          envelope.editProposal = edit;
          envelope.proposal = null;
          envelope.toolName = "update_commitment";
          resumeAuthority = {
            ...resumeAuthority,
            entityKind: "commitment",
          };
        }

        const resumed = await runtime.resume({
          approval: "approve",
          authority: resumeAuthority,
          pendingApprovalState: JSON.stringify(envelope),
        });

        expect(resumed.outcome).toMatchObject({ ok: false });
        expect(executeCommitment).not.toHaveBeenCalled();
        expect(updateCommitment).not.toHaveBeenCalled();
      },
    );
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
      await invoke(request, "propose_draft_update", proposalInput);
      return emptyResult();
    });

    await runtimeWith(runner, {
      requestSanitizedAvailability: async () => leakedSlots,
    }).run({
      authority,
      conversation: runtimeConversation,
      input,
      session: sdkSession(),
    });
  });
});
