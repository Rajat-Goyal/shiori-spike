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
    reply: TelegramReply,
  ): Promise<void> {
    const action = sanitizedChoice(callbackData);
    if (action === null) {
      return;
    }
    const session = await this.#sessions.open(chatId);
    if (session.currentSnapshot().version === 0) {
      return;
    }
    await session.recordCallbackChoice({
      action,
      assistantText: reply.text,
      pendingQuestion:
        (reply.actions?.length ?? 0) > 0 ||
        reply.text.trimEnd().endsWith("?"),
      updateId,
    });
  }
}
