import { randomUUID } from "node:crypto";
import { supabaseHeaders } from "../supabase.js";
import type { AgentSessionCipher } from "./session-crypto.js";
import type {
  AgentApprovalReadResult,
  AgentApprovalRepository,
  AgentApprovalResolveCommand,
  AgentApprovalResolveResult,
  AgentApprovalStageCommand,
  AgentApprovalStageResult,
  AgentApprovalToolName,
  AgentPendingApprovalSnapshot,
  AgentSessionClearCommand,
  AgentSessionClearResult,
  AgentSessionReadResult,
  AgentSessionRecordCommand,
  AgentSessionRecordResult,
  AgentSessionRepository,
  AgentSessionSnapshot,
  AgentSessionTurn,
} from "./session.js";

type SupabaseRepositoryOptions = Readonly<{
  fetch?: typeof fetch;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

type SupabaseAgentSessionRepositoryOptions =
  SupabaseRepositoryOptions &
    Readonly<{
      cipher: AgentSessionCipher;
      createSessionId?: () => string;
    }>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeInteger(value: unknown, positive = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (!positive || value > 0)
  );
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function turnPlaintext(value: string): {
  assistantText: string;
  ownerText: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent session persistence returned invalid data");
  }
  const item = record(parsed);
  if (
    !item ||
    Object.keys(item).sort().join(",") !== "assistantText,ownerText" ||
    typeof item.assistantText !== "string" ||
    typeof item.ownerText !== "string"
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return {
    assistantText: item.assistantText,
    ownerText: item.ownerText,
  };
}

function sessionSnapshot(
  value: unknown,
  cipher: AgentSessionCipher,
): AgentSessionSnapshot {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.id) ||
    !safeInteger(item.chatId) ||
    !safeInteger(item.version, true) ||
    !instant(item.expiresAt) ||
    !(
      item.activeDraftId === null ||
      nonempty(item.activeDraftId)
    ) ||
    !Array.isArray(item.turns) ||
    item.turns.length < 1 ||
    item.turns.length > 6
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }

  const turns: AgentSessionTurn[] = item.turns.map((value) => {
    const turn = record(value);
    if (
      !turn ||
      !safeInteger(turn.updateId) ||
      !instant(turn.recordedAt) ||
      !nonempty(turn.sealedTurn)
    ) {
      throw new Error("Agent session persistence returned invalid data");
    }
    let plaintext: string;
    try {
      plaintext = cipher.open(turn.sealedTurn, {
        chatId: item.chatId as number,
        sessionId: item.id as string,
        type: "session_turn",
        updateId: turn.updateId,
      });
    } catch {
      throw new Error("Agent session persistence returned invalid data");
    }
    return {
      ...turnPlaintext(plaintext),
      recordedAt: turn.recordedAt,
      updateId: turn.updateId,
    };
  });

  return {
    activeDraftId: item.activeDraftId as string | null,
    chatId: item.chatId,
    expiresAt: item.expiresAt,
    id: item.id,
    turns,
    version: item.version,
  };
}

function sessionReadResult(
  value: unknown,
  cipher: AgentSessionCipher,
): AgentSessionReadResult {
  const item = record(value);
  if (!item || !["active", "expired", "none"].includes(String(item.kind))) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return item.kind === "active"
    ? {
        kind: "active",
        session: sessionSnapshot(item.session, cipher),
      }
    : { kind: item.kind as "expired" | "none" };
}

function sessionRecordResult(
  value: unknown,
  cipher: AgentSessionCipher,
): AgentSessionRecordResult {
  const item = record(value);
  if (!item || !["applied", "replay", "stale"].includes(String(item.kind))) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return item.kind === "applied"
    ? {
        kind: "applied",
        session: sessionSnapshot(item.session, cipher),
      }
    : { kind: item.kind as "replay" | "stale" };
}

function sessionClearResult(value: unknown): AgentSessionClearResult {
  const item = record(value);
  if (
    !item ||
    !["cleared", "none", "replay", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return {
    kind: item.kind as AgentSessionClearResult["kind"],
  };
}

function approvalSnapshot(value: unknown): AgentPendingApprovalSnapshot {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.id) ||
    !safeInteger(item.chatId) ||
    !nonempty(item.sessionId) ||
    !nonempty(item.draftId) ||
    !safeInteger(item.draftVersion, true) ||
    item.toolName !== "execute_commitment" ||
    !nonempty(item.sealedRunState) ||
    !safeInteger(item.version, true) ||
    !instant(item.expiresAt)
  ) {
    throw new Error("Agent approval persistence returned invalid data");
  }
  return {
    chatId: item.chatId,
    draftId: item.draftId,
    draftVersion: item.draftVersion,
    expiresAt: item.expiresAt,
    id: item.id,
    sealedRunState: item.sealedRunState,
    sessionId: item.sessionId,
    toolName: item.toolName,
    version: item.version,
  };
}

function approvalReadResult(value: unknown): AgentApprovalReadResult {
  const item = record(value);
  if (!item || !["current", "expired", "missing"].includes(String(item.kind))) {
    throw new Error("Agent approval persistence returned invalid data");
  }
  return item.kind === "current"
    ? {
        approval: approvalSnapshot(item.approval),
        kind: "current",
      }
    : { kind: item.kind as "expired" | "missing" };
}

function approvalStageResult(value: unknown): AgentApprovalStageResult {
  const item = record(value);
  if (!item || !["replay", "staged", "stale"].includes(String(item.kind))) {
    throw new Error("Agent approval persistence returned invalid data");
  }
  return item.kind === "staged"
    ? {
        approval: approvalSnapshot(item.approval),
        kind: "staged",
      }
    : { kind: item.kind as "replay" | "stale" };
}

function approvalResolveResult(value: unknown): AgentApprovalResolveResult {
  const item = record(value);
  if (
    !item ||
    ![
      "claimed",
      "expired",
      "missing",
      "rejected",
      "replay",
      "stale",
    ].includes(String(item.kind))
  ) {
    throw new Error("Agent approval persistence returned invalid data");
  }
  if (item.kind !== "claimed") {
    return {
      kind: item.kind as Exclude<
        AgentApprovalResolveResult["kind"],
        "claimed"
      >,
    };
  }
  if (!nonempty(item.sealedRunState) || !nonempty(item.sessionId)) {
    throw new Error("Agent approval persistence returned invalid data");
  }
  return {
    kind: "claimed",
    sealedRunState: item.sealedRunState,
    sessionId: item.sessionId,
  };
}

class SupabaseRpcRepository {
  readonly fetch: typeof fetch;
  readonly supabaseSecretKey: string;
  readonly supabaseUrl: string;

  constructor(options: SupabaseRepositoryOptions) {
    this.fetch = options.fetch ?? fetch;
    this.supabaseSecretKey = options.supabaseSecretKey;
    this.supabaseUrl = options.supabaseUrl;
  }

  async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetch(
      `${this.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        body: JSON.stringify(body),
        headers: supabaseHeaders(
          this.supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Agent persistence failed");
    }
    return response.json();
  }
}

export class SupabaseAgentSessionRepository
  extends SupabaseRpcRepository
  implements AgentSessionRepository
{
  readonly #cipher: AgentSessionCipher;
  readonly #createSessionId: () => string;

  constructor(options: SupabaseAgentSessionRepositoryOptions) {
    super(options);
    this.#cipher = options.cipher;
    this.#createSessionId = options.createSessionId ?? randomUUID;
  }

  async clear(
    command: AgentSessionClearCommand,
  ): Promise<AgentSessionClearResult> {
    return sessionClearResult(
      await this.rpc("clear_agent_session", {
        p_chat_id: command.chatId,
        p_expected_session_id: command.expectedSessionId ?? null,
        p_reason: command.reason,
        p_update_id: command.updateId,
      }),
    );
  }

  async read(chatId: number): Promise<AgentSessionReadResult> {
    return sessionReadResult(
      await this.rpc("read_agent_session", { p_chat_id: chatId }),
      this.#cipher,
    );
  }

  async recordTurn(
    command: AgentSessionRecordCommand,
  ): Promise<AgentSessionRecordResult> {
    const sessionId =
      command.expected.kind === "active"
        ? command.expected.id
        : this.#createSessionId();
    const sealedTurn = this.#cipher.seal(
      JSON.stringify({
        assistantText: command.assistantText,
        ownerText: command.ownerText,
      }),
      {
        chatId: command.chatId,
        sessionId,
        type: "session_turn",
        updateId: command.updateId,
      },
    );
    return sessionRecordResult(
      await this.rpc("record_agent_session_turn", {
        p_active_draft_id: command.activeDraftId,
        p_chat_id: command.chatId,
        p_expected_kind: command.expected.kind,
        p_expected_session_id:
          command.expected.kind === "active"
            ? command.expected.id
            : null,
        p_expected_version:
          command.expected.kind === "active"
            ? command.expected.version
            : null,
        p_proposed_session_id: sessionId,
        p_sealed_turn: sealedTurn,
        p_update_id: command.updateId,
      }),
      this.#cipher,
    );
  }
}

export class SupabaseAgentApprovalRepository
  extends SupabaseRpcRepository
  implements AgentApprovalRepository
{
  async clearForSession(
    sessionId: string,
    reason: AgentSessionClearCommand["reason"],
  ): Promise<void> {
    const value = record(
      await this.rpc("clear_agent_approval_for_session", {
        p_reason: reason,
        p_session_id: sessionId,
      }),
    );
    if (!value || typeof value.cleared !== "boolean") {
      throw new Error("Agent approval persistence returned invalid data");
    }
  }

  async read(
    chatId: number,
    draftId: string,
    draftVersion: number,
    toolName: AgentApprovalToolName,
  ): Promise<AgentApprovalReadResult> {
    return approvalReadResult(
      await this.rpc("read_agent_approval", {
        p_chat_id: chatId,
        p_draft_id: draftId,
        p_draft_version: draftVersion,
        p_tool_name: toolName,
      }),
    );
  }

  async resolve(
    command: AgentApprovalResolveCommand,
  ): Promise<AgentApprovalResolveResult> {
    return approvalResolveResult(
      await this.rpc("resolve_agent_approval", {
        p_approval_id: command.approvalId,
        p_approval_version: command.approvalVersion,
        p_chat_id: command.chatId,
        p_decision: command.decision,
        p_draft_id: command.draftId,
        p_draft_version: command.draftVersion,
        p_tool_name: command.toolName,
        p_update_id: command.updateId,
      }),
    );
  }

  async stage(
    command: AgentApprovalStageCommand,
  ): Promise<AgentApprovalStageResult> {
    return approvalStageResult(
      await this.rpc("stage_agent_approval", {
        p_chat_id: command.chatId,
        p_draft_id: command.draftId,
        p_draft_version: command.draftVersion,
        p_expected_kind: command.expected.kind,
        p_sealed_run_state: command.sealedRunState,
        p_session_id: command.sessionId,
        p_tool_name: command.toolName,
        p_update_id: command.updateId,
      }),
    );
  }
}
