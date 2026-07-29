import { describe, expect, it, vi } from "vitest";
import type {
  ConversationApplyResult,
  ConversationCommand,
  ConversationReadResult,
  ConversationRepository,
} from "../conversation/repository.js";
import {
  collectedDraftCopy,
  conversationCopy,
} from "../conversation/copy.js";
import { ConversationService } from "../conversation/service.js";
import type { DecisionResult } from "../decision/schema.js";
import type { AgentRuntime } from "./runtime.js";
import type {
  AgentSessionApplicationReplyCommand,
  AgentSdkSession,
  AgentSessionRepository,
  AgentSessionSnapshot,
} from "./session.js";
import { SessionBackedAgentDecisionEngine } from "./conversation.js";

const decision: DecisionResult = {
  commitmentMode: "unresolved",
  definitionOfDone: "Submit the note",
  durationMinutes: null,
  inputClass: "explicit_commitment",
  missingFields: ["target"],
  nextAction: "ask_target",
  offerWorkWindowHelp: false,
  response: "",
  targetAt: null,
  targetTimeZone: null,
  timingConstraints: [],
  turnRelation: "new_request",
};

const snapshot: AgentSessionSnapshot = {
  activeDraftId: "11111111-1111-4111-8111-111111111111",
  chatId: 42,
  compactionCheckpoint: null,
  expiresAt: "2026-07-30T10:00:00.000Z",
  firstWorkingSequence: 1,
  id: "session-1",
  interaction: {
    callbackChoice: null,
    pendingQuestion: {
      text: "When should it be done?",
      updateId: 10,
    },
  },
  itemCount: 2,
  items: [
    {
      item: {
        content: "I need to submit the note",
        role: "user",
      },
      recordedAt: "2026-07-29T10:00:00.000Z",
      sequence: 1,
    },
    {
      item: {
        content: [{
          text: "When should it be done?",
          type: "output_text",
        }],
        role: "assistant",
        status: "completed",
      },
      recordedAt: "2026-07-29T10:00:01.000Z",
      sequence: 2,
    },
  ],
  version: 2,
};

function fixture(active = true) {
  const records: Array<
    Omit<AgentSessionApplicationReplyCommand, "chatId" | "sessionId">
  > = [];
  const continuityFailures = vi.fn();
  const mutableSnapshot = active
    ? snapshot
    : {
        ...snapshot,
        activeDraftId: null,
        firstWorkingSequence: null,
        itemCount: 0,
        items: [],
        version: 0,
      };
  const session: AgentSdkSession = {
    addItems: vi.fn(async () => undefined),
    chatId: 42,
    clearSession: vi.fn(async () => undefined),
    currentSnapshot: () => mutableSnapshot,
    getItems: vi.fn(async () => []),
    getSessionId: vi.fn(async () => snapshot.id),
    popItem: vi.fn(async () => undefined),
    readHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    recordApplicationReply: vi.fn(async (command) => {
      records.push(command);
      return { kind: "applied", session: snapshot };
    }),
    recordCallbackChoice: vi.fn(async () => ({
      kind: "applied",
      session: snapshot,
    })),
    reset: vi.fn(async () => undefined),
    runCompaction: vi.fn(async () => null),
    sessionId: snapshot.id,
  };
  const repository: AgentSessionRepository = {
    clear: vi.fn(async () => ({ kind: "cleared" })),
    open: vi.fn(async () => session),
    read: vi.fn(async () =>
      active
        ? { kind: "active", session: snapshot }
        : { kind: "none" }
    ),
  };
  const runtime: AgentRuntime = {
    prepareExecution: vi.fn(),
    resume: vi.fn(),
    run: vi.fn(async () => ({ outcome: { decision, ok: true } })),
  };
  return {
    engine: new SessionBackedAgentDecisionEngine({
      chatId: 42,
      onContinuityFailure: continuityFailures,
      repository,
      runtime,
    }),
    continuityFailures,
    records,
    repository,
    runtime,
    session,
  };
}

describe("SessionBackedAgentDecisionEngine", () => {
  it("passes the durable SDK session and records only application reply copy", async () => {
    const test = fixture();
    const input = {
      context: {
        fields: {
          commitmentMode: "unresolved" as const,
          definitionOfDone: "Submit the note",
          durationMinutes: null,
          offerWorkWindowHelp: false,
          targetAt: null,
          targetTimeZone: null,
          timingConstraints: [],
        },
        phase: "awaiting_target" as const,
      },
      ownerText: "Tomorrow at 10",
    };

    await expect(
      test.engine.decide(input, { updateId: 11 }),
    ).resolves.toEqual({ decision, ok: true });
    expect(test.runtime.run).toHaveBeenCalledWith({
      authority: {
        chatId: 42,
        draftId: snapshot.activeDraftId,
        draftVersion: null,
        sessionId: snapshot.id,
        updateId: 11,
      },
      input,
      session: test.session,
    });

    await test.engine.completeTurn({
      activeDraftId: snapshot.activeDraftId,
      assistantText: "Do you need preparation time?",
      status: "active",
      updateId: 11,
    });
    expect(test.records).toEqual([
      {
        activeDraftId: snapshot.activeDraftId,
        assistantText: "Do you need preparation time?",
        pendingQuestion: true,
        updateId: 11,
      },
    ]);
  });

  it("records an ordinary application answer in the same session", async () => {
    const test = fixture(false);
    await test.engine.decide(
      {
        context: { fields: null, phase: "none" },
        ownerText: "What time zone is Singapore?",
      },
      { updateId: 12 },
    );
    await test.engine.completeTurn({
      activeDraftId: null,
      assistantText: "Singapore uses UTC+08:00.",
      status: "ignored",
      updateId: 12,
    });

    expect(test.session.recordApplicationReply).toHaveBeenCalledWith({
      activeDraftId: null,
      assistantText: "Singapore uses UTC+08:00.",
      pendingQuestion: false,
      updateId: 12,
    });
    expect(test.repository.clear).not.toHaveBeenCalled();
  });

  it("retains durable history when a draft conversation closes", async () => {
    const test = fixture();
    await test.engine.decide(
      {
        context: { fields: null, phase: "none" },
        ownerText: "No",
      },
      { updateId: 13 },
    );
    await test.engine.completeTurn({
      activeDraftId: null,
      assistantText: "Okay. Nothing was saved.",
      status: "closed",
      updateId: 13,
    });

    expect(test.session.recordApplicationReply).toHaveBeenCalledWith({
      activeDraftId: null,
      assistantText: "Okay. Nothing was saved.",
      pendingQuestion: false,
      updateId: 13,
    });
    expect(test.repository.clear).not.toHaveBeenCalled();
  });

  it("drops stale continuity without suppressing the applied turn", async () => {
    const test = fixture();
    vi.mocked(test.session.recordApplicationReply).mockResolvedValueOnce({
      kind: "stale",
    });
    await test.engine.decide(
      {
        context: { fields: null, phase: "none" },
        ownerText: "Start a promise",
      },
      { updateId: 14 },
    );

    await expect(
      test.engine.completeTurn({
        activeDraftId: snapshot.activeDraftId,
        assistantText: "When should it be done?",
        status: "active",
        updateId: 14,
      }),
    ).resolves.toBeUndefined();
    expect(test.continuityFailures).toHaveBeenCalledWith({
      event: "agent_session_continuity_dropped",
      operation: "record_reply",
      reason: "stale",
    });
  });

  it("returns the deterministic reply once when the post-apply session write fails", async () => {
    const test = fixture(false);
    vi.mocked(test.session.recordApplicationReply).mockRejectedValueOnce(
      new Error("private repository details"),
    );
    let applied = false;
    const conversationRepository: ConversationRepository = {
      applyTurn: vi.fn(
        async (
          _command: ConversationCommand,
        ): Promise<ConversationApplyResult> => {
          applied = true;
          return {
            completed: true,
            draftCreated: true,
            draftReference: {
              id: snapshot.activeDraftId!,
              version: 1,
            },
            status: "applied",
          };
        },
      ),
      readTurn: vi.fn(
        async (): Promise<ConversationReadResult> =>
          applied ? { kind: "interrupted" } : { kind: "none" },
      ),
    };
    const service = new ConversationService({
      decisionEngine: test.engine,
      modelId: "gpt-test-model",
      promptVersion: "shiori-test-v1",
      repository: conversationRepository,
    });

    await expect(
      service.handle(15, "I need to submit the note"),
    ).resolves.toBe(collectedDraftCopy("awaiting_target"));
    await expect(
      service.handle(15, "I need to submit the note"),
    ).resolves.toBe(conversationCopy.interrupted);

    expect(conversationRepository.applyTurn).toHaveBeenCalledTimes(1);
    expect(test.session.recordApplicationReply).toHaveBeenCalledTimes(1);
    expect(test.continuityFailures).toHaveBeenCalledWith({
      event: "agent_session_continuity_dropped",
      operation: "record_reply",
      reason: "repository_error",
    });
  });
});
