import type {
  DecisionContextFields,
  DecisionResult,
} from "./decision/schema.js";
import { supabaseHeaders } from "./supabase.js";

export type DraftAction = "cancel" | "confirm";

export type DraftReference = {
  id: string;
  version: number;
};

export type TelegramInlineAction = {
  callbackData: string;
  text: string;
};

export type TelegramReply = {
  actions?: readonly TelegramInlineAction[];
  text: string;
};

type CompleteDraftFields = Pick<
  DecisionContextFields,
  "definitionOfDone" | "targetAt"
>;

export type ConfirmationApprovalPreparation = Readonly<{
  chatId: number;
  decision: DecisionResult;
  draft: DraftReference;
  updateId: number;
}>;

type ParsedDraftAction = DraftReference & {
  action: DraftAction;
};

type ConfirmationCommand = {
  action: DraftAction | null;
  chatId: number;
  draftId: string | null;
  updateId: number;
  version: number | null;
};

type StoredCompleteDraft = {
  definitionOfDone: string;
  id: string;
  targetAt: string;
  version: number;
};

export type ConfirmationResult =
  | { kind: "replay" }
  | {
      completed: true;
      kind:
        | "already_cancelled"
        | "already_confirmed"
        | "cancelled"
        | "expired"
        | "malformed";
    }
  | {
      completed: true;
      kind: "confirmed";
      reminderAt: string;
    }
  | {
      completed: true;
      draft: StoredCompleteDraft;
      kind: "stale";
    };

export interface ConfirmationRepository {
  resolve(command: ConfirmationCommand): Promise<ConfirmationResult>;
}

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACTION_PATTERN = new RegExp(
  `^d:(${UUID_PATTERN}):([1-9][0-9]*):(confirm|cancel)$`,
);
const TARGET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const confirmationCopy = {
  alreadyCancelled:
    "That draft was already cancelled. Nothing was saved.",
  alreadyConfirmed:
    "That promise was already saved. I didn’t create another promise or reminder.",
  cancelled: "Draft cancelled. Nothing was saved.",
  correctionIncomplete:
    "I need the corrected promise to include both what counts as done and when it should be done. I didn’t change the current draft.",
  expired:
    "That draft expired after 24 hours of inactivity. Nothing was saved. Please send the promise again to start over.",
  malformed: "That action isn’t valid. I didn’t change anything.",
  approvalUnavailable:
    "I couldn’t safely prepare confirmation. Nothing was saved. Send another message to continue this draft.",
  secondRequest:
    "You already have a complete draft. I didn’t replace it.",
  stale: "That action is stale. I didn’t change anything.",
  uncertainCancel:
    "I couldn’t confirm whether the draft was cancelled. Please press Cancel again.",
  uncertainConfirm:
    "I couldn’t confirm whether the promise was saved. Please press Confirm again.",
  updated: "Updated.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${UUID_PATTERN}$`).test(value)
  );
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

export function parseDraftAction(value: unknown): ParsedDraftAction | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match = ACTION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) {
    return null;
  }
  return {
    action: match[3] as DraftAction,
    id: match[1],
    version,
  };
}

export function draftActionReference(
  reference: DraftReference,
  action: DraftAction,
): string {
  const value = `d:${reference.id}:${reference.version}:${action}`;
  const parsed = parseDraftAction(value);
  if (
    !parsed ||
    parsed.id !== reference.id ||
    parsed.version !== reference.version ||
    parsed.action !== action
  ) {
    throw new Error("Invalid draft action reference");
  }
  return value;
}

export function formatSingaporeTarget(value: string): string {
  const match = TARGET_PATTERN.exec(value);
  if (!match) {
    throw new Error("Invalid Singapore target");
  }
  const [, year, month, day, hour, minute, second] = match;
  const monthIndex = Number(month) - 1;
  const hourNumber = Number(hour);
  const dayNumber = Number(day);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const date = new Date(
    Date.UTC(
      Number(year),
      monthIndex,
      dayNumber,
      hourNumber - 8,
      minuteNumber,
      secondNumber,
    ),
  );
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  if (
    !Number.isFinite(date.getTime()) ||
    monthIndex < 0 ||
    monthIndex > 11 ||
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() !== monthIndex ||
    local.getUTCDate() !== dayNumber ||
    local.getUTCHours() !== hourNumber ||
    local.getUTCMinutes() !== minuteNumber ||
    local.getUTCSeconds() !== secondNumber
  ) {
    throw new Error("Invalid Singapore target");
  }

  const meridiem = hourNumber >= 12 ? "PM" : "AM";
  const displayHour = hourNumber % 12 || 12;
  const seconds = secondNumber === 0 ? "" : `:${second}`;
  return `${dayNumber} ${MONTHS[monthIndex]} ${year} at ${displayHour}:${minute}${seconds} ${meridiem} SGT (UTC+08:00)`;
}

function completeFields(
  fields: CompleteDraftFields,
): { definitionOfDone: string; targetAt: string } {
  if (
    typeof fields.definitionOfDone !== "string" ||
    typeof fields.targetAt !== "string"
  ) {
    throw new Error("Complete confirmation fields are required");
  }
  return {
    definitionOfDone: fields.definitionOfDone,
    targetAt: fields.targetAt,
  };
}

export function confirmationSummary(
  fields: CompleteDraftFields,
  reference: DraftReference,
  prefix?: string,
): TelegramReply {
  const complete = completeFields(fields);
  const target = formatSingaporeTarget(complete.targetAt);
  const summary = [
    "Please confirm this promise.",
    "",
    `Definition of done: ${complete.definitionOfDone}`,
    `Target: ${target}`,
    `Reminder: ${target}`,
    "Calendar availability: Not checked.",
    "Google Calendar will not be changed.",
    "Nothing has been saved yet.",
  ].join("\n");

  return {
    actions: [
      {
        callbackData: draftActionReference(reference, "confirm"),
        text: "Confirm",
      },
      {
        callbackData: draftActionReference(reference, "cancel"),
        text: "Cancel",
      },
    ],
    text: prefix ? `${prefix}\n\n${summary}` : summary,
  };
}

function parseStoredDraft(value: unknown): StoredCompleteDraft | null {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    !positiveInteger(value.version) ||
    typeof value.definitionOfDone !== "string" ||
    value.definitionOfDone.trim().length === 0 ||
    typeof value.targetAt !== "string"
  ) {
    return null;
  }
  try {
    formatSingaporeTarget(value.targetAt);
  } catch {
    return null;
  }
  return {
    definitionOfDone: value.definitionOfDone,
    id: value.id,
    targetAt: value.targetAt,
    version: value.version,
  };
}

function parseConfirmationResult(value: unknown): ConfirmationResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Confirmation repository returned an invalid response");
  }
  if (value.kind === "replay") {
    return { kind: "replay" };
  }
  if (value.completed !== true) {
    throw new Error("Confirmation update was not completed");
  }
  if (
    [
      "already_cancelled",
      "already_confirmed",
      "cancelled",
      "expired",
      "malformed",
    ].includes(value.kind)
  ) {
    return {
      completed: true,
      kind: value.kind as
        | "already_cancelled"
        | "already_confirmed"
        | "cancelled"
        | "expired"
        | "malformed",
    };
  }
  if (value.kind === "confirmed" && typeof value.reminderAt === "string") {
    formatSingaporeTarget(value.reminderAt);
    return {
      completed: true,
      kind: "confirmed",
      reminderAt: value.reminderAt,
    };
  }
  if (value.kind === "stale") {
    const draft = parseStoredDraft(value.draft);
    if (draft) {
      return {
        completed: true,
        draft,
        kind: "stale",
      };
    }
  }
  throw new Error("Confirmation repository returned an invalid response");
}

type SupabaseConfirmationRepositoryOptions = {
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

export class SupabaseConfirmationRepository
  implements ConfirmationRepository
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseConfirmationRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async resolve(command: ConfirmationCommand): Promise<ConfirmationResult> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/resolve_simple_draft_action`,
      {
        body: JSON.stringify({
          p_action: command.action,
          p_draft_id: command.draftId,
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
      throw new Error("Confirmation transition failed");
    }
    return parseConfirmationResult(await response.json());
  }
}

type ConfirmationServiceOptions = {
  prepareApproval?: (
    request: ConfirmationApprovalPreparation,
  ) => Promise<boolean>;
  repository: ConfirmationRepository;
};

export class ConfirmationService {
  readonly #prepareApproval:
    | ConfirmationServiceOptions["prepareApproval"]
    | undefined;
  readonly #repository: ConfirmationRepository;

  constructor(options: ConfirmationServiceOptions) {
    this.#prepareApproval = options.prepareApproval;
    this.#repository = options.repository;
  }

  async handle(
    updateId: number,
    chatId: number,
    callbackData: unknown,
  ): Promise<TelegramReply | null> {
    const action = parseDraftAction(callbackData);
    let result: ConfirmationResult;
    try {
      result = await this.#repository.resolve({
        action: action?.action ?? null,
        chatId,
        draftId: action?.id ?? null,
        updateId,
        version: action?.version ?? null,
      });
    } catch {
      return {
        text:
          action?.action === "cancel"
            ? confirmationCopy.uncertainCancel
            : action?.action === "confirm"
              ? confirmationCopy.uncertainConfirm
              : confirmationCopy.malformed,
      };
    }

    switch (result.kind) {
      case "replay":
        return null;
      case "malformed":
        return { text: confirmationCopy.malformed };
      case "expired":
        return { text: confirmationCopy.expired };
      case "already_cancelled":
        return { text: confirmationCopy.alreadyCancelled };
      case "already_confirmed":
        return { text: confirmationCopy.alreadyConfirmed };
      case "cancelled":
        return { text: confirmationCopy.cancelled };
      case "confirmed":
        return {
          text: `Promise saved. I’ll remind you at ${formatSingaporeTarget(result.reminderAt)}.`,
        };
      case "stale": {
        if (this.#prepareApproval) {
          let prepared = false;
          try {
            prepared = await this.#prepareApproval({
              chatId,
              decision: {
                commitmentMode: "simple_action",
                definitionOfDone: result.draft.definitionOfDone,
                durationMinutes: null,
                inputClass: "explicit_commitment",
                missingFields: [],
                nextAction: "ready",
                offerWorkWindowHelp: false,
                response: "",
                targetAt: result.draft.targetAt,
                targetTimeZone: "Asia/Singapore",
                timingConstraints: [],
                turnRelation: "correction",
              },
              draft: result.draft,
              updateId,
            });
          } catch {
            prepared = false;
          }
          if (!prepared) {
            return { text: confirmationCopy.approvalUnavailable };
          }
        }
        return confirmationSummary(
          result.draft,
          result.draft,
          confirmationCopy.stale,
        );
      }
    }
  }
}
