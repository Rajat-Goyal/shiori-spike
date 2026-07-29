import { describe, expect, it, vi } from "vitest";

import type { DecisionResult } from "../decision/schema.js";
import type {
  AgentContextReader,
  AgentProductContext,
} from "./context-reader.js";
import { createCreationApprovalPreparer } from "./creation-approval.js";
import type { AgentRuntimeResult } from "./runtime.js";
import type {
  AgentSdkSession,
  AgentSessionRepository,
} from "./session.js";

const draft = {
  id: "8d924a9e-26f5-4c47-a8b8-60afecfe1e12",
  version: 3,
};

const decision: DecisionResult = {
  commitmentMode: "simple_action",
  definitionOfDone: "Publish the video",
  durationMinutes: null,
  inputClass: "explicit_commitment",
  missingFields: [],
  nextAction: "ready",
  offerWorkWindowHelp: false,
  response: "",
  targetAt: "2026-07-30T17:00:00+08:00",
  targetTimeZone: "Asia/Singapore",
  timingConstraints: [],
  turnRelation: "new_request",
};

const product: AgentProductContext = {
  ambiguity: null,
  commitments: [],
  drafts: [{
    definitionOfDone: decision.definitionOfDone!,
    focused: true,
    id: draft.id,
    mode: "simple_action",
    phase: "complete",
    targetAt: decision.targetAt,
    version: draft.version,
  }],
  focusedEntity: null,
  recentOutcomes: [],
  truncated: {
    commitments: false,
    drafts: false,
    recentOutcomes: false,
    workSessions: false,
  },
  workSessions: [],
};

function session(activeDraftId: string | null = draft.id): AgentSdkSession {
  return {
    addItems: vi.fn(async () => undefined),
    chatId: 42,
    clearSession: vi.fn(async () => undefined),
    currentSnapshot: () => ({
      activeDraftId,
      chatId: 42,
      compactionCheckpoint: null,
      expiresAt: "2026-08-30T00:00:00.000Z",
      firstWorkingSequence: 1,
      id: "session-1",
      interaction: {
        callbackChoice: { action: "option_1", updateId: 98 },
        pendingQuestion: null,
      },
      itemCount: 2,
      items: [{
        item: { content: "sanitized history", role: "user" },
        recordedAt: "2026-07-30T00:00:00.000Z",
        sequence: 2,
      }],
      version: 4,
    }),
    getItems: vi.fn(async () => []),
    getSessionId: vi.fn(async () => "session-1"),
    popItem: vi.fn(async () => undefined),
    readHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    recordApplicationReply: vi.fn(async () => ({ kind: "stale" })),
    recordCallbackChoice: vi.fn(async () => ({ kind: "stale" })),
    reset: vi.fn(async () => undefined),
    runCompaction: vi.fn(async () => null),
    sessionId: "session-1",
  };
}

function successfulRuntimeResult(
  overrides: Partial<AgentRuntimeResult> = {},
): AgentRuntimeResult {
  return {
    approval: {
      proposal: decision,
      target: draft,
      toolName: "execute_commitment",
    },
    outcome: { decision, ok: true },
    pendingApprovalState: "same-active-sdk-run",
    ...overrides,
  };
}

function fixture(activeDraftId: string | null = draft.id) {
  const sdkSession = session(activeDraftId);
  const sessions: AgentSessionRepository = {
    clear: vi.fn(async () => ({ kind: "none" })),
    open: vi.fn(async () => sdkSession),
    read: vi.fn(async () => ({ kind: "none" })),
  };
  const contextReader: AgentContextReader = {
    readHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    readProductContext: vi.fn(async () => product),
  };
  const runtime = {
    continueCreation: vi.fn(async () => successfulRuntimeResult()),
  };
  const gate = {
    stagePaused: vi.fn(async () => ({ kind: "prepared" as const })),
  };
  const prepare = createCreationApprovalPreparer({
    contextReader,
    gate,
    runtime,
    sessions,
  });
  return {
    contextReader,
    gate,
    prepare,
    runtime,
    sdkSession,
    sessions,
  };
}

describe("creation approval continuation", () => {
  it("stages only the exact execute interruption produced by the active durable run", async () => {
    const test = fixture();

    await expect(test.prepare({
      chatId: 42,
      decision,
      draft,
      updateId: 100,
    })).resolves.toBe(true);

    expect(test.contextReader.readProductContext).toHaveBeenCalledWith({
      chatId: 42,
      focusedEntityId: draft.id,
      query: null,
    });
    expect(test.runtime.continueCreation).toHaveBeenCalledWith({
      authority: {
        chatId: 42,
        draftId: draft.id,
        draftVersion: draft.version,
        sessionId: "session-1",
        updateId: 100,
      },
      conversation: {
        draftResolution: {
          authority: {
            expectedVersion: draft.version,
            id: draft.id,
            kind: "draft",
          },
          kind: "exact",
        },
        interaction: {
          callbackChoice: { action: "option_1", updateId: 98 },
          pendingQuestion: null,
        },
        olderHistoryAvailable: true,
        product,
      },
      decision,
      session: test.sdkSession,
    });
    expect(test.gate.stagePaused).toHaveBeenCalledWith({
      chatId: 42,
      draft,
      pendingApprovalState: "same-active-sdk-run",
      sessionId: "session-1",
      toolName: "execute_commitment",
      updateId: 100,
    });
  });

  it("fails closed before continuation when the active draft is different", async () => {
    const test = fixture("another-draft");

    await expect(test.prepare({
      chatId: 42,
      decision,
      draft,
      updateId: 101,
    })).resolves.toBe(false);

    expect(test.contextReader.readProductContext).not.toHaveBeenCalled();
    expect(test.runtime.continueCreation).not.toHaveBeenCalled();
    expect(test.gate.stagePaused).not.toHaveBeenCalled();
  });

  it.each([
    successfulRuntimeResult({
      approval: {
        proposal: decision,
        target: { ...draft, version: draft.version + 1 },
        toolName: "execute_commitment",
      },
    }),
    successfulRuntimeResult({
      approval: {
        proposal: {
          calendarPolicy: {
            conflict: "reject",
            unavailable: "reject",
          },
          commitmentId: draft.id,
          definitionOfDone: decision.definitionOfDone!,
          expectedVersion: draft.version,
          preparation: { nextWorkSession: null, required: false },
          targetAt: decision.targetAt!,
        },
        target: draft,
        toolName: "update_commitment",
      },
    }),
    successfulRuntimeResult({ pendingApprovalState: undefined }),
  ])("does not stage a non-exact or non-paused runtime result", async (result) => {
    const test = fixture();
    test.runtime.continueCreation.mockResolvedValueOnce(result);

    await expect(test.prepare({
      chatId: 42,
      decision,
      draft,
      updateId: 102,
    })).resolves.toBe(false);

    expect(test.gate.stagePaused).not.toHaveBeenCalled();
  });
});
