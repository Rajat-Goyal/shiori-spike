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
  AgentSessionRecordCommand,
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
  expiresAt: "2026-07-30T10:00:00.000Z",
  id: "session-1",
  turns: [
    {
      assistantText: "When should it be done?",
      ownerText: "I need to submit the note",
      recordedAt: "2026-07-29T10:00:00.000Z",
      updateId: 10,
    },
  ],
  version: 2,
};

function fixture(active = true) {
  const records: AgentSessionRecordCommand[] = [];
  const continuityFailures = vi.fn();
  const repository: AgentSessionRepository = {
    clear: vi.fn(async () => ({ kind: "cleared" })),
    read: vi.fn(async () =>
      active
        ? { kind: "active", session: snapshot }
        : { kind: "none" }
    ),
    recordTurn: vi.fn(async (command) => {
      records.push(command);
      return {
        kind: "applied",
        session: {
          ...snapshot,
          activeDraftId: command.activeDraftId,
          turns: [
            ...snapshot.turns,
            {
              assistantText: command.assistantText,
              ownerText: command.ownerText,
              recordedAt: "2026-07-29T10:01:00.000Z",
              updateId: command.updateId,
            },
          ],
          version: snapshot.version + 1,
        },
      };
    }),
  };
  const runtime: AgentRuntime = {
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
  };
}

describe("SessionBackedAgentDecisionEngine", () => {
  it("replays the bounded active session and records only application reply copy", async () => {
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
      recentTurns: snapshot.turns,
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
        chatId: 42,
        expected: {
          id: snapshot.id,
          kind: "active",
          version: snapshot.version,
        },
        ownerText: "Tomorrow at 10",
        updateId: 11,
      },
    ]);
  });

  it("does not create permanent session state for a state-free ordinary answer", async () => {
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

    expect(test.repository.recordTurn).not.toHaveBeenCalled();
    expect(test.repository.clear).not.toHaveBeenCalled();
  });

  it("deletes the ephemeral session when permission is declined", async () => {
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

    expect(test.repository.clear).toHaveBeenCalledWith({
      chatId: 42,
      expectedSessionId: snapshot.id,
      reason: "cancelled",
      updateId: 13,
    });
    expect(test.repository.recordTurn).not.toHaveBeenCalled();
  });

  it("drops stale continuity without suppressing the applied turn", async () => {
    const test = fixture();
    vi.mocked(test.repository.recordTurn).mockResolvedValueOnce({
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
      operation: "record_turn",
      reason: "stale",
    });
  });

  it("returns the deterministic reply once when the post-apply session write fails", async () => {
    const test = fixture(false);
    vi.mocked(test.repository.recordTurn).mockRejectedValueOnce(
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
    expect(test.repository.recordTurn).toHaveBeenCalledTimes(1);
    expect(test.continuityFailures).toHaveBeenCalledWith({
      event: "agent_session_continuity_dropped",
      operation: "record_turn",
      reason: "repository_error",
    });
  });
});
