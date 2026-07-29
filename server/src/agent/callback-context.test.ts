import { describe, expect, it, vi } from "vitest";
import type {
  AgentSdkSession,
  AgentSessionRepository,
} from "./session.js";
import {
  AgentCallbackContextRecorder,
  callbackContextReplayReply,
} from "./callback-context.js";

const ID = "11111111-1111-4111-8111-111111111111";

function fixture(persisted = true) {
  const snapshot = {
    activeDraftId: null,
    chatId: 42,
    compactionCheckpoint: null,
    expiresAt: "2026-08-30T10:00:00.000Z",
    firstWorkingSequence: null,
    id: ID,
    interaction: { callbackChoice: null, pendingQuestion: null },
    itemCount: 0,
    items: [],
    version: persisted ? 2 : 0,
  } as const;
  const recordCallbackChoice =
    vi.fn<AgentSdkSession["recordCallbackChoice"]>(
      async () => ({ kind: "applied", session: snapshot }),
    );
  const addItems = vi.fn(async () => undefined);
  const session: AgentSdkSession = {
    addItems,
    chatId: 42,
    clearSession: vi.fn(async () => undefined),
    currentSnapshot: () => snapshot,
    getItems: vi.fn(async () => []),
    getSessionId: vi.fn(async () => ID),
    popItem: vi.fn(async () => undefined),
    readHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    recordApplicationReply: vi.fn(async () => ({ kind: "stale" })),
    recordCallbackChoice,
    reset: vi.fn(async () => undefined),
    runCompaction: vi.fn(async () => null),
    sessionId: ID,
  };
  const sessions: AgentSessionRepository = {
    clear: vi.fn(async () => ({ kind: "none" })),
    open: vi.fn(async () => session),
    read: vi.fn(async () => ({ kind: "none" })),
  };
  return {
    addItems,
    recordCallbackChoice,
    recorder: new AgentCallbackContextRecorder({ sessions }),
    sessions,
    snapshot,
  };
}

describe("AgentCallbackContextRecorder", () => {
  it.each([
    [`d:${ID}:3:confirm`, "draft.confirm"],
    [`w:${ID}:3:no_preparation`, "work_session.no_preparation"],
    [`p:${ID}:3:done`, "commitment.done"],
    [`x:${ID}:3:confirm_cancel`, "commitment_cancel.confirm_cancel"],
    [`s:${ID}:3:more`, "work_session_outcome.more"],
    [
      `c:${ID}:3:duration_60`,
      "work_session_continuation.duration_60",
    ],
  ])(
    "stores only the sanitized choice for %s",
    async (callbackData, action) => {
      const test = fixture();
      await test.recorder.record(90, 42, callbackData, {
        actions: [{ callbackData: `private:${ID}`, text: "Continue" }],
        text: "What should happen next?",
      });

      expect(test.recordCallbackChoice).toHaveBeenCalledWith({
        action,
        assistantText: "What should happen next?",
        pendingQuestion: true,
        updateId: 90,
      });
      expect(
        JSON.stringify(test.recordCallbackChoice.mock.calls),
      ).not.toContain(ID);
      expect(
        JSON.stringify(test.recordCallbackChoice.mock.calls),
      ).not.toContain("private:");
    },
  );

  it("ignores malformed callbacks and creates sanitized context for a lazy session", async () => {
    const malformed = fixture();
    await malformed.recorder.record(91, 42, `p:${ID}:3:unknown`, {
      text: "Ignored",
    });
    expect(malformed.sessions.open).not.toHaveBeenCalled();

    const lazy = fixture(false);
    await lazy.recorder.record(92, 42, `s:${ID}:3:missed`, {
      text: "Would you like another work window?",
    });
    expect(lazy.addItems).toHaveBeenCalledWith([
      {
        content: "Owner selected work_session_outcome.missed.",
        role: "user",
      },
    ]);
    expect(lazy.recordCallbackChoice).toHaveBeenCalledOnce();
  });

  it("retains a textual application question even without callback buttons", async () => {
    const test = fixture();
    await test.recorder.record(93, 42, `s:${ID}:3:more`, {
      text: "How much focused time remains?",
    });
    expect(test.recordCallbackChoice).toHaveBeenCalledWith(
      expect.objectContaining({ pendingQuestion: true }),
    );
  });

  it("reloads and retries a bounded CAS conflict", async () => {
    const test = fixture();
    test.recordCallbackChoice
      .mockResolvedValueOnce({ kind: "stale" })
      .mockResolvedValueOnce({
        kind: "applied",
        session: test.snapshot,
      });

    await expect(
      test.recorder.record(94, 42, `p:${ID}:3:done`, {
        text: "Promise completed.",
      }),
    ).resolves.toEqual({ text: "Promise completed." });
    expect(test.sessions.open).toHaveBeenCalledTimes(2);
    expect(test.recordCallbackChoice).toHaveBeenCalledTimes(2);
  });

  it("propagates a transient write failure and recovers from the process-gap replay", async () => {
    const test = fixture();
    test.recordCallbackChoice
      .mockRejectedValueOnce(new Error("temporary persistence outage"))
      .mockResolvedValueOnce({
        kind: "replay",
        session: test.snapshot,
      });

    await expect(
      test.recorder.record(95, 42, `s:${ID}:3:done`, {
        text: "Promise completed.",
      }),
    ).rejects.toThrow("temporary persistence outage");
    await expect(
      test.recorder.record(95, 42, `s:${ID}:3:done`, null),
    ).resolves.toEqual(callbackContextReplayReply);
  });

  it("returns an application-controlled response for a successful duplicate receipt replay", async () => {
    const test = fixture();
    test.recordCallbackChoice
      .mockResolvedValueOnce({
        kind: "applied",
        session: test.snapshot,
      })
      .mockResolvedValueOnce({
        kind: "replay",
        session: test.snapshot,
      });

    await test.recorder.record(96, 42, `x:${ID}:3:keep`, {
      text: "Promise kept active.",
    });
    await expect(
      test.recorder.record(96, 42, `x:${ID}:3:keep`, null),
    ).resolves.toEqual(callbackContextReplayReply);
    expect(test.recordCallbackChoice).toHaveBeenCalledTimes(2);
  });
});
