import {
  confirmationCopy,
  parseDraftAction,
  type TelegramReply,
} from "../confirmation.js";
import {
  commitmentChangeCopy,
  parseCommitmentEditApproval,
} from "../commitments/approved-change.js";
import {
  parseWorkSessionAction,
  workSessionFlowCopy,
} from "../work-sessions/flow.js";
import type { AgentApprovalGate } from "./approval.js";
import type { AgentSessionRepository } from "./session.js";

type CallbackService = Readonly<{
  handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null>;
}>;

type ApprovedServiceOptions = Readonly<{
  gate: AgentApprovalGate;
  service: CallbackService;
  sessions: AgentSessionRepository;
}>;

async function clearActiveSession(
  options: Pick<ApprovedServiceOptions, "gate" | "sessions">,
  chatId: number,
  updateId: number,
  reason: "cancelled" | "confirmed",
): Promise<void> {
  try {
    const read = await options.sessions.read(chatId);
    if (read.kind !== "active") {
      return;
    }
    await options.gate.clearAfterTerminal({
      chatId,
      reason,
      sessionId: read.session.id,
      updateId,
    });
  } catch {
    // Terminal domain state and its deterministic reply take precedence over
    // best-effort approval cleanup.
  }
}

export class AgentApprovedConfirmationService {
  readonly #gate: AgentApprovalGate;
  readonly #service: CallbackService;
  readonly #sessions: AgentSessionRepository;

  constructor(options: ApprovedServiceOptions) {
    this.#gate = options.gate;
    this.#service = options.service;
    this.#sessions = options.sessions;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const action = parseDraftAction(callbackData);
    if (!action) {
      return this.#service.handle(updateId, chatId, callbackData);
    }
    if (action.action === "cancel") {
      await this.#gate.resolve({
        chatId,
        decision: "reject",
        draft: action,
        updateId,
      }).catch(() => ({ kind: "unavailable" as const }));
      const reply = await this.#service.handle(
        updateId,
        chatId,
        callbackData,
      );
      if (
        reply?.text === confirmationCopy.cancelled ||
        reply?.text === confirmationCopy.alreadyCancelled
      ) {
        await clearActiveSession(
          { gate: this.#gate, sessions: this.#sessions },
          chatId,
          updateId,
          "cancelled",
        );
      }
      return reply;
    }

    const approval = await this.#gate.resolve({
      chatId,
      decision: "approve",
      draft: action,
      updateId,
    });
    if (approval.kind === "replay") {
      return null;
    }
    if (approval.kind !== "approved") {
      return { text: confirmationCopy.uncertainConfirm };
    }
    if (approval.replayed) {
      await clearActiveSession(
        { gate: this.#gate, sessions: this.#sessions },
        chatId,
        updateId,
        "confirmed",
      );
      return null;
    }
    const reply = approval.reply;
    if (!reply) {
      return { text: confirmationCopy.uncertainConfirm };
    }
    if (
      reply.text.startsWith("Promise saved.") ||
      reply.text === confirmationCopy.alreadyConfirmed
    ) {
      await clearActiveSession(
        { gate: this.#gate, sessions: this.#sessions },
        chatId,
        updateId,
        "confirmed",
      );
    }
    return reply;
  }
}

export class AgentApprovedWorkSessionService {
  readonly #gate: AgentApprovalGate;
  readonly #service: CallbackService;
  readonly #sessions: AgentSessionRepository;

  constructor(options: ApprovedServiceOptions) {
    this.#gate = options.gate;
    this.#service = options.service;
    this.#sessions = options.sessions;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const action = parseWorkSessionAction(callbackData);
    if (!action) {
      return this.#service.handle(updateId, chatId, callbackData);
    }
    if (action.action === "cancel") {
      await this.#gate.resolve({
        chatId,
        decision: "reject",
        draft: action,
        updateId,
      }).catch(() => ({ kind: "unavailable" as const }));
      const reply = await this.#service.handle(
        updateId,
        chatId,
        callbackData,
      );
      if (reply?.text === workSessionFlowCopy.cancelled) {
        await clearActiveSession(
          { gate: this.#gate, sessions: this.#sessions },
          chatId,
          updateId,
          "cancelled",
        );
      }
      return reply;
    }
    if (
      action.action !== "confirm" &&
      action.action !== "save_unverified"
    ) {
      return this.#service.handle(updateId, chatId, callbackData);
    }

    const approval = await this.#gate.resolve({
      chatId,
      decision: "approve",
      draft: action,
      updateId,
    });
    if (approval.kind === "replay") {
      return null;
    }
    if (approval.kind !== "approved") {
      return { text: workSessionFlowCopy.approvalUnavailable };
    }
    if (approval.replayed) {
      await clearActiveSession(
        { gate: this.#gate, sessions: this.#sessions },
        chatId,
        updateId,
        "confirmed",
      );
      return null;
    }
    const reply = approval.reply;
    if (!reply) {
      return { text: workSessionFlowCopy.approvalUnavailable };
    }
    if (reply.text.startsWith("Promise and work session saved.")) {
      await clearActiveSession(
        { gate: this.#gate, sessions: this.#sessions },
        chatId,
        updateId,
        "confirmed",
      );
    }
    return reply;
  }
}

export class AgentApprovedCommitmentChangeService {
  readonly #gate: AgentApprovalGate;
  readonly #sessions: AgentSessionRepository;

  constructor(
    options: Pick<ApprovedServiceOptions, "gate" | "sessions">,
  ) {
    this.#gate = options.gate;
    this.#sessions = options.sessions;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const action = parseCommitmentEditApproval(callbackData);
    if (action === null) {
      return { text: commitmentChangeCopy.malformed };
    }
    const resolution = await this.#gate.resolve({
      chatId,
      decision:
        action.action === "approve" ? "approve" : "reject",
      draft: {
        id: action.commitmentId,
        version: action.version,
      },
      toolName: "update_commitment",
      updateId,
    });
    if (resolution.kind === "replay") {
      return null;
    }
    if (action.action === "reject") {
      return {
        text:
          resolution.kind === "rejected"
            ? commitmentChangeCopy.rejected
            : commitmentChangeCopy.uncertain,
      };
    }
    if (resolution.kind !== "approved") {
      return { text: commitmentChangeCopy.uncertain };
    }
    await clearActiveSession(
      { gate: this.#gate, sessions: this.#sessions },
      chatId,
      updateId,
      "confirmed",
    );
    if (resolution.replayed) {
      return { text: commitmentChangeCopy.replay };
    }
    return resolution.reply ??
      { text: commitmentChangeCopy.uncertain };
  }
}
