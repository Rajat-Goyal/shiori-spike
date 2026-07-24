import type { TelegramReply } from "../confirmation.js";
import { supabaseHeaders } from "../supabase.js";

export type WorkSessionOutcomeAction = "done" | "missed" | "more";

type ParsedWorkSessionOutcome = Readonly<{
  action: WorkSessionOutcomeAction;
  sessionId: string;
  version: number;
}>;

type WorkSessionOutcomeCommand = Readonly<{
  action: WorkSessionOutcomeAction | null;
  chatId: number;
  sessionId: string | null;
  updateId: number;
  version: number | null;
}>;

export type WorkSessionOutcomeResult =
  | Readonly<{ kind: "replay" }>
  | Readonly<{
      completed: true;
      kind: "already_done" | "done" | "malformed" | "stale";
    }>
  | Readonly<{
      completed: true;
      continuationId: string;
      continuationVersion: number;
      kind: "missed" | "more";
    }>;

export interface WorkSessionOutcomeRepository {
  resolve(
    command: WorkSessionOutcomeCommand,
  ): Promise<WorkSessionOutcomeResult>;
}

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTION_PATTERN = new RegExp(
  `^s:(${UUID_PATTERN}):([1-9][0-9]*):(done|more|missed)$`,
);

export const workSessionOutcomeCopy = {
  alreadyDone: "That promise is already complete.",
  done: "Promise completed.",
  malformed: "That action isn’t valid. Nothing was changed.",
  missed:
    "No work recorded for this session. Would you like another work window?",
  more:
    "Partial work recorded. How much focused time remains?",
  stale: "That action is stale. Nothing was changed.",
  uncertain:
    "I couldn’t confirm whether that outcome was recorded. Please check /status before trying again.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

export function parseWorkSessionOutcome(
  value: unknown,
): ParsedWorkSessionOutcome | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match = ACTION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const version = Number(match[2]);
  return positiveInteger(version)
    ? {
        action: match[3] as WorkSessionOutcomeAction,
        sessionId: match[1],
        version,
      }
    : null;
}

function parseResult(value: unknown): WorkSessionOutcomeResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Work-session outcome returned invalid data");
  }
  if (value.kind === "replay") {
    return { kind: "replay" };
  }
  if (value.completed !== true) {
    throw new Error("Work-session outcome was not completed");
  }
  if (
    ["already_done", "done", "malformed", "stale"].includes(value.kind)
  ) {
    return {
      completed: true,
      kind: value.kind as
        | "already_done"
        | "done"
        | "malformed"
        | "stale",
    };
  }
  if (
    ["missed", "more"].includes(value.kind) &&
    typeof value.continuationId === "string" &&
    new RegExp(`^${UUID_PATTERN}$`).test(value.continuationId) &&
    positiveInteger(value.continuationVersion)
  ) {
    return {
      completed: true,
      continuationId: value.continuationId,
      continuationVersion: value.continuationVersion,
      kind: value.kind as "missed" | "more",
    };
  }
  throw new Error("Work-session outcome returned invalid data");
}

export function continuationActionReference(
  continuationId: string,
  version: number,
  action:
    | "another"
    | "decline"
    | "duration_30"
    | "duration_60"
    | "duration_90"
    | "duration_120",
): string {
  const value = `c:${continuationId}:${version}:${action}`;
  if (
    !new RegExp(`^${UUID_PATTERN}$`).test(continuationId) ||
    !positiveInteger(version) ||
    value.length > 64
  ) {
    throw new Error("Invalid continuation action reference");
  }
  return value;
}

type SupabaseWorkSessionOutcomeRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

export class SupabaseWorkSessionOutcomeRepository
  implements WorkSessionOutcomeRepository
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseWorkSessionOutcomeRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async resolve(
    command: WorkSessionOutcomeCommand,
  ): Promise<WorkSessionOutcomeResult> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/resolve_work_session_outcome`,
      {
        body: JSON.stringify({
          p_action: command.action,
          p_owner_chat_id: command.chatId,
          p_owner_id: this.#ownerId,
          p_update_id: command.updateId,
          p_version: command.version,
          p_work_session_id: command.sessionId,
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
      throw new Error("Work-session outcome transition failed");
    }
    return parseResult(await response.json());
  }
}

type WorkSessionOutcomeServiceOptions = Readonly<{
  repository: WorkSessionOutcomeRepository;
}>;

function continuationAction(
  result: Extract<WorkSessionOutcomeResult, { kind: "missed" | "more" }>,
  action: Parameters<typeof continuationActionReference>[2],
  text: string,
) {
  return {
    callbackData: continuationActionReference(
      result.continuationId,
      result.continuationVersion,
      action,
    ),
    text,
  };
}

export class WorkSessionOutcomeService {
  readonly #repository: WorkSessionOutcomeRepository;

  constructor(options: WorkSessionOutcomeServiceOptions) {
    this.#repository = options.repository;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const parsed = parseWorkSessionOutcome(callbackData);
    let result: WorkSessionOutcomeResult;
    try {
      result = await this.#repository.resolve({
        action: parsed?.action ?? null,
        chatId,
        sessionId: parsed?.sessionId ?? null,
        updateId,
        version: parsed?.version ?? null,
      });
    } catch {
      return { text: workSessionOutcomeCopy.uncertain };
    }

    switch (result.kind) {
      case "replay":
        return null;
      case "malformed":
        return { text: workSessionOutcomeCopy.malformed };
      case "stale":
        return { text: workSessionOutcomeCopy.stale };
      case "already_done":
        return { text: workSessionOutcomeCopy.alreadyDone };
      case "done":
        return { text: workSessionOutcomeCopy.done };
      case "more":
        return {
          actions: ([30, 60, 90, 120] as const).map((duration) =>
            continuationAction(
              result,
              `duration_${duration}`,
              `${duration} min`,
            )
          ),
          text: workSessionOutcomeCopy.more,
        };
      case "missed":
        return {
          actions: [
            continuationAction(result, "another", "Find another window"),
            continuationAction(result, "decline", "Not now"),
          ],
          text: workSessionOutcomeCopy.missed,
        };
    }
  }
}
