import {
  parseDraftAction,
  type TelegramReply,
} from "../confirmation.js";
import { parseSimpleCommitmentAction } from "../commitments/simple-action.js";
import { parseWorkSessionContinuationAction } from "../work-sessions/continuation.js";
import { parseWorkSessionAction } from "../work-sessions/flow.js";
import { parseWorkSessionOutcome } from "../work-sessions/outcomes.js";
import type { AgentSessionRepository } from "./session.js";

type AgentCallbackContextRecorderOptions = Readonly<{
  sessions: AgentSessionRepository;
}>;

const CALLBACK_CONTEXT_CAS_ATTEMPTS = 3;

export const callbackContextReplayReply: TelegramReply = {
  text:
    "That action was already handled. Use /status to see the current state.",
};

function sessionConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Agent session changed concurrently"
  );
}

function sanitizedChoice(value: unknown): string | null {
  const draft = parseDraftAction(value);
  if (draft !== null) {
    return `draft.${draft.action}`;
  }
  const workSession = parseWorkSessionAction(value);
  if (workSession !== null) {
    return `work_session.${workSession.action}`;
  }
  const commitment = parseSimpleCommitmentAction(value);
  if (commitment !== null) {
    const family =
      commitment.action === "confirm_cancel" ||
      commitment.action === "keep"
        ? "commitment_cancel"
        : "commitment";
    return `${family}.${commitment.action}`;
  }
  const outcome = parseWorkSessionOutcome(value);
  if (outcome !== null) {
    return `work_session_outcome.${outcome.action}`;
  }
  const continuation = parseWorkSessionContinuationAction(value);
  if (continuation !== null) {
    return `work_session_continuation.${continuation.action}`;
  }
  return null;
}

/**
 * Projects an authenticated callback into durable conversation context.
 *
 * Raw callback data and entity identifiers never cross this boundary. The
 * domain callback service applies the authoritative transition first; this
 * recorder stores only the allowlisted owner choice and resulting application
 * reply/question.
 */
export class AgentCallbackContextRecorder {
  readonly #sessions: AgentSessionRepository;

  constructor(options: AgentCallbackContextRecorderOptions) {
    this.#sessions = options.sessions;
  }

  async record(
    updateId: number,
    chatId: number,
    callbackData: unknown,
    reply: TelegramReply | null,
  ): Promise<TelegramReply | null> {
    const action = sanitizedChoice(callbackData);
    if (action === null) {
      return reply;
    }
    const applicationReply = reply ?? callbackContextReplayReply;
    for (
      let attempt = 0;
      attempt < CALLBACK_CONTEXT_CAS_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const session = await this.#sessions.open(chatId);
        if (session.currentSnapshot().version === 0) {
          await session.addItems([
            {
              content: `Owner selected ${action}.`,
              role: "user",
            },
          ]);
        }
        const result = await session.recordCallbackChoice({
          action,
          assistantText: applicationReply.text,
          pendingQuestion:
            (applicationReply.actions?.length ?? 0) > 0 ||
            applicationReply.text.trimEnd().endsWith("?"),
          updateId,
        });
        if (result.kind !== "stale") {
          return applicationReply;
        }
      } catch (error) {
        if (!sessionConflict(error)) {
          throw error;
        }
      }
    }
    throw new Error("Agent callback context changed concurrently");
  }
}
