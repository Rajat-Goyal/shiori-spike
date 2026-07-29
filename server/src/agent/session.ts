import type {
  AgentInputItem,
  OpenAIResponsesCompactionAwareSession,
} from "@openai/agents";

export const AGENT_SESSION_WORKING_ITEM_LIMIT = 40;
export const AGENT_SESSION_HISTORY_PAGE_LIMIT = 40;
export const AGENT_SESSION_COMPACTION_THRESHOLD = 80;
export const AGENT_SESSION_MIN_RETENTION_SECONDS = 60 * 60;
export const AGENT_SESSION_DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export type AgentSessionCallbackChoice = Readonly<{
  action: string;
  updateId: number;
}>;

export type AgentSessionPendingQuestion = Readonly<{
  text: string;
  updateId: number;
}>;

export type AgentSessionInteractionContext = Readonly<{
  callbackChoice: AgentSessionCallbackChoice | null;
  pendingQuestion: AgentSessionPendingQuestion | null;
}>;

export type AgentSessionCompactionCheckpoint = Readonly<{
  createdAt: string;
  id: string;
  throughSequence: number;
}>;

export type AgentSessionStoredItem = Readonly<{
  item: AgentInputItem;
  recordedAt: string;
  sequence: number;
}>;

export type AgentSessionSnapshot = Readonly<{
  activeDraftId: string | null;
  chatId: number;
  compactionCheckpoint: AgentSessionCompactionCheckpoint | null;
  expiresAt: string;
  firstWorkingSequence: number | null;
  id: string;
  interaction: AgentSessionInteractionContext;
  itemCount: number;
  items: readonly AgentSessionStoredItem[];
  version: number;
}>;

export type AgentSessionReadResult =
  | Readonly<{ kind: "none" | "expired" }>
  | Readonly<{ kind: "active"; session: AgentSessionSnapshot }>;

export type AgentPendingQuestionDisposition =
  | "clear"
  | "preserve"
  | "replace";

export type AgentSessionApplicationReplyCommand = Readonly<{
  activeDraftId: string | null;
  assistantText: string;
  chatId: number;
  pendingQuestion: AgentPendingQuestionDisposition;
  sessionId: string;
  updateId: number;
}>;

export type AgentSessionWriteResult =
  | Readonly<{ kind: "stale" }>
  | Readonly<{
      kind: "applied" | "replay";
      session: AgentSessionSnapshot;
    }>;

export type AgentSessionClearReason =
  | "cancelled"
  | "confirmed"
  | "expired"
  | "owner_forget"
  | "owner_reset";

export type AgentSessionClearCommand = Readonly<{
  chatId: number;
  expectedSessionId?: string;
  reason: AgentSessionClearReason;
  updateId: number;
}>;

export type AgentSessionClearResult = Readonly<{
  kind: "cleared" | "none" | "replay" | "stale";
}>;

export type AgentSessionHistoryPage = Readonly<{
  items: readonly AgentSessionStoredItem[];
  nextCursor: string | null;
}>;

export type AgentSessionResetMode = "forget" | "reset";

/**
 * Application-owned Agents SDK session selected by authenticated owner chat.
 *
 * The SDK calls the standard Session methods. The application extensions append
 * authoritative reply/callback context, page older encrypted items by opaque
 * cursor, and implement explicit owner reset/forget. Implementations must never
 * persist reasoning items, secrets, complete Telegram callbacks, unsanitized
 * Calendar objects, credentials, or provider request/response payloads.
 */
export interface AgentSdkSession
  extends OpenAIResponsesCompactionAwareSession {
  readonly chatId: number;
  readonly sessionId: string;
  currentSnapshot(): AgentSessionSnapshot;
  readHistory(
    cursor?: string,
    limit?: number,
  ): Promise<AgentSessionHistoryPage>;
  recordApplicationReply(
    command: Omit<
      AgentSessionApplicationReplyCommand,
      "chatId" | "sessionId"
    >,
  ): Promise<AgentSessionWriteResult>;
  recordCallbackChoice(command: Readonly<{
    action: string;
    assistantText: string;
    pendingQuestion: boolean;
    updateId: number;
  }>): Promise<AgentSessionWriteResult>;
  reset(mode: AgentSessionResetMode): Promise<void>;
}

export interface AgentSessionRepository {
  clear(command: AgentSessionClearCommand): Promise<AgentSessionClearResult>;
  open(chatId: number): Promise<AgentSdkSession>;
  read(chatId: number): Promise<AgentSessionReadResult>;
}

export type AgentApprovalToolName =
  | "execute_commitment"
  | "update_commitment";

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
