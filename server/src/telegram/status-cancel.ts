import {
  formatSingaporeTarget,
  type TelegramReply,
} from "../confirmation.js";
import { simpleReminderActionReference } from "../scheduler/scheduler.js";
import { supabaseHeaders } from "../supabase.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SINGAPORE_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1_000;

export type ActivePromiseStatus = Readonly<{
  calendarCheckedAt: string | null;
  calendarStatus: "conflict_kept" | "free" | "unverified" | null;
  definitionOfDone: string;
  id: string;
  nextAt: string | null;
  nextKind: "simple_reminder" | "work_session" | null;
  targetAt: string;
}>;

export interface StatusRepository {
  listActive(): Promise<readonly ActivePromiseStatus[]>;
}

type SupabaseStatusRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

type StatusServiceOptions = Readonly<{
  now?: () => Date;
  repository: StatusRepository;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

function parseStatus(value: unknown): ActivePromiseStatus {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.definitionOfDone !== "string" ||
    value.definitionOfDone.trim().length === 0 ||
    value.definitionOfDone.length > 500 ||
    !validInstant(value.targetAt) ||
    !(
      value.nextAt === null ||
      validInstant(value.nextAt)
    ) ||
    ![null, "simple_reminder", "work_session"].includes(
      value.nextKind as null | string,
    ) ||
    ![null, "conflict_kept", "free", "unverified"].includes(
      value.calendarStatus as null | string,
    ) ||
    !(
      value.calendarCheckedAt === null ||
      validInstant(value.calendarCheckedAt)
    )
  ) {
    throw new Error("Telegram status returned invalid data");
  }
  if (
    (value.nextKind === null) !== (value.nextAt === null) ||
    (value.calendarStatus === null) !==
      (value.nextKind !== "work_session") ||
    (
      value.calendarStatus === "unverified" &&
      value.calendarCheckedAt !== null
    ) ||
    (
      ["free", "conflict_kept"].includes(String(value.calendarStatus)) &&
      value.calendarCheckedAt === null
    )
  ) {
    throw new Error("Telegram status returned inconsistent data");
  }
  return value as ActivePromiseStatus;
}

function singaporeInstant(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error("Invalid status instant");
  }
  return `${new Date(millis + SINGAPORE_OFFSET_MILLISECONDS)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

function formattedInstant(value: string): string {
  return formatSingaporeTarget(singaporeInstant(value));
}

function nextCopy(status: ActivePromiseStatus): string {
  if (status.nextKind === "simple_reminder" && status.nextAt) {
    return `Simple reminder at ${formattedInstant(status.nextAt)}.`;
  }
  if (status.nextKind === "work_session" && status.nextAt) {
    return `Work session at ${formattedInstant(status.nextAt)}.`;
  }
  return "None scheduled.";
}

function calendarCopy(status: ActivePromiseStatus): string {
  if (status.calendarStatus === null) {
    return "Not applicable.";
  }
  if (status.calendarStatus === "unverified") {
    return "Not checked (saved without a Calendar check).";
  }
  const checkedAt = status.calendarCheckedAt;
  if (!checkedAt) {
    throw new Error("Checked Calendar status is missing its time");
  }
  return status.calendarStatus === "free"
    ? `Free when checked at ${formattedInstant(checkedAt)}.`
    : `Conflict kept when checked at ${formattedInstant(checkedAt)}.`;
}

export function statusReplies(
  statuses: readonly ActivePromiseStatus[],
  now: Date,
): readonly TelegramReply[] {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid status observation time");
  }
  const ordered = [...statuses].sort(
    (left, right) =>
      Date.parse(left.targetAt) - Date.parse(right.targetAt) ||
      left.id.localeCompare(right.id),
  );
  return ordered.map((status, index) => ({
    actions: [
      {
        callbackData: simpleReminderActionReference(
          status.id,
          1,
          "done",
        ),
        text: "Done",
      },
      {
        callbackData: simpleReminderActionReference(
          status.id,
          1,
          "cancel",
        ),
        text: "Cancel",
      },
    ],
    text: [
      `Promise ${index + 1} of ${ordered.length}`,
      "",
      `Definition of done: ${status.definitionOfDone}`,
      `Target: ${formattedInstant(status.targetAt)}`,
      `Status: ${
        Date.parse(status.targetAt) < now.getTime()
          ? "Overdue"
          : "Active"
      }`,
      `Next: ${nextCopy(status)}`,
      `Calendar check: ${calendarCopy(status)}`,
    ].join("\n"),
  }));
}

export class SupabaseStatusRepository implements StatusRepository {
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseStatusRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async listActive(): Promise<readonly ActivePromiseStatus[]> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/list_active_commitment_status`,
      {
        body: JSON.stringify({ p_owner_id: this.#ownerId }),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Telegram status read failed");
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw new Error("Telegram status returned invalid data");
    }
    return value.map(parseStatus);
  }
}

export class StatusService {
  readonly #now: () => Date;
  readonly #repository: StatusRepository;

  constructor(options: StatusServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository;
  }

  async read(): Promise<readonly TelegramReply[]> {
    return statusReplies(await this.#repository.listActive(), this.#now());
  }
}
