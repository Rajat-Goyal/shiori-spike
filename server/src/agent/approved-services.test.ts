import { describe, expect, it, vi } from "vitest";
import type { TelegramReply } from "../confirmation.js";
import type { AgentApprovalGate } from "./approval.js";
import {
  AgentApprovedConfirmationService,
  AgentApprovedWorkSessionService,
} from "./approved-services.js";
import type { AgentSessionRepository } from "./session.js";

const ID = "11111111-1111-4111-8111-111111111111";

function fixture(
  result: Awaited<ReturnType<AgentApprovalGate["resolve"]>>,
  reply: TelegramReply = { text: "Promise saved. Done." },
) {
  const gate: AgentApprovalGate = {
    clearAfterTerminal: vi.fn(async () => ({ kind: "cleared" })),
    prepare: vi.fn(async () => ({ kind: "prepared" })),
    resolve: vi.fn(async () =>
      result.kind === "approved" && result.reply === undefined
        ? { ...result, reply }
        : result
    ),
  };
  const service = {
    handle: vi.fn(async () => reply),
  };
  const sdkSession = {
    addItems: vi.fn(async () => undefined),
    chatId: 42,
    clearSession: vi.fn(async () => undefined),
    currentSnapshot: () => ({
      activeDraftId: ID,
      chatId: 42,
      compactionCheckpoint: null,
      expiresAt: "2026-08-30T10:00:00.000Z",
      firstWorkingSequence: null,
      id: "session-1",
      interaction: { callbackChoice: null, pendingQuestion: null },
      itemCount: 0,
      items: [],
      version: 2,
    }),
    getItems: vi.fn(async () => []),
    getSessionId: vi.fn(async () => "session-1"),
    popItem: vi.fn(async () => undefined),
    readHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
    recordApplicationReply: vi.fn(async () => ({
      kind: "stale" as const,
    })),
    recordCallbackChoice: vi.fn(async () => ({
      kind: "stale" as const,
    })),
    reset: vi.fn(async () => undefined),
    runCompaction: vi.fn(async () => null),
    sessionId: "session-1",
  };
  const sessions: AgentSessionRepository = {
    clear: vi.fn(async () => ({ kind: "cleared" })),
    open: vi.fn(async () => sdkSession),
    read: vi.fn(async () => ({
      kind: "active",
      session: {
        activeDraftId: ID,
        chatId: 42,
        compactionCheckpoint: null,
        expiresAt: "2026-07-30T10:00:00.000Z",
        firstWorkingSequence: null,
        id: "session-1",
        interaction: { callbackChoice: null, pendingQuestion: null },
        itemCount: 0,
        items: [],
        version: 2,
      },
    })),
  };
  return { gate, service, sessions };
}

describe("agent-approved callback services", () => {
  it("resumes approval before delegating the exact simple confirmation and clears terminal state", async () => {
    const test = fixture({ kind: "approved" });
    const wrapper = new AgentApprovedConfirmationService(test);
    const callback = `d:${ID}:3:confirm`;

    await expect(wrapper.handle(200, 42, callback)).resolves.toEqual({
      text: "Promise saved. Done.",
    });
    expect(test.gate.resolve).toHaveBeenCalledWith({
      chatId: 42,
      decision: "approve",
      draft: { action: "confirm", id: ID, version: 3 },
      updateId: 200,
    });
    expect(test.service.handle).not.toHaveBeenCalled();
    expect(test.gate.clearAfterTerminal).toHaveBeenCalledWith({
      chatId: 42,
      reason: "confirmed",
      sessionId: "session-1",
      updateId: 200,
    });
  });

  it("never reaches the simple atomic action when approval is unavailable", async () => {
    const test = fixture({ kind: "unavailable" });
    const wrapper = new AgentApprovedConfirmationService(test);

    await expect(
      wrapper.handle(201, 42, `d:${ID}:3:confirm`),
    ).resolves.toEqual({
      text:
        "I couldn’t confirm whether the promise was saved. Please press Confirm again.",
    });
    expect(test.service.handle).not.toHaveBeenCalled();
  });

  it("rejects approval, delegates exact simple cancellation, and clears continuity", async () => {
    const test = fixture(
      { kind: "rejected" },
      { text: "Draft cancelled. Nothing was saved." },
    );
    const wrapper = new AgentApprovedConfirmationService(test);

    await wrapper.handle(202, 42, `d:${ID}:3:cancel`);

    expect(test.gate.resolve).toHaveBeenCalledWith({
      chatId: 42,
      decision: "reject",
      draft: { action: "cancel", id: ID, version: 3 },
      updateId: 202,
    });
    expect(test.service.handle).toHaveBeenCalledOnce();
    expect(test.gate.clearAfterTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cancelled" }),
    );
  });

  it("gates final work confirmation with no raw bypass and clears after save", async () => {
    const test = fixture(
      { kind: "approved" },
      { text: "Promise and work session saved. Done." },
    );
    const wrapper = new AgentApprovedWorkSessionService(test);
    const callback = `w:${ID}:7:confirm`;

    await wrapper.handle(300, 42, callback);

    expect(test.gate.resolve).toHaveBeenCalledWith({
      chatId: 42,
      decision: "approve",
      draft: { action: "confirm", id: ID, version: 7 },
      updateId: 300,
    });
    expect(test.service.handle).not.toHaveBeenCalled();
    expect(test.gate.clearAfterTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "confirmed" }),
    );
  });

  it("blocks final work consequences without approval while allowing nonconsequential transitions", async () => {
    const blocked = fixture({ kind: "unavailable" });
    const blockedWrapper = new AgentApprovedWorkSessionService(blocked);
    await expect(
      blockedWrapper.handle(301, 42, `w:${ID}:7:save_unverified`),
    ).resolves.toEqual({
      text:
        "I couldn’t safely prepare confirmation. Nothing was saved. Send another message to continue this draft.",
    });
    expect(blocked.service.handle).not.toHaveBeenCalled();

    const allowed = fixture({ kind: "unavailable" });
    const allowedWrapper = new AgentApprovedWorkSessionService(allowed);
    await allowedWrapper.handle(302, 42, `w:${ID}:7:option_1`);
    expect(allowed.gate.resolve).not.toHaveBeenCalled();
    expect(allowed.service.handle).toHaveBeenCalledOnce();
  });
});
