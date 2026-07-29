import { describe, expect, it, vi } from "vitest";

import {
  createAgentApprovalGate,
} from "./approval.js";
import type {
  AgentRuntime,
  AgentRuntimeResult,
} from "./runtime.js";
import { createAgentSessionCipher } from "./session-crypto.js";
import type {
  AgentApprovalRepository,
  AgentApprovalResolveCommand,
  AgentApprovalResolveResult,
  AgentApprovalStageCommand,
  AgentApprovalStageResult,
  AgentPendingApprovalSnapshot,
  AgentSessionRepository,
} from "./session.js";
import type { DecisionResult } from "../decision/schema.js";

const decision: DecisionResult = {
  commitmentMode: "possible_work_session",
  definitionOfDone: "Publish the video",
  durationMinutes: null,
  inputClass: "explicit_commitment",
  missingFields: [],
  nextAction: "offer_work_window",
  offerWorkWindowHelp: false,
  response: "",
  targetAt: "2026-07-30T17:00:00+08:00",
  targetTimeZone: "Asia/Singapore",
  timingConstraints: [],
  turnRelation: "new_request",
};

const draft = {
  id: "8d924a9e-26f5-4c47-a8b8-60afecfe1e12",
  version: 3,
};

class MemorySessionRepository implements AgentSessionRepository {
  activeDraftId: string | null = draft.id;
  readonly clear = vi.fn<AgentSessionRepository["clear"]>(
    async () => ({ kind: "cleared" }),
  );

  async open(): Promise<never> {
    throw new Error("not used");
  }

  async read(chatId: number) {
    return {
      kind: "active" as const,
      session: {
        activeDraftId: this.activeDraftId,
        chatId,
        compactionCheckpoint: null,
        expiresAt: "2026-07-30T10:00:00.000Z",
        firstWorkingSequence: null,
        id: "session-1",
        interaction: {
          callbackChoice: null,
          pendingQuestion: null,
        },
        itemCount: 0,
        items: [],
        version: 4,
      },
    };
  }
}

class MemoryApprovalRepository implements AgentApprovalRepository {
  claimedSessionOverride: string | undefined;
  current: AgentPendingApprovalSnapshot | undefined;
  resolveMode:
    | "normal"
    | Exclude<AgentApprovalResolveResult["kind"], "claimed"> = "normal";
  stageMode:
    | "normal"
    | Exclude<AgentApprovalStageResult["kind"], "staged"> = "normal";
  readonly clearForSession = vi.fn<
    AgentApprovalRepository["clearForSession"]
  >(async () => {
    this.current = undefined;
  });
  readonly resolveCommands: AgentApprovalResolveCommand[] = [];
  readonly stageCommands: AgentApprovalStageCommand[] = [];

  async read(
    _chatId: number,
    _draftId: string,
    _draftVersion: number,
    _toolName: "execute_commitment",
  ) {
    return this.current === undefined
      ? { kind: "missing" as const }
      : { approval: this.current, kind: "current" as const };
  }

  async resolve(
    command: AgentApprovalResolveCommand,
  ): Promise<AgentApprovalResolveResult> {
    this.resolveCommands.push(command);
    if (this.resolveMode !== "normal") {
      return { kind: this.resolveMode };
    }
    if (command.decision === "reject") {
      this.current = undefined;
      return { kind: "rejected" };
    }
    if (this.current === undefined) {
      return { kind: "missing" };
    }
    const claimed = this.current;
    return {
      kind: "claimed",
      sealedRunState: claimed.sealedRunState,
      sessionId:
        this.claimedSessionOverride ?? claimed.sessionId,
    };
  }

  async stage(
    command: AgentApprovalStageCommand,
  ): Promise<AgentApprovalStageResult> {
    this.stageCommands.push(command);
    if (this.stageMode !== "normal") {
      return { kind: this.stageMode };
    }
    this.current = {
      chatId: command.chatId,
      draftId: command.draftId,
      draftVersion: command.draftVersion,
      expiresAt: "2026-07-30T10:00:00.000Z",
      id: "approval-1",
      sealedRunState: command.sealedRunState,
      sessionId: command.sessionId,
      toolName: command.toolName,
      version: 1,
    };
    return {
      approval: this.current,
      kind: "staged",
    };
  }
}

function runtimeResult(
  overrides: Partial<AgentRuntimeResult> = {},
): AgentRuntimeResult {
  return {
    outcome: { decision, ok: true },
    ...overrides,
  };
}

function runtime(): AgentRuntime & {
  prepareExecution: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
} {
  return {
    prepareExecution: vi.fn(async () =>
      runtimeResult({
        pendingApprovalState: "pending-sdk-state",
      }),
    ),
    resume: vi.fn(async () =>
      runtimeResult({
        execution: {
          reply: { text: "Commitment confirmed." },
          status: "executed",
        },
      }),
    ),
    run: vi.fn(async () => runtimeResult()),
  };
}

function fixture() {
  const sessions = new MemorySessionRepository();
  const approvals = new MemoryApprovalRepository();
  const agentRuntime = runtime();
  const cipher = createAgentSessionCipher(
    Buffer.alloc(32, 7).toString("base64"),
    () => Buffer.alloc(12, 9),
  );
  const telemetry = vi.fn();
  const gate = createAgentApprovalGate({
    approvals,
    cipher,
    runtime: agentRuntime,
    sessions,
    telemetry,
  });
  return {
    agentRuntime,
    approvals,
    gate,
    sessions,
    telemetry,
  };
}

describe("agent approval gate", () => {
  it("binds stage state without its update id and executes with the distinct callback update id", async () => {
    const { agentRuntime, approvals, gate } = fixture();

    await expect(
      gate.prepare({
        chatId: 42,
        decision,
        draft,
        updateId: 100,
      }),
    ).resolves.toEqual({ kind: "prepared" });
    await expect(
      gate.resolve({
        chatId: 42,
        decision: "approve",
        draft,
        updateId: 200,
      }),
    ).resolves.toEqual({
      kind: "approved",
      reply: { text: "Commitment confirmed." },
    });

    expect(approvals.stageCommands[0].updateId).toBe(100);
    expect(approvals.resolveCommands[0].updateId).toBe(200);
    expect(agentRuntime.prepareExecution).toHaveBeenCalledWith({
      authority: {
        chatId: 42,
        draftId: draft.id,
        draftVersion: draft.version,
        sessionId: "session-1",
        updateId: 100,
      },
      decision,
    });
    expect(agentRuntime.resume).toHaveBeenCalledWith({
      approval: "approve",
      authority: {
        chatId: 42,
        draftId: draft.id,
        draftVersion: draft.version,
        sessionId: "session-1",
        updateId: 200,
      },
      pendingApprovalState: "pending-sdk-state",
    });
  });

  it("stages a paused commitment edit without treating another focused draft as authority", async () => {
    const { agentRuntime, approvals, gate, sessions } = fixture();
    sessions.activeDraftId = "another-focused-draft";
    agentRuntime.resume.mockResolvedValueOnce(
      runtimeResult({
        execution: {
          reply: { text: "Promise updated." },
          status: "executed",
        },
      }),
    );

    await expect(
      gate.stagePaused({
        chatId: 42,
        draft: {
          id: "11111111-1111-4111-8111-111111111111",
          version: 7,
        },
        pendingApprovalState: "same-sdk-run",
        sessionId: "session-1",
        toolName: "update_commitment",
        updateId: 300,
      }),
    ).resolves.toEqual({ kind: "prepared" });
    expect(approvals.stageCommands[0]).toMatchObject({
      draftId: "11111111-1111-4111-8111-111111111111",
      draftVersion: 7,
      toolName: "update_commitment",
      updateId: 300,
    });

    await expect(
      gate.resolve({
        chatId: 42,
        decision: "approve",
        draft: {
          id: "11111111-1111-4111-8111-111111111111",
          version: 7,
        },
        toolName: "update_commitment",
        updateId: 301,
      }),
    ).resolves.toEqual({
      kind: "approved",
      reply: { text: "Promise updated." },
    });
    expect(agentRuntime.resume).toHaveBeenCalledWith({
      approval: "approve",
      authority: {
        chatId: 42,
        draftId: "11111111-1111-4111-8111-111111111111",
        draftVersion: 7,
        entityKind: "commitment",
        sessionId: "session-1",
        updateId: 301,
      },
      pendingApprovalState: "same-sdk-run",
    });
  });

  it("stages paused draft creation without launching a separate execution run", async () => {
    const { agentRuntime, approvals, gate } = fixture();

    await expect(
      gate.stagePaused({
        chatId: 42,
        draft,
        pendingApprovalState: "same-creation-run",
        sessionId: "session-1",
        toolName: "execute_commitment",
        updateId: 302,
      }),
    ).resolves.toEqual({ kind: "prepared" });

    expect(agentRuntime.prepareExecution).not.toHaveBeenCalled();
    expect(approvals.stageCommands).toEqual([
      expect.objectContaining({
        draftId: draft.id,
        draftVersion: draft.version,
        sealedRunState: expect.any(String),
        sessionId: "session-1",
        toolName: "execute_commitment",
        updateId: 302,
      }),
    ]);
  });

  it("reuses an exact staged binding without rerunning preparation", async () => {
    const { agentRuntime, approvals, gate } = fixture();
    const command = {
      chatId: 42,
      decision,
      draft,
      updateId: 100,
    } as const;

    await expect(gate.prepare(command)).resolves.toEqual({
      kind: "prepared",
    });
    await expect(
      gate.prepare({ ...command, updateId: 101 }),
    ).resolves.toEqual({ kind: "prepared" });

    expect(agentRuntime.prepareExecution).toHaveBeenCalledTimes(1);
    expect(approvals.stageCommands).toHaveLength(1);
  });

  it.each(["tamper", "binding"] as const)(
    "fails closed when sealed approval state has a %s mismatch",
    async (failure) => {
      const { agentRuntime, approvals, gate, telemetry } = fixture();
      await gate.prepare({
        chatId: 42,
        decision,
        draft,
        updateId: 100,
      });
      if (failure === "tamper") {
        approvals.current = {
          ...approvals.current!,
          sealedRunState: `${approvals.current!.sealedRunState.slice(0, -2)}xx`,
        };
      } else {
        approvals.current = {
          ...approvals.current!,
          sessionId: "different-session",
        };
      }

      await expect(
        gate.resolve({
          chatId: 42,
          decision: "approve",
          draft,
          updateId: 200,
        }),
      ).resolves.toEqual({ kind: "unavailable" });

      expect(agentRuntime.resume).not.toHaveBeenCalled();
      expect(telemetry).toHaveBeenCalledWith(
        "resolve_binding_invalid",
      );
    },
  );

  it("rejects atomically without resuming or approving execution", async () => {
    const { agentRuntime, gate } = fixture();
    await gate.prepare({
      chatId: 42,
      decision,
      draft,
      updateId: 100,
    });

    await expect(
      gate.resolve({
        chatId: 42,
        decision: "reject",
        draft,
        updateId: 201,
      }),
    ).resolves.toEqual({ kind: "rejected" });

    expect(agentRuntime.resume).not.toHaveBeenCalled();
  });

  it("projects repository replays without rerunning the agent", async () => {
    const first = fixture();
    first.approvals.stageMode = "replay";
    await expect(
      first.gate.prepare({
        chatId: 42,
        decision,
        draft,
        updateId: 100,
      }),
    ).resolves.toEqual({ kind: "replay" });

    const second = fixture();
    await second.gate.prepare({
      chatId: 42,
      decision,
      draft,
      updateId: 100,
    });
    second.approvals.resolveMode = "replay";
    await expect(
      second.gate.resolve({
        chatId: 42,
        decision: "approve",
        draft,
        updateId: 200,
      }),
    ).resolves.toEqual({ kind: "replay" });
    expect(second.agentRuntime.resume).not.toHaveBeenCalled();
  });

  it("retries the exact claimed binding with a fresh retap update id after a crash", async () => {
    const { agentRuntime, gate } = fixture();
    await gate.prepare({
      chatId: 42,
      decision,
      draft,
      updateId: 100,
    });
    vi.mocked(agentRuntime.resume)
      .mockRejectedValueOnce(new Error("process interrupted"))
      .mockResolvedValueOnce(
        runtimeResult({
          execution: { status: "replay" },
        }),
      );

    await expect(
      gate.resolve({
        chatId: 42,
        decision: "approve",
        draft,
        updateId: 200,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      gate.resolve({
        chatId: 42,
        decision: "approve",
        draft,
        updateId: 201,
      }),
    ).resolves.toEqual({
      kind: "approved",
      replayed: true,
    });

    expect(agentRuntime.resume).toHaveBeenCalledTimes(2);
    expect(agentRuntime.resume).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authority: expect.objectContaining({ updateId: 201 }),
      }),
    );
  });

  it("fails closed when the active session is not bound to the draft", async () => {
    const { agentRuntime, approvals, gate, sessions } = fixture();
    sessions.activeDraftId = "another-draft";

    await expect(
      gate.prepare({
        chatId: 42,
        decision,
        draft,
        updateId: 100,
      }),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(agentRuntime.prepareExecution).not.toHaveBeenCalled();
    expect(approvals.stageCommands).toHaveLength(0);
  });

  it.each([
    "confirmed",
    "cancelled",
    "expired",
  ] as const)("clears only paused approval state after %s", async (reason) => {
    const { approvals, gate, sessions } = fixture();

    await expect(
      gate.clearAfterTerminal({
        chatId: 42,
        reason,
        sessionId: "session-1",
        updateId: 300,
      }),
    ).resolves.toEqual({ kind: "cleared" });

    expect(sessions.clear).not.toHaveBeenCalled();
    expect(approvals.clearForSession).toHaveBeenCalledWith(
      "session-1",
      reason,
    );
  });
});
