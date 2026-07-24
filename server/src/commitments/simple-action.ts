import type { TelegramReply } from "../confirmation.js";
import { supabaseHeaders } from "../supabase.js";

export type SimpleCommitmentAction = "cancel" | "done";
export type CancellationConfirmationAction =
  | "confirm_cancel"
  | "keep";

type ParsedSimpleCommitmentAction = {
  action: SimpleCommitmentAction | CancellationConfirmationAction;
  commitmentId: string;
  version: number;
};

type SimpleCommitmentActionCommand = {
  action:
    | SimpleCommitmentAction
    | CancellationConfirmationAction
    | null;
  chatId: number;
  commitmentId: string | null;
  updateId: number;
  version: number | null;
};

export type SimpleCommitmentActionResult =
  | { kind: "replay" }
  | {
      completed: true;
      kind:
        | "already_cancelled"
        | "cancelled"
        | "kept"
        | "malformed"
        | "stale";
    }
  | {
      completed: true;
      commitmentId: string;
      kind: "cancel_pending";
      version: number;
    }
  | {
      completed: true;
      completedAt: string;
      kind: "already_done" | "done";
    };

export interface SimpleCommitmentActionRepository {
  resolve(
    command: SimpleCommitmentActionCommand,
  ): Promise<SimpleCommitmentActionResult>;
}

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTION_PATTERN = new RegExp(
  `^p:(${UUID_PATTERN}):([1-9][0-9]*):(done|cancel)$`,
);
const CANCELLATION_ACTION_PATTERN = new RegExp(
  `^x:(${UUID_PATTERN}):([1-9][0-9]*):(confirm_cancel|keep)$`,
);

export const simpleCommitmentActionCopy = {
  alreadyCancelled: "That promise was already cancelled.",
  alreadyDone: "That promise is already complete.",
  cancelPrompt:
    "Cancel this saved promise? This requires a second confirmation. Nothing has changed yet.",
  cancelled: "Promise cancelled.",
  done: "Promise completed.",
  kept: "Promise kept active.",
  malformed: "That action isn’t valid. Nothing was changed.",
  stale: "That action is stale. Nothing was changed.",
  uncertain:
    "I couldn’t confirm whether that action was recorded. Please check /status before trying again.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(new Date(value).getTime())
  );
}

export function parseSimpleCommitmentAction(
  value: unknown,
): ParsedSimpleCommitmentAction | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match =
    ACTION_PATTERN.exec(value) ??
    CANCELLATION_ACTION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) {
    return null;
  }
  return {
    action: match[3] as
      | SimpleCommitmentAction
      | CancellationConfirmationAction,
    commitmentId: match[1],
    version,
  };
}

function parseActionResult(value: unknown): SimpleCommitmentActionResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(
      "Simple commitment action repository returned an invalid response",
    );
  }
  if (value.kind === "replay") {
    return { kind: "replay" };
  }
  if (value.completed !== true) {
    throw new Error("Simple commitment action update was not completed");
  }
  if (
    [
      "already_cancelled",
      "cancelled",
      "kept",
      "malformed",
      "stale",
    ].includes(value.kind)
  ) {
    return {
      completed: true,
      kind: value.kind as
        | "already_cancelled"
        | "cancelled"
        | "kept"
        | "malformed"
        | "stale",
    };
  }
  if (
    value.kind === "cancel_pending" &&
    typeof value.commitmentId === "string" &&
    new RegExp(`^${UUID_PATTERN}$`).test(value.commitmentId) &&
    safeVersion(value.version)
  ) {
    return {
      completed: true,
      commitmentId: value.commitmentId,
      kind: "cancel_pending",
      version: value.version,
    };
  }
  if (
    ["already_done", "done"].includes(value.kind) &&
    validTimestamp(value.completedAt)
  ) {
    return {
      completed: true,
      completedAt: value.completedAt,
      kind: value.kind as "already_done" | "done",
    };
  }
  throw new Error(
    "Simple commitment action repository returned an invalid response",
  );
}

function safeVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

export function cancellationActionReference(
  commitmentId: string,
  version: number,
  action: CancellationConfirmationAction,
): string {
  const value = `x:${commitmentId}:${version}:${action}`;
  if (
    !new RegExp(`^${UUID_PATTERN}$`).test(commitmentId) ||
    !safeVersion(version) ||
    value.length > 64
  ) {
    throw new Error("Invalid cancellation action reference");
  }
  return value;
}

type SupabaseSimpleCommitmentActionRepositoryOptions = {
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

export class SupabaseSimpleCommitmentActionRepository
  implements SimpleCommitmentActionRepository
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseSimpleCommitmentActionRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async resolve(
    command: SimpleCommitmentActionCommand,
  ): Promise<SimpleCommitmentActionResult> {
    const cancellation =
      command.action === "confirm_cancel" ||
      command.action === "keep";
    const rpc = cancellation
      ? "resolve_commitment_cancellation_action"
      : "resolve_simple_reminder_action";
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/${rpc}`,
      {
        body: JSON.stringify({
          p_action: command.action,
          p_commitment_id: command.commitmentId,
          p_owner_chat_id: command.chatId,
          p_owner_id: this.#ownerId,
          p_update_id: command.updateId,
          p_version: command.version,
        }),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Simple commitment action transition failed");
    }
    return parseActionResult(await response.json());
  }
}

type SimpleCommitmentActionServiceOptions = {
  repository: SimpleCommitmentActionRepository;
};

export class SimpleCommitmentActionService {
  readonly #repository: SimpleCommitmentActionRepository;

  constructor(options: SimpleCommitmentActionServiceOptions) {
    this.#repository = options.repository;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const action = parseSimpleCommitmentAction(callbackData);
    let result: SimpleCommitmentActionResult;
    try {
      result = await this.#repository.resolve({
        action: action?.action ?? null,
        chatId,
        commitmentId: action?.commitmentId ?? null,
        updateId,
        version: action?.version ?? null,
      });
    } catch {
      return { text: simpleCommitmentActionCopy.uncertain };
    }

    switch (result.kind) {
      case "replay":
        return null;
      case "malformed":
        return { text: simpleCommitmentActionCopy.malformed };
      case "stale":
        return { text: simpleCommitmentActionCopy.stale };
      case "already_cancelled":
        return { text: simpleCommitmentActionCopy.alreadyCancelled };
      case "cancelled":
        return { text: simpleCommitmentActionCopy.cancelled };
      case "kept":
        return { text: simpleCommitmentActionCopy.kept };
      case "cancel_pending":
        return {
          actions: [
            {
              callbackData: cancellationActionReference(
                result.commitmentId,
                result.version,
                "confirm_cancel",
              ),
              text: "Confirm cancellation",
            },
            {
              callbackData: cancellationActionReference(
                result.commitmentId,
                result.version,
                "keep",
              ),
              text: "Keep",
            },
          ],
          text: simpleCommitmentActionCopy.cancelPrompt,
        };
      case "already_done":
        return { text: simpleCommitmentActionCopy.alreadyDone };
      case "done":
        return { text: simpleCommitmentActionCopy.done };
    }
  }
}
