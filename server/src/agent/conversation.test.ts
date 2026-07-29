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
  AgentContextReader,
  AgentProductContext,
} from "./context-reader.js";
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
    callbackChoice: {
      action: "work_session.no_preparation",
      updateId: 10,
    },
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

function productContext(active: boolean): AgentProductContext {
  const draft = {
    definitionOfDone: "Submit the note",
    focused: true,
    id: snapshot.activeDraftId!,
    mode: "unresolved" as const,
    phase: "awaiting_target" as const,
    targetAt: null,
    version: 3,
  };
  return {
    ambiguity: null,
    commitments: [],
    drafts: active ? [draft] : [],
    focusedEntity: active
      ? { entity: draft, kind: "draft" as const }
      : null,
    recentOutcomes: [],
    truncated: {
      commitments: false,
      drafts: false,
      recentOutcomes: false,
      workSessions: false,
    },
    workSessions: [],
  };
}

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
    continueCreation: vi.fn(),
    resume: vi.fn(),
    run: vi.fn(async () => ({ outcome: { decision, ok: true } })),
  };
  const contextReader: AgentContextReader = {
    readHistory: vi.fn(async () => ({
      items: [],
      nextCursor: null,
    })),
    readProductContext: vi.fn(async () => productContext(active)),
  };
  const draftRepository = {
    resolveDraftReference: vi.fn(async () => ({ kind: "none" as const })),
  };
  return {
    engine: new SessionBackedAgentDecisionEngine({
      chatId: 42,
      contextReader,
      draftRepository,
      onContinuityFailure: continuityFailures,
      repository,
      runtime,
    }),
    continuityFailures,
    contextReader,
    draftRepository,
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
    ).resolves.toMatchObject({
      decision,
      draftTarget: {
        authority: {
          expectedVersion: 3,
          id: snapshot.activeDraftId,
          kind: "draft",
        },
      },
      ok: true,
    });
    expect(test.runtime.run).toHaveBeenCalledWith({
      authority: {
        chatId: 42,
        draftId: snapshot.activeDraftId,
        draftVersion: 3,
        sessionId: snapshot.id,
        updateId: 11,
      },
      conversation: {
        draftResolution: { kind: "none" },
        interaction: snapshot.interaction,
        olderHistoryAvailable: false,
        product: productContext(true),
      },
      input,
      session: test.session,
    });
    expect(test.contextReader.readProductContext).toHaveBeenCalledWith({
      chatId: 42,
      focusedEntityId: snapshot.activeDraftId,
      query: input.ownerText,
    });

    await test.engine.completeTurn({
      activeDraftId: snapshot.activeDraftId,
      assistantText: "Do you need preparation time?",
      pendingQuestion: "replace",
      status: "active",
      updateId: 11,
    });
    expect(test.records).toEqual([
      {
        activeDraftId: snapshot.activeDraftId,
        assistantText: "Do you need preparation time?",
        pendingQuestion: "replace",
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
      pendingQuestion: "clear",
      status: "ignored",
      updateId: 12,
    });

    expect(test.session.recordApplicationReply).toHaveBeenCalledWith({
      activeDraftId: null,
      assistantText: "Singapore uses UTC+08:00.",
      pendingQuestion: "clear",
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
      pendingQuestion: "clear",
      status: "closed",
      updateId: 13,
    });

    expect(test.session.recordApplicationReply).toHaveBeenCalledWith({
      activeDraftId: null,
      assistantText: "Okay. Nothing was saved.",
      pendingQuestion: "clear",
      updateId: 13,
    });
    expect(test.repository.clear).not.toHaveBeenCalled();
  });

  it("resolves a unique parked reference into exact draft authority for the run", async () => {
    const test = fixture();
    const parkedId = "22222222-2222-4222-8222-222222222222";
    const parkedFields = {
      definitionOfDone: "Review the finance report",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: false,
      targetAt: null,
      targetTimeZone: null,
      timingConstraints: [],
    };
    vi.mocked(
      test.draftRepository.resolveDraftReference,
    ).mockResolvedValueOnce({
      authority: {
        expectedVersion: 2,
        id: parkedId,
        kind: "draft",
      },
      draft: {
        expiresAt: "2026-08-30T00:00:00.000Z",
        fields: parkedFields,
        focused: false,
        id: parkedId,
        kind: "draft",
        phase: "awaiting_target",
        updatedAt: "2026-07-30T00:00:00.000Z",
        version: 2,
      },
      kind: "exact",
    });
    const parkedProduct = productContext(false);
    const productDraft = {
      definitionOfDone: "Review the finance report",
      focused: false,
      id: parkedId,
      mode: "unresolved" as const,
      phase: "awaiting_target" as const,
      targetAt: null,
      version: 2,
    };
    vi.mocked(
      test.contextReader.readProductContext,
    ).mockResolvedValueOnce({
      ...parkedProduct,
      drafts: [productDraft],
      focusedEntity: { entity: productDraft, kind: "draft" },
    });
    const parkedDecision = {
      ...decision,
      definitionOfDone: "Review the finance report",
    };
    vi.mocked(test.runtime.run).mockResolvedValueOnce({
      outcome: { decision: parkedDecision, ok: true },
    });

    const outcome = await test.engine.decide(
      {
        context: {
          fields: {
            commitmentMode: "unresolved",
            definitionOfDone: "Submit the note",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            targetAt: null,
            targetTimeZone: null,
            timingConstraints: [],
          },
          phase: "awaiting_target",
        },
        ownerText: "Move the finance report to Friday",
      },
      { updateId: 15 },
    );

    expect(outcome).toMatchObject({
      draftTarget: {
        authority: {
          expectedVersion: 2,
          id: parkedId,
          kind: "draft",
        },
        fields: parkedFields,
        phase: "awaiting_target",
      },
      ok: true,
    });
    expect(test.runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({
          draftId: parkedId,
          draftVersion: 2,
        }),
        conversation: expect.objectContaining({
          draftResolution: {
            authority: {
              expectedVersion: 2,
              id: parkedId,
              kind: "draft",
            },
            kind: "exact",
          },
        }),
        input: expect.objectContaining({
          context: expect.objectContaining({
            fields: expect.objectContaining({
              definitionOfDone: "Review the finance report",
            }),
          }),
        }),
      }),
    );
  });

  it("turns an ambiguous entity reference into a clarification without mutation intent", async () => {
    const test = fixture();
    const ambiguous = productContext(true);
    vi.mocked(test.contextReader.readProductContext).mockResolvedValueOnce({
      ...ambiguous,
      ambiguity: {
        candidates: [
          {
            id: snapshot.activeDraftId!,
            kind: "draft",
            label: "Submit the launch report",
            version: 3,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "draft",
            label: "Review the finance report",
            version: 2,
          },
        ],
        query: "move the report to friday",
      },
    });

    const outcome = await test.engine.decide(
      {
        context: {
          fields: {
            commitmentMode: "unresolved",
            definitionOfDone: "Submit the note",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            targetAt: null,
            targetTimeZone: null,
            timingConstraints: [],
          },
          phase: "awaiting_target",
        },
        ownerText: "Move the report to Friday",
      },
      { updateId: 16 },
    );

    expect(outcome).toMatchObject({
      decision: {
        inputClass: "ordinary_question",
        response:
          "Nothing was changed. Which one did you mean: “Submit the launch report”, “Review the finance report”?",
        turnRelation: "none",
      },
      ok: true,
    });
  });

  it("stages an exact commitment-edit interruption from the same durable run and returns only application preview copy", async () => {
    const test = fixture(false);
    const commitmentId = "33333333-3333-4333-8333-333333333333";
    const edit = {
      calendarPolicy: {
        conflict: "reject" as const,
        unavailable: "reject" as const,
      },
      commitmentId,
      definitionOfDone: "Submit the final note",
      expectedVersion: 6,
      preparation: {
        nextWorkSession: null,
        required: false,
      },
      targetAt: "2026-08-01T09:00:00.000Z",
    };
    vi.mocked(
      test.contextReader.readProductContext,
    ).mockResolvedValueOnce({
      ...productContext(false),
      commitments: [{
        definitionOfDone: "Submit the note",
        id: commitmentId,
        status: "active",
        targetAt: "2026-08-01T08:00:00.000Z",
        version: 6,
      }],
      matchedEntity: {
        entity: {
          definitionOfDone: "Submit the note",
          id: commitmentId,
          status: "active",
          targetAt: "2026-08-01T08:00:00.000Z",
          version: 6,
        },
        kind: "commitment",
      },
    });
    vi.mocked(test.runtime.run).mockResolvedValueOnce({
      approval: {
        proposal: edit,
        target: { id: commitmentId, version: 6 },
        toolName: "update_commitment",
      },
      outcome: {
        decision: {
          ...decision,
          commitmentMode: "simple_action",
          definitionOfDone: edit.definitionOfDone,
          inputClass: "ordinary_question",
          missingFields: [],
          nextAction: "answer",
          response: "",
          targetAt: edit.targetAt,
          targetTimeZone: "Asia/Singapore",
          turnRelation: "none",
        },
        ok: true,
      },
      pendingApprovalState: "same-encrypted-run",
    });
    const prepareApproval = vi.fn(async () => true);
    const engine = new SessionBackedAgentDecisionEngine({
      chatId: 42,
      contextReader: test.contextReader,
      draftRepository: test.draftRepository,
      prepareApproval,
      repository: test.repository,
      runtime: test.runtime,
    });

    const outcome = await engine.decide(
      {
        context: { fields: null, phase: "none" },
        ownerText: "Move the note promise to 5pm",
      },
      { updateId: 71 },
    );

    expect(prepareApproval).toHaveBeenCalledWith({
      chatId: 42,
      draft: { id: commitmentId, version: 6 },
      pendingApprovalState: "same-encrypted-run",
      sessionId: "session-1",
      toolName: "update_commitment",
      updateId: 71,
    });
    expect(outcome).toMatchObject({
      approval: {
        target: {
          id: commitmentId,
          kind: "commitment",
          version: 6,
        },
      },
      ok: true,
    });
    expect(outcome.ok && outcome.approval?.reply.text).toContain(
      "Nothing has been changed yet.",
    );
    expect(test.runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: expect.objectContaining({
          draftId: commitmentId,
          draftVersion: 6,
          entityKind: "commitment",
        }),
        session: test.session,
      }),
    );
  });

  it("stages exact draft creation from the same durable run", async () => {
    const test = fixture();
    const completeDecision: DecisionResult = {
      commitmentMode: "simple_action",
      definitionOfDone: "Submit the note",
      durationMinutes: null,
      inputClass: "explicit_commitment",
      missingFields: [],
      nextAction: "ready",
      offerWorkWindowHelp: false,
      response: "",
      targetAt: "2026-07-31T17:00:00+08:00",
      targetTimeZone: "Asia/Singapore",
      timingConstraints: [],
      turnRelation: "correction",
    };
    const completeDraft = {
      definitionOfDone: completeDecision.definitionOfDone,
      focused: true,
      id: snapshot.activeDraftId!,
      mode: "simple_action" as const,
      phase: "complete" as const,
      targetAt: completeDecision.targetAt,
      version: 3,
    };
    vi.mocked(
      test.contextReader.readProductContext,
    ).mockResolvedValueOnce({
      ...productContext(false),
      drafts: [completeDraft],
      focusedEntity: { entity: completeDraft, kind: "draft" },
    });
    vi.mocked(test.runtime.run).mockResolvedValueOnce({
      approval: {
        proposal: completeDecision,
        target: { id: completeDraft.id, version: 3 },
        toolName: "execute_commitment",
      },
      outcome: { decision: completeDecision, ok: true },
      pendingApprovalState: "same-creation-run",
    });
    const prepareApproval = vi.fn(async () => true);
    const engine = new SessionBackedAgentDecisionEngine({
      chatId: 42,
      contextReader: test.contextReader,
      draftRepository: test.draftRepository,
      prepareApproval,
      repository: test.repository,
      runtime: test.runtime,
    });

    const outcome = await engine.decide(
      {
        context: {
          fields: {
            commitmentMode: "simple_action",
            definitionOfDone: "Submit the note",
            durationMinutes: null,
            offerWorkWindowHelp: false,
            targetAt: completeDecision.targetAt,
            targetTimeZone: "Asia/Singapore",
            timingConstraints: [],
          },
          phase: "complete",
        },
        ownerText: "Confirm that promise",
      },
      { updateId: 72 },
    );

    expect(prepareApproval).toHaveBeenCalledWith({
      chatId: 42,
      draft: { id: completeDraft.id, version: 3 },
      pendingApprovalState: "same-creation-run",
      sessionId: "session-1",
      toolName: "execute_commitment",
      updateId: 72,
    });
    expect(outcome).toMatchObject({
      approval: {
        reply: {
          actions: [
            {
              callbackData: `d:${completeDraft.id}:3:confirm`,
              text: "Confirm",
            },
            {
              callbackData: `d:${completeDraft.id}:3:cancel`,
              text: "Cancel",
            },
          ],
        },
        target: {
          id: completeDraft.id,
          kind: "draft",
          version: 3,
        },
      },
      ok: true,
    });
    expect(outcome.ok && outcome.approval?.reply.text).toContain(
      "Nothing has been saved yet.",
    );
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
        pendingQuestion: "replace",
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
