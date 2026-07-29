import { z } from "zod";

import {
  formatSingaporeTarget,
  type TelegramReply,
} from "../confirmation.js";
import { supabaseHeaders } from "../supabase.js";
import {
  MAX_WORK_SESSION_DURATION_MINUTES,
  MIN_WORK_SESSION_DURATION_MINUTES,
  isWorkSessionWindow,
} from "../work-sessions/duration.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SINGAPORE_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1_000;

export const commitmentEditSchema = z
  .object({
    calendarPolicy: z
      .object({
        conflict: z.enum(["reject", "keep"]),
        unavailable: z.enum(["reject", "save_unverified"]),
      })
      .strict(),
    commitmentId: z.string().uuid(),
    definitionOfDone: z.string().trim().min(1).max(500),
    expectedVersion: z.number().int().positive(),
    preparation: z
      .object({
        nextWorkSession: z
          .object({
            durationMinutes: z.number().int()
              .min(MIN_WORK_SESSION_DURATION_MINUTES)
              .max(MAX_WORK_SESSION_DURATION_MINUTES),
            endAt: z.string().datetime({ offset: true }),
            startAt: z.string().datetime({ offset: true }),
            timingConstraints: z.string().trim().min(1).max(500),
          })
          .strict()
          .nullable(),
        required: z.boolean(),
      })
      .strict(),
    targetAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const session = value.preparation.nextWorkSession;
    if (value.preparation.required !== (session !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "Preparation and the next work session must be changed together",
        path: ["preparation"],
      });
      return;
    }
    if (session === null) {
      return;
    }
    const start = Date.parse(session.startAt);
    const end = Date.parse(session.endAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      !isWorkSessionWindow(
        session.startAt,
        session.endAt,
        session.durationMinutes,
      ) ||
      end > Date.parse(value.targetAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "The next work-session window is invalid",
        path: ["preparation", "nextWorkSession"],
      });
    }
  });

export type CommitmentEditProposal = z.infer<
  typeof commitmentEditSchema
>;

export type ApprovedCommitmentChangeAuthority = Readonly<{
  chatId: number;
  commitmentId: string;
  expectedVersion: number;
  updateId: number;
}>;

export type CommitmentCalendarVerification =
  | Readonly<{
      attemptedAt: string;
      checkedAt: string;
      status: "conflict" | "free";
    }>
  | Readonly<{
      attemptedAt: string;
      checkedAt: null;
      status: "unavailable";
    }>;

export interface CommitmentCalendarVerifier {
  verify(
    window: Readonly<{ endAt: string; startAt: string }>,
  ): Promise<CommitmentCalendarVerification>;
}

export type CommitmentChangeApplyCommand = Readonly<{
  authority: ApprovedCommitmentChangeAuthority;
  calendar: Readonly<{
    attemptedAt: string | null;
    checkedAt: string | null;
    conflictConsent: boolean;
    finalObservation: "conflict" | "free" | "unavailable" | null;
    status: "conflict_kept" | "free" | "not_applicable" | "unverified";
  }>;
  proposal: CommitmentEditProposal;
}>;

export type CommitmentChangeApplyResult =
  | Readonly<{ kind: "applied"; version: number }>
  | Readonly<{
      kind:
        | "in_progress"
        | "missing"
        | "replay"
        | "stale"
        | "terminal"
        | "unchanged";
    }>;

export interface CommitmentChangeRepository {
  apply(
    command: CommitmentChangeApplyCommand,
  ): Promise<CommitmentChangeApplyResult>;
}

export type ApprovedCommitmentChangeResult = Readonly<{
  reply: TelegramReply;
  status: "executed" | "replay";
}>;

export const commitmentChangeCopy = {
  applied: "Promise updated.",
  calendarConflict:
    "That time now conflicts with Google Calendar. Nothing was changed. Ask me to keep the time anyway if that is what you want.",
  calendarUnavailable:
    "I couldn’t verify Google Calendar. Nothing was changed. Ask me to save it without verification if that is what you want.",
  malformed: "That change approval isn’t valid. Nothing was changed.",
  missing: "That promise is unavailable. Nothing was changed.",
  inProgress:
    "That promise has a work session in progress. Nothing was changed.",
  rejected: "Change rejected. Nothing was changed.",
  replay: "That exact change was already applied. I didn’t apply it again.",
  stale:
    "That change is stale because the promise changed after the preview. Nothing was changed.",
  terminal:
    "Completed or cancelled promises stay closed. Nothing was changed.",
  unchanged: "That preview no longer changes anything. Nothing was changed.",
  uncertain:
    "I couldn’t safely apply that change. Nothing was changed. Check /status before trying again.",
} as const;

export type CommitmentEditApprovalAction = "approve" | "reject";

export type ParsedCommitmentEditApproval = Readonly<{
  action: CommitmentEditApprovalAction;
  commitmentId: string;
  version: number;
}>;

const EDIT_ACTION_PATTERN = new RegExp(
  `^e:(${UUID_PATTERN.source.slice(1, -1)}):([1-9][0-9]*):(approve|reject)$`,
);

export function parseCommitmentEditApproval(
  value: unknown,
): ParsedCommitmentEditApproval | null {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const match = EDIT_ACTION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const version = Number(match[2]);
  return Number.isSafeInteger(version)
    ? {
        action: match[3] as CommitmentEditApprovalAction,
        commitmentId: match[1]!,
        version,
      }
    : null;
}

export function commitmentEditApprovalReference(
  proposal: Pick<
    CommitmentEditProposal,
    "commitmentId" | "expectedVersion"
  >,
  action: CommitmentEditApprovalAction,
): string {
  const value =
    `e:${proposal.commitmentId}:${proposal.expectedVersion}:${action}`;
  const parsed = parseCommitmentEditApproval(value);
  if (
    parsed === null ||
    parsed.commitmentId !== proposal.commitmentId ||
    parsed.version !== proposal.expectedVersion ||
    parsed.action !== action
  ) {
    throw new Error("Invalid commitment edit approval reference");
  }
  return value;
}

function singaporeDisplay(value: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new Error("Invalid commitment edit instant");
  }
  return formatSingaporeTarget(
    `${new Date(instant + SINGAPORE_OFFSET_MILLISECONDS)
      .toISOString()
      .slice(0, 19)}+08:00`,
  );
}

export function commitmentEditPreview(
  input: CommitmentEditProposal,
): TelegramReply {
  const proposal = commitmentEditSchema.parse(input);
  const session = proposal.preparation.nextWorkSession;
  const preparation = session
    ? [
        "Preparation: Needed.",
        `Next work session: ${singaporeDisplay(session.startAt)} for ${session.durationMinutes} minutes.`,
        `Timing constraints: ${session.timingConstraints}`,
        "Calendar: Will be rechecked immediately before this change is saved.",
        `If busy: ${
          proposal.calendarPolicy.conflict === "keep"
            ? "Keep the approved time."
            : "Do not save."
        }`,
        `If Calendar is unavailable: ${
          proposal.calendarPolicy.unavailable === "save_unverified"
            ? "Save as unverified."
            : "Do not save."
        }`,
      ]
    : [
        "Preparation: Not needed.",
        "Next work session: None.",
        "Calendar: Not applicable.",
      ];
  return {
    actions: [
      {
        callbackData: commitmentEditApprovalReference(
          proposal,
          "approve",
        ),
        text: "Approve change",
      },
      {
        callbackData: commitmentEditApprovalReference(
          proposal,
          "reject",
        ),
        text: "Reject",
      },
    ],
    text: [
      "Please approve this exact promise change.",
      "",
      `Definition of done: ${proposal.definitionOfDone}`,
      `Target: ${singaporeDisplay(proposal.targetAt)}`,
      ...preparation,
      "Google Calendar will not be changed.",
      "Nothing has been changed yet.",
    ].join("\n"),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseApplyResult(value: unknown): CommitmentChangeApplyResult {
  const item = record(value);
  if (
    !item ||
    ![
      "applied",
      "in_progress",
      "missing",
      "replay",
      "stale",
      "terminal",
      "unchanged",
    ].includes(String(item.kind))
  ) {
    throw new Error("Commitment change returned invalid data");
  }
  if (item.kind !== "applied") {
    return {
      kind: item.kind as Exclude<
        CommitmentChangeApplyResult["kind"],
        "applied"
      >,
    };
  }
  if (
    typeof item.version !== "number" ||
    !Number.isSafeInteger(item.version) ||
    item.version < 2
  ) {
    throw new Error("Commitment change returned invalid data");
  }
  return { kind: "applied", version: item.version };
}

type SupabaseCommitmentChangeRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  ownerId: number;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

export class SupabaseCommitmentChangeRepository
  implements CommitmentChangeRepository
{
  readonly #fetch: typeof fetch;
  readonly #ownerId: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseCommitmentChangeRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerId = String(options.ownerId);
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async apply(
    command: CommitmentChangeApplyCommand,
  ): Promise<CommitmentChangeApplyResult> {
    const proposal = commitmentEditSchema.parse(command.proposal);
    const session = proposal.preparation.nextWorkSession;
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/apply_approved_commitment_change`,
      {
        body: JSON.stringify({
          p_calendar_attempted_at: command.calendar.attemptedAt,
          p_calendar_checked_at: command.calendar.checkedAt,
          p_calendar_status: command.calendar.status,
          p_commitment_id: command.authority.commitmentId,
          p_conflict_consent: command.calendar.conflictConsent,
          p_definition_of_done: proposal.definitionOfDone,
          p_expected_version: command.authority.expectedVersion,
          p_final_observation: command.calendar.finalObservation,
          p_next_duration_minutes: session?.durationMinutes ?? null,
          p_next_end_at: session?.endAt ?? null,
          p_next_start_at: session?.startAt ?? null,
          p_owner_chat_id: command.authority.chatId,
          p_owner_id: this.#ownerId,
          p_preparation_required: proposal.preparation.required,
          p_target_at: proposal.targetAt,
          p_timing_constraints: session?.timingConstraints ?? null,
          p_update_id: command.authority.updateId,
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
      throw new Error("Commitment change failed");
    }
    return parseApplyResult(await response.json());
  }
}

type ApprovedCommitmentChangeServiceOptions = Readonly<{
  calendar: CommitmentCalendarVerifier;
  repository: CommitmentChangeRepository;
}>;

export class ApprovedCommitmentChangeService {
  readonly #calendar: CommitmentCalendarVerifier;
  readonly #repository: CommitmentChangeRepository;

  constructor(options: ApprovedCommitmentChangeServiceOptions) {
    this.#calendar = options.calendar;
    this.#repository = options.repository;
  }

  async apply(
    authority: ApprovedCommitmentChangeAuthority,
    input: CommitmentEditProposal,
  ): Promise<ApprovedCommitmentChangeResult> {
    const parsed = commitmentEditSchema.safeParse(input);
    if (
      !parsed.success ||
      !Number.isSafeInteger(authority.chatId) ||
      authority.chatId === 0 ||
      !UUID_PATTERN.test(authority.commitmentId) ||
      !Number.isSafeInteger(authority.expectedVersion) ||
      authority.expectedVersion < 1 ||
      !Number.isSafeInteger(authority.updateId) ||
      authority.updateId < 1 ||
      parsed.data.commitmentId !== authority.commitmentId ||
      parsed.data.expectedVersion !== authority.expectedVersion
    ) {
      return {
        reply: { text: commitmentChangeCopy.malformed },
        status: "executed",
      };
    }

    const session = parsed.data.preparation.nextWorkSession;
    let calendar: CommitmentChangeApplyCommand["calendar"] = {
      attemptedAt: null,
      checkedAt: null,
      conflictConsent: false,
      finalObservation: null,
      status: "not_applicable",
    };
    if (session !== null) {
      let verification: CommitmentCalendarVerification;
      try {
        verification = await this.#calendar.verify(session);
      } catch {
        verification = {
          attemptedAt: new Date().toISOString(),
          checkedAt: null,
          status: "unavailable",
        };
      }
      if (
        verification.status === "conflict" &&
        parsed.data.calendarPolicy.conflict !== "keep"
      ) {
        return {
          reply: { text: commitmentChangeCopy.calendarConflict },
          status: "executed",
        };
      }
      if (
        verification.status === "unavailable" &&
        parsed.data.calendarPolicy.unavailable !== "save_unverified"
      ) {
        return {
          reply: { text: commitmentChangeCopy.calendarUnavailable },
          status: "executed",
        };
      }
      calendar =
        verification.status === "unavailable"
          ? {
              attemptedAt: verification.attemptedAt,
              checkedAt: null,
              conflictConsent: false,
              finalObservation: "unavailable",
              status: "unverified",
            }
          : {
              attemptedAt: verification.attemptedAt,
              checkedAt: verification.checkedAt,
              conflictConsent: verification.status === "conflict",
              finalObservation: verification.status,
              status:
                verification.status === "conflict"
                  ? "conflict_kept"
                  : "free",
            };
    }

    let result: CommitmentChangeApplyResult;
    try {
      result = await this.#repository.apply({
        authority,
        calendar,
        proposal: parsed.data,
      });
    } catch {
      return {
        reply: { text: commitmentChangeCopy.uncertain },
        status: "executed",
      };
    }
    switch (result.kind) {
      case "applied":
        return {
          reply: {
            text: [
              commitmentChangeCopy.applied,
              session === null
                ? "Preparation is not needed."
                : calendar.status === "unverified"
                  ? "The next work session was saved without Calendar verification."
                  : calendar.status === "conflict_kept"
                    ? "The approved Calendar conflict was kept."
                    : "The next work session was free when rechecked.",
            ].join(" "),
          },
          status: "executed",
        };
      case "replay":
        return {
          reply: { text: commitmentChangeCopy.replay },
          status: "replay",
        };
      case "missing":
        return {
          reply: { text: commitmentChangeCopy.missing },
          status: "executed",
        };
      case "in_progress":
        return {
          reply: { text: commitmentChangeCopy.inProgress },
          status: "executed",
        };
      case "stale":
        return {
          reply: { text: commitmentChangeCopy.stale },
          status: "executed",
        };
      case "terminal":
        return {
          reply: { text: commitmentChangeCopy.terminal },
          status: "executed",
        };
      case "unchanged":
        return {
          reply: { text: commitmentChangeCopy.unchanged },
          status: "executed",
        };
    }
  }
}
