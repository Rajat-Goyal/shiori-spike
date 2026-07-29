export const AGENT_SESSION_MAX_TURNS = 6;
export const AGENT_SESSION_TTL_SECONDS = 24 * 60 * 60;

export type AgentSessionTurn = Readonly<{
  assistantText: string;
  ownerText: string;
  recordedAt: string;
  updateId: number;
}>;

export type AgentSessionSnapshot = Readonly<{
  activeDraftId: string | null;
  chatId: number;
  expiresAt: string;
  id: string;
  turns: readonly AgentSessionTurn[];
  version: number;
}>;

export type AgentSessionReadResult =
  | Readonly<{ kind: "none" | "expired" }>
  | Readonly<{ kind: "active"; session: AgentSessionSnapshot }>;

export type AgentSessionRecordCommand = Readonly<{
  activeDraftId: string | null;
  assistantText: string;
  chatId: number;
  expected:
    | Readonly<{ kind: "none" }>
    | Readonly<{ id: string; kind: "active"; version: number }>;
  ownerText: string;
  updateId: number;
}>;

export type AgentSessionRecordResult =
  | Readonly<{ kind: "replay" | "stale" }>
  | Readonly<{ kind: "applied"; session: AgentSessionSnapshot }>;

export type AgentSessionClearReason =
  | "cancelled"
  | "confirmed"
  | "expired";

export type AgentSessionClearCommand = Readonly<{
  chatId: number;
  expectedSessionId?: string;
  reason: AgentSessionClearReason;
  updateId: number;
}>;

export type AgentSessionClearResult = Readonly<{
  kind: "cleared" | "none" | "replay" | "stale";
}>;

/**
 * Ephemeral conversational continuity owned by the application.
 *
 * Implementations must enforce one active session per chat, a non-sliding
 * 24-hour lifetime, update-id idempotency, CAS writes, and the six-turn cap.
 * Expired sessions are deleted during reads. Clearing deletes all turns; there
 * is no archive. Durable adapters must seal each owner/assistant turn with the
 * domain-separated agent session cipher before writing it; the plaintext API
 * exists only for application callers and in-memory tests. Secret rotation may
 * invalidate a live session and must fail closed. This repository never stores
 * model reasoning, tool calls, tool outputs, callback data, Calendar event
 * data, credentials, or provider request/response payloads.
 */
export interface AgentSessionRepository {
  clear(command: AgentSessionClearCommand): Promise<AgentSessionClearResult>;
  read(chatId: number): Promise<AgentSessionReadResult>;
  recordTurn(
    command: AgentSessionRecordCommand,
  ): Promise<AgentSessionRecordResult>;
}

export type AgentApprovalToolName = "execute_commitment";

export type AgentPendingApprovalSnapshot = Readonly<{
  chatId: number;
  draftId: string;
  draftVersion: number;
  expiresAt: string;
  id: string;
  sealedRunState: string;
  sessionId: string;
  toolName: AgentApprovalToolName;
  version: number;
}>;

export type AgentApprovalReadResult =
  | Readonly<{ kind: "expired" | "missing" }>
  | Readonly<{ approval: AgentPendingApprovalSnapshot; kind: "current" }>;

export type AgentApprovalStageCommand = Readonly<{
  chatId: number;
  draftId: string;
  draftVersion: number;
  expected: Readonly<{ kind: "none" }>;
  sealedRunState: string;
  sessionId: string;
  toolName: AgentApprovalToolName;
  updateId: number;
}>;

export type AgentApprovalStageResult =
  | Readonly<{ kind: "replay" | "stale" }>
  | Readonly<{
      approval: AgentPendingApprovalSnapshot;
      kind: "staged";
    }>;

export type AgentApprovalResolveCommand = Readonly<{
  approvalId: string;
  approvalVersion: number;
  chatId: number;
  decision: "approve" | "reject";
  draftId: string;
  draftVersion: number;
  toolName: AgentApprovalToolName;
  updateId: number;
}>;

export type AgentApprovalResolveResult =
  | Readonly<{
      kind: "expired" | "missing" | "rejected" | "replay" | "stale";
    }>
  | Readonly<{
      kind: "claimed";
      sealedRunState: string;
      sessionId: string;
  }>;

/**
 * Single-binding storage for an interrupted, human-approval-gated Agents SDK
 * run.
 *
 * `sealedRunState` is application-encrypted before it reaches this boundary.
 * An implementation must bind it to the exact session, owner chat, draft id,
 * draft version, allowlisted tool name, and update id. It must enforce CAS,
 * idempotent stage/resolve calls and the same non-sliding session expiry.
 * Approval may be resumed again after an interrupted process only for the
 * same authenticated owner chat, session, draft id/version, and tool binding;
 * each retry carries its fresh callback update id to the downstream atomic
 * action. The row remains until rejection, successful terminal confirmation,
 * cancellation, or expiry. It must never inspect or separately project the
 * sealed payload.
 */
export interface AgentApprovalRepository {
  clearForSession(
    sessionId: string,
    reason: AgentSessionClearReason,
  ): Promise<void>;
  read(
    chatId: number,
    draftId: string,
    draftVersion: number,
    toolName: AgentApprovalToolName,
  ): Promise<AgentApprovalReadResult>;
  resolve(
    command: AgentApprovalResolveCommand,
  ): Promise<AgentApprovalResolveResult>;
  stage(
    command: AgentApprovalStageCommand,
  ): Promise<AgentApprovalStageResult>;
}
