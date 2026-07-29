import type { DecisionResult } from "../decision/schema.js";
import type { TelegramReply } from "../confirmation.js";
import type {
  AgentRuntime,
  AgentRuntimeResult,
  ApprovedAgentExecutionAuthority,
} from "./runtime.js";
import type {
  AgentSessionCipher,
  AgentStateBinding,
} from "./session-crypto.js";
import type {
  AgentApprovalRepository,
  AgentPendingApprovalSnapshot,
  AgentSessionClearReason,
  AgentSessionRepository,
} from "./session.js";

const EXECUTION_TOOL = "execute_commitment";

export type AgentApprovalGateTelemetryEvent =
  | "clear_unavailable"
  | "prepare_repository_unavailable"
  | "prepare_runtime_unavailable"
  | "prepare_session_unavailable"
  | "resolve_binding_invalid"
  | "resolve_repository_unavailable"
  | "resolve_runtime_unavailable";

export type AgentApprovalGateResult =
  | Readonly<{ kind: "prepared" }>
  | Readonly<{
      kind: "approved";
      replayed?: true;
      reply?: TelegramReply;
    }>
  | Readonly<{ kind: "rejected" | "replay" | "unavailable" }>;

export type AgentApprovalPrepareCommand = Readonly<{
  chatId: number;
  decision: DecisionResult;
  draft: Readonly<{ id: string; version: number }>;
  updateId: number;
}>;

export type AgentApprovalResolveCommand = Readonly<{
  chatId: number;
  decision: "approve" | "reject";
  draft: Readonly<{ id: string; version: number }>;
  updateId: number;
}>;

export type AgentApprovalClearCommand = Readonly<{
  chatId: number;
  reason: AgentSessionClearReason;
  sessionId: string;
  updateId: number;
}>;

export type AgentApprovalGateOptions = Readonly<{
  approvals: AgentApprovalRepository;
  cipher: AgentSessionCipher;
  runtime: AgentRuntime;
  sessions: AgentSessionRepository;
  telemetry?: (event: AgentApprovalGateTelemetryEvent) => void;
}>;

export interface AgentApprovalGate {
  clearAfterTerminal(
    command: AgentApprovalClearCommand,
  ): Promise<Readonly<{ kind: "cleared" | "replay" | "unavailable" }>>;
  prepare(
    command: AgentApprovalPrepareCommand,
  ): Promise<AgentApprovalGateResult>;
  resolve(
    command: AgentApprovalResolveCommand,
  ): Promise<AgentApprovalGateResult>;
}

function validIdentity(
  chatId: number,
  draft: Readonly<{ id: string; version: number }>,
  updateId: number,
): boolean {
  return (
    Number.isSafeInteger(chatId) &&
    chatId !== 0 &&
    draft.id.length > 0 &&
    Number.isSafeInteger(draft.version) &&
    draft.version > 0 &&
    Number.isSafeInteger(updateId) &&
    updateId > 0
  );
}

function exactApproval(
  approval: AgentPendingApprovalSnapshot,
  expected: Readonly<{
    chatId: number;
    draftId: string;
    draftVersion: number;
    sessionId?: string;
  }>,
): boolean {
  return (
    approval.chatId === expected.chatId &&
    approval.draftId === expected.draftId &&
    approval.draftVersion === expected.draftVersion &&
    approval.toolName === EXECUTION_TOOL &&
    (expected.sessionId === undefined ||
      approval.sessionId === expected.sessionId)
  );
}

function binding(
  authority: Omit<ApprovedAgentExecutionAuthority, "updateId">,
): AgentStateBinding {
  return {
    chatId: authority.chatId,
    draftId: authority.draftId,
    draftVersion: authority.draftVersion,
    sessionId: authority.sessionId,
    toolName: EXECUTION_TOOL,
    type: "pending_approval" as const,
  };
}

function preparedRuntimeResult(result: AgentRuntimeResult): boolean {
  return (
    result.outcome.ok &&
    typeof result.pendingApprovalState === "string" &&
    result.pendingApprovalState.length > 0 &&
    result.execution === undefined
  );
}

export function createAgentApprovalGate(
  options: AgentApprovalGateOptions,
): AgentApprovalGate {
  function report(event: AgentApprovalGateTelemetryEvent): void {
    try {
      options.telemetry?.(event);
    } catch {
      // Telemetry is observational and must never affect the approval gate.
    }
  }

  return {
    async clearAfterTerminal(command) {
      if (
        !Number.isSafeInteger(command.chatId) ||
        command.chatId === 0 ||
        command.sessionId.length === 0 ||
        !Number.isSafeInteger(command.updateId) ||
        command.updateId <= 0
      ) {
        return { kind: "unavailable" };
      }
      try {
        const [sessionResult] = await Promise.all([
          options.sessions.clear({
            chatId: command.chatId,
            expectedSessionId: command.sessionId,
            reason: command.reason,
            updateId: command.updateId,
          }),
          options.approvals.clearForSession(
            command.sessionId,
            command.reason,
          ),
        ]);
        if (sessionResult.kind === "replay") {
          return { kind: "replay" };
        }
        if (
          sessionResult.kind === "cleared" ||
          sessionResult.kind === "none"
        ) {
          return { kind: "cleared" };
        }
      } catch {
        report("clear_unavailable");
      }
      return { kind: "unavailable" };
    },

    async prepare(command) {
      if (!validIdentity(command.chatId, command.draft, command.updateId)) {
        return { kind: "unavailable" };
      }
      let sessionRead: Awaited<ReturnType<AgentSessionRepository["read"]>>;
      try {
        sessionRead = await options.sessions.read(command.chatId);
      } catch {
        report("prepare_session_unavailable");
        return { kind: "unavailable" };
      }
      if (
        sessionRead.kind !== "active" ||
        sessionRead.session.activeDraftId !== command.draft.id
      ) {
        report("prepare_session_unavailable");
        return { kind: "unavailable" };
      }
      try {
        const existing = await options.approvals.read(
          command.chatId,
          command.draft.id,
          command.draft.version,
          EXECUTION_TOOL,
        );
        if (
          existing.kind === "current" &&
          exactApproval(existing.approval, {
            chatId: command.chatId,
            draftId: command.draft.id,
            draftVersion: command.draft.version,
            sessionId: sessionRead.session.id,
          })
        ) {
          return { kind: "prepared" };
        }
        if (existing.kind === "expired") {
          return { kind: "unavailable" };
        }
        await options.approvals.clearForSession(
          sessionRead.session.id,
          "cancelled",
        );
      } catch {
        report("prepare_repository_unavailable");
        return { kind: "unavailable" };
      }
      const authority: ApprovedAgentExecutionAuthority = {
        chatId: command.chatId,
        draftId: command.draft.id,
        draftVersion: command.draft.version,
        sessionId: sessionRead.session.id,
        updateId: command.updateId,
      };
      let runtimeResult: AgentRuntimeResult;
      try {
        runtimeResult = await options.runtime.prepareExecution({
          authority,
          decision: command.decision,
        });
      } catch {
        report("prepare_runtime_unavailable");
        return { kind: "unavailable" };
      }
      if (!preparedRuntimeResult(runtimeResult)) {
        report("prepare_runtime_unavailable");
        return { kind: "unavailable" };
      }
      let sealedRunState: string;
      try {
        sealedRunState = options.cipher.seal(
          runtimeResult.pendingApprovalState!,
          binding(authority),
        );
      } catch {
        report("prepare_runtime_unavailable");
        return { kind: "unavailable" };
      }
      try {
        const staged = await options.approvals.stage({
          chatId: command.chatId,
          draftId: command.draft.id,
          draftVersion: command.draft.version,
          expected: { kind: "none" },
          sealedRunState,
          sessionId: sessionRead.session.id,
          toolName: EXECUTION_TOOL,
          updateId: command.updateId,
        });
        if (staged.kind === "replay") {
          return { kind: "replay" };
        }
        if (
          staged.kind === "staged" &&
          exactApproval(staged.approval, {
            chatId: command.chatId,
            draftId: command.draft.id,
            draftVersion: command.draft.version,
            sessionId: sessionRead.session.id,
          })
        ) {
          return { kind: "prepared" };
        }
      } catch {
        report("prepare_repository_unavailable");
        return { kind: "unavailable" };
      }
      report("prepare_repository_unavailable");
      return { kind: "unavailable" };
    },

    async resolve(command) {
      if (!validIdentity(command.chatId, command.draft, command.updateId)) {
        return { kind: "unavailable" };
      }
      let current: Awaited<ReturnType<AgentApprovalRepository["read"]>>;
      try {
        current = await options.approvals.read(
          command.chatId,
          command.draft.id,
          command.draft.version,
          EXECUTION_TOOL,
        );
      } catch {
        report("resolve_repository_unavailable");
        return { kind: "unavailable" };
      }
      if (
        current.kind !== "current" ||
        !exactApproval(current.approval, {
          chatId: command.chatId,
          draftId: command.draft.id,
          draftVersion: command.draft.version,
        })
      ) {
        return { kind: "unavailable" };
      }
      let resolved: Awaited<ReturnType<AgentApprovalRepository["resolve"]>>;
      try {
        resolved = await options.approvals.resolve({
          approvalId: current.approval.id,
          approvalVersion: current.approval.version,
          chatId: command.chatId,
          decision: command.decision,
          draftId: command.draft.id,
          draftVersion: command.draft.version,
          toolName: EXECUTION_TOOL,
          updateId: command.updateId,
        });
      } catch {
        report("resolve_repository_unavailable");
        return { kind: "unavailable" };
      }
      if (resolved.kind === "replay") {
        return { kind: "replay" };
      }
      if (resolved.kind === "rejected") {
        return { kind: "rejected" };
      }
      if (resolved.kind !== "claimed") {
        return { kind: "unavailable" };
      }
      if (resolved.sessionId !== current.approval.sessionId) {
        report("resolve_binding_invalid");
        return { kind: "unavailable" };
      }
      let pendingApprovalState: string;
      try {
        pendingApprovalState = options.cipher.open(
          resolved.sealedRunState,
          binding({
            chatId: command.chatId,
            draftId: command.draft.id,
            draftVersion: command.draft.version,
            sessionId: resolved.sessionId,
          }),
        );
      } catch {
        report("resolve_binding_invalid");
        return { kind: "unavailable" };
      }
      let runtimeResult: AgentRuntimeResult;
      try {
        runtimeResult = await options.runtime.resume({
          approval: command.decision,
          authority: {
            chatId: command.chatId,
            draftId: command.draft.id,
            draftVersion: command.draft.version,
            sessionId: resolved.sessionId,
            updateId: command.updateId,
          },
          pendingApprovalState,
        });
      } catch {
        report("resolve_runtime_unavailable");
        return { kind: "unavailable" };
      }
      if (command.decision === "reject") {
        return { kind: "rejected" };
      }
      if (
        runtimeResult.pendingApprovalState !== undefined ||
        !runtimeResult.outcome.ok ||
        runtimeResult.execution === undefined
      ) {
        report("resolve_runtime_unavailable");
        return { kind: "unavailable" };
      }
      switch (runtimeResult.execution.status) {
        case "executed":
          return {
            kind: "approved",
            ...(runtimeResult.execution.reply === undefined
              ? {}
              : { reply: runtimeResult.execution.reply }),
          };
        case "replay":
          return { kind: "approved", replayed: true };
        case "rejected":
          return { kind: "rejected" };
      }
    },
  };
}
