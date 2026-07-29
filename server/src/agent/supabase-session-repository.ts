import { randomUUID } from "node:crypto";
import type { AgentInputItem } from "@openai/agents";
import { supabaseHeaders } from "../supabase.js";
import type { AgentSessionCipher } from "./session-crypto.js";
import type {
  AgentSdkSession,
  AgentApprovalReadResult,
  AgentApprovalRepository,
  AgentApprovalResolveCommand,
  AgentApprovalResolveResult,
  AgentApprovalStageCommand,
  AgentApprovalStageResult,
  AgentApprovalToolName,
  AgentPendingApprovalSnapshot,
  AgentSessionApplicationReplyCommand,
  AgentSessionClearCommand,
  AgentSessionClearResult,
  AgentSessionCompactionCheckpoint,
  AgentSessionHistoryPage,
  AgentSessionInteractionContext,
  AgentSessionReadResult,
  AgentSessionRepository,
  AgentSessionSnapshot,
  AgentSessionStoredItem,
  AgentSessionWriteResult,
} from "./session.js";
import {
  AGENT_SESSION_COMPACTION_THRESHOLD,
  AGENT_SESSION_DEFAULT_RETENTION_SECONDS,
  AGENT_SESSION_HISTORY_PAGE_LIMIT,
  AGENT_SESSION_WORKING_ITEM_LIMIT,
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
      retentionSeconds?: number;
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

function parseJsonRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent session persistence returned invalid data");
  }
  const item = record(parsed);
  if (!item) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return item;
}

function stripProviderMetadata(
  value: unknown,
  root = true,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripProviderMetadata(item, false));
  }
  const item = record(value);
  if (!item) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(item)
      .filter(
        ([key]) =>
          key !== "providerData" && !(root && key === "id"),
      )
      .map(([key, child]) => [
        key,
        stripProviderMetadata(child, false),
      ]),
  );
}

function durableItem(value: AgentInputItem): AgentInputItem | null {
  const item = record(value);
  if (!item || item.type === "reasoning") {
    return null;
  }
  const allowed =
    item.role === "user" ||
    item.role === "assistant" ||
    item.role === "system" ||
    item.type === "function_call" ||
    item.type === "function_call_result";
  if (!allowed) {
    return null;
  }
  return stripProviderMetadata(value) as AgentInputItem;
}

function parseSealedItem(
  value: unknown,
  session: Readonly<{ chatId: number; id: string }>,
  cipher: AgentSessionCipher,
): AgentSessionStoredItem {
  const item = record(value);
  if (
    !item ||
    !nonempty(item.id) ||
    !safeInteger(item.sequence, true) ||
    !nonempty(item.sealedItem) ||
    !instant(item.recordedAt)
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  let plaintext: Record<string, unknown>;
  try {
    plaintext = parseJsonRecord(
      cipher.open(item.sealedItem, {
        chatId: session.chatId,
        itemId: item.id,
        sessionId: session.id,
        type: "session_item",
      }),
    );
  } catch {
    throw new Error("Agent session persistence returned invalid data");
  }
  const parsed = durableItem(plaintext as AgentInputItem);
  if (parsed === null) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return {
    item: parsed,
    recordedAt: item.recordedAt,
    sequence: item.sequence,
  };
}

function parseInteraction(
  value: unknown,
  session: Readonly<{ chatId: number; id: string }>,
  cipher: AgentSessionCipher,
): AgentSessionInteractionContext {
  if (value === null || value === undefined) {
    return { callbackChoice: null, pendingQuestion: null };
  }
  const item = record(value);
  if (!item || !nonempty(item.contextId) || !nonempty(item.sealedContext)) {
    throw new Error("Agent session persistence returned invalid data");
  }
  let plaintext: Record<string, unknown>;
  try {
    plaintext = parseJsonRecord(
      cipher.open(item.sealedContext, {
        chatId: session.chatId,
        contextId: item.contextId,
        sessionId: session.id,
        type: "session_context",
      }),
    );
  } catch {
    throw new Error("Agent session persistence returned invalid data");
  }
  const callback = plaintext.callbackChoice;
  const pending = plaintext.pendingQuestion;
  const callbackRecord = callback === null ? null : record(callback);
  const pendingRecord = pending === null ? null : record(pending);
  if (
    callback !== null &&
    (!callbackRecord ||
      !nonempty(callbackRecord.action) ||
      !safeInteger(callbackRecord.updateId, true))
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  if (
    pending !== null &&
    (!pendingRecord ||
      typeof pendingRecord.text !== "string" ||
      !safeInteger(pendingRecord.updateId, true))
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return {
    callbackChoice:
      callback === null
        ? null
        : {
            action: callbackRecord!.action as string,
            updateId: callbackRecord!.updateId as number,
          },
    pendingQuestion:
      pending === null
        ? null
        : {
            text: pendingRecord!.text as string,
            updateId: pendingRecord!.updateId as number,
          },
  };
}

function parseCompaction(
  value: unknown,
  session: Readonly<{ chatId: number; id: string }>,
  cipher: AgentSessionCipher,
): AgentSessionCompactionCheckpoint | null {
  if (value === null || value === undefined) {
    return null;
  }
  const item = record(value);
  if (
    !item ||
    !nonempty(item.checkpointId) ||
    !safeInteger(item.throughSequence, true) ||
    !nonempty(item.sealedCheckpoint) ||
    !instant(item.createdAt)
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  let plaintext: Record<string, unknown>;
  try {
    plaintext = parseJsonRecord(
      cipher.open(item.sealedCheckpoint, {
        chatId: session.chatId,
        checkpointId: item.checkpointId,
        sessionId: session.id,
        type: "session_compaction",
      }),
    );
  } catch {
    throw new Error("Agent session persistence returned invalid data");
  }
  if (
    plaintext.throughSequence !== item.throughSequence ||
    plaintext.kind !== "local_checkpoint"
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return {
    createdAt: item.createdAt,
    id: item.checkpointId,
    throughSequence: item.throughSequence,
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
    !(item.activeDraftId === null || nonempty(item.activeDraftId)) ||
    !safeInteger(item.itemCount) ||
    item.itemCount < 0 ||
    !Array.isArray(item.items) ||
    item.items.length > AGENT_SESSION_WORKING_ITEM_LIMIT ||
    !(
      item.firstWorkingSequence === null ||
      safeInteger(item.firstWorkingSequence, true)
    )
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  const identity = { chatId: item.chatId, id: item.id };
  const items = item.items.map((stored) =>
    parseSealedItem(stored, identity, cipher)
  );
  if (
    items.some(
      (stored, index) =>
        index > 0 && stored.sequence <= items[index - 1]!.sequence,
    ) ||
    item.itemCount < items.length
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return {
    activeDraftId: item.activeDraftId,
    chatId: item.chatId,
    compactionCheckpoint: parseCompaction(
      item.compaction,
      identity,
      cipher,
    ),
    expiresAt: item.expiresAt,
    firstWorkingSequence: item.firstWorkingSequence,
    id: item.id,
    interaction: parseInteraction(item.interaction, identity, cipher),
    itemCount: item.itemCount,
    items,
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
    ? { kind: "active", session: sessionSnapshot(item.session, cipher) }
    : { kind: item.kind as "expired" | "none" };
}

function sessionWriteResult(
  value: unknown,
  cipher: AgentSessionCipher,
): AgentSessionWriteResult {
  const item = record(value);
  if (!item || !["applied", "replay", "stale"].includes(String(item.kind))) {
    throw new Error("Agent session persistence returned invalid data");
  }
  if (item.kind === "stale") {
    return { kind: "stale" };
  }
  return {
    kind: item.kind as "applied" | "replay",
    session: sessionSnapshot(item.session, cipher),
  };
}

function sessionClearResult(value: unknown): AgentSessionClearResult {
  const item = record(value);
  if (
    !item ||
    !["cleared", "none", "replay", "stale"].includes(String(item.kind))
  ) {
    throw new Error("Agent session persistence returned invalid data");
  }
  return { kind: item.kind as AgentSessionClearResult["kind"] };
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
  readonly #retentionSeconds: number;

  constructor(options: SupabaseAgentSessionRepositoryOptions) {
    super(options);
    this.#cipher = options.cipher;
    this.#createSessionId = options.createSessionId ?? randomUUID;
    this.#retentionSeconds =
      options.retentionSeconds ??
      AGENT_SESSION_DEFAULT_RETENTION_SECONDS;
    if (
      !Number.isSafeInteger(this.#retentionSeconds) ||
      this.#retentionSeconds < 3_600 ||
      this.#retentionSeconds >
        AGENT_SESSION_DEFAULT_RETENTION_SECONDS
    ) {
      throw new Error("Invalid agent session retention");
    }
  }

  async clear(
    command: AgentSessionClearCommand,
  ): Promise<AgentSessionClearResult> {
    if (
      command.reason === "owner_forget" ||
      command.reason === "owner_reset"
    ) {
      return sessionClearResult(
        await this.rpc("reset_agent_sdk_session", {
          p_chat_id: command.chatId,
          p_mode:
            command.reason === "owner_forget" ? "forget" : "reset",
          p_session_id: command.expectedSessionId ?? null,
        }),
      );
    }
    return sessionClearResult(
      await this.rpc("clear_agent_session", {
        p_chat_id: command.chatId,
        p_expected_session_id: command.expectedSessionId ?? null,
        p_reason: command.reason,
        p_update_id: command.updateId,
      }),
    );
  }

  async open(chatId: number): Promise<AgentSdkSession> {
    const read = await this.read(chatId);
    const snapshot =
      read.kind === "active"
        ? read.session
        : {
            activeDraftId: null,
            chatId,
            compactionCheckpoint: null,
            expiresAt: new Date(0).toISOString(),
            firstWorkingSequence: null,
            id: this.#createSessionId(),
            interaction: {
              callbackChoice: null,
              pendingQuestion: null,
            },
            itemCount: 0,
            items: [],
            version: 0,
          };
    return new SupabaseAgentSdkSession({
      cipher: this.#cipher,
      retentionSeconds: this.#retentionSeconds,
      rpc: (name, body) => this.rpc(name, body),
      snapshot,
    });
  }

  async read(chatId: number): Promise<AgentSessionReadResult> {
    return sessionReadResult(
      await this.rpc("read_agent_sdk_session", {
        p_chat_id: chatId,
        p_item_limit: AGENT_SESSION_WORKING_ITEM_LIMIT,
      }),
      this.#cipher,
    );
  }
}

type SupabaseAgentSdkSessionOptions = Readonly<{
  cipher: AgentSessionCipher;
  retentionSeconds: number;
  rpc: (
    name: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
  snapshot: AgentSessionSnapshot;
}>;

class SupabaseAgentSdkSession implements AgentSdkSession {
  readonly #cipher: AgentSessionCipher;
  readonly #rpc: SupabaseAgentSdkSessionOptions["rpc"];
  readonly #retentionSeconds: number;
  #snapshot: AgentSessionSnapshot;

  constructor(options: SupabaseAgentSdkSessionOptions) {
    this.#cipher = options.cipher;
    this.#retentionSeconds = options.retentionSeconds;
    this.#rpc = options.rpc;
    this.#snapshot = options.snapshot;
  }

  get chatId(): number {
    return this.#snapshot.chatId;
  }

  get sessionId(): string {
    return this.#snapshot.id;
  }

  currentSnapshot(): AgentSessionSnapshot {
    return structuredClone(this.#snapshot);
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit = AGENT_SESSION_WORKING_ITEM_LIMIT): Promise<AgentInputItem[]> {
    const bounded = Math.max(
      0,
      Math.min(limit, AGENT_SESSION_WORKING_ITEM_LIMIT),
    );
    if (bounded === 0) {
      return [];
    }
    return this.#snapshot.items
      .slice(-bounded)
      .map((stored) => structuredClone(stored.item));
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const sealedItems = items
      .map(durableItem)
      .filter((item): item is AgentInputItem => item !== null)
      .map((item) => {
        const id = randomUUID();
        return {
          id,
          sealedItem: this.#cipher.seal(JSON.stringify(item), {
            chatId: this.chatId,
            itemId: id,
            sessionId: this.sessionId,
            type: "session_item",
          }),
        };
      });
    if (sealedItems.length === 0) {
      return;
    }
    const result = sessionWriteResult(
      await this.#rpc("append_agent_sdk_items", {
        p_chat_id: this.chatId,
        p_expected_session_id:
          this.#snapshot.version === 0 ? null : this.sessionId,
        p_expected_version: this.#snapshot.version,
        p_items: sealedItems,
        p_proposed_session_id: this.sessionId,
        p_retention_seconds: this.#retentionSeconds,
      }),
      this.#cipher,
    );
    if (result.kind === "stale") {
      throw new Error("Agent session changed concurrently");
    }
    this.#snapshot = result.session;
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.#snapshot.version === 0) {
      return undefined;
    }
    const value = record(
      await this.#rpc("pop_agent_sdk_item", {
        p_chat_id: this.chatId,
        p_expected_version: this.#snapshot.version,
        p_session_id: this.sessionId,
      }),
    );
    if (
      !value ||
      !["empty", "popped", "stale"].includes(String(value.kind))
    ) {
      throw new Error("Agent session persistence returned invalid data");
    }
    if (value.kind === "stale") {
      throw new Error("Agent session changed concurrently");
    }
    if (value.kind === "empty") {
      return undefined;
    }
    const popped = parseSealedItem(
      value.item,
      { chatId: this.chatId, id: this.sessionId },
      this.#cipher,
    );
    this.#snapshot = sessionSnapshot(value.session, this.#cipher);
    return popped.item;
  }

  async clearSession(): Promise<void> {
    await this.reset("reset");
  }

  async reset(mode: "forget" | "reset"): Promise<void> {
    if (this.#snapshot.version > 0) {
      const result = sessionClearResult(
        await this.#rpc("reset_agent_sdk_session", {
          p_chat_id: this.chatId,
          p_mode: mode,
          p_session_id: this.sessionId,
        }),
      );
      if (result.kind === "stale") {
        throw new Error("Agent session changed concurrently");
      }
    }
    this.#snapshot = {
      ...this.#snapshot,
      activeDraftId: null,
      compactionCheckpoint: null,
      expiresAt: new Date(0).toISOString(),
      firstWorkingSequence: null,
      interaction: { callbackChoice: null, pendingQuestion: null },
      itemCount: 0,
      items: [],
      version: 0,
    };
  }

  async readHistory(
    cursor?: string,
    limit = AGENT_SESSION_HISTORY_PAGE_LIMIT,
  ): Promise<AgentSessionHistoryPage> {
    if (this.#snapshot.version === 0) {
      return { items: [], nextCursor: null };
    }
    let beforeSequence: number | null =
      this.#snapshot.firstWorkingSequence;
    if (cursor !== undefined) {
      let payload: Record<string, unknown>;
      try {
        payload = parseJsonRecord(
          this.#cipher.open(cursor, {
            chatId: this.chatId,
            sessionId: this.sessionId,
            type: "history_cursor",
          }),
        );
      } catch {
        throw new Error("Invalid agent session history cursor");
      }
      if (
        payload.sessionId !== this.sessionId ||
        !safeInteger(payload.beforeSequence, true)
      ) {
        throw new Error("Invalid agent session history cursor");
      }
      beforeSequence = payload.beforeSequence;
    }
    if (beforeSequence === null) {
      return { items: [], nextCursor: null };
    }
    const bounded = Math.max(
      1,
      Math.min(limit, AGENT_SESSION_HISTORY_PAGE_LIMIT),
    );
    const value = record(
      await this.#rpc("page_agent_sdk_history", {
        p_before_sequence: beforeSequence,
        p_chat_id: this.chatId,
        p_limit: bounded,
        p_session_id: this.sessionId,
      }),
    );
    if (
      !value ||
      !["active", "expired", "missing"].includes(String(value.kind))
    ) {
      throw new Error("Agent session persistence returned invalid data");
    }
    if (value.kind !== "active") {
      return { items: [], nextCursor: null };
    }
    if (!Array.isArray(value.items)) {
      throw new Error("Agent session persistence returned invalid data");
    }
    const items = value.items.map((stored) =>
      parseSealedItem(
        stored,
        { chatId: this.chatId, id: this.sessionId },
        this.#cipher,
      )
    );
    const nextBefore = value.nextBeforeSequence;
    if (!(nextBefore === null || safeInteger(nextBefore, true))) {
      throw new Error("Agent session persistence returned invalid data");
    }
    return {
      items,
      nextCursor:
        nextBefore === null
          ? null
          : this.#cipher.seal(
              JSON.stringify({
                beforeSequence: nextBefore,
                sessionId: this.sessionId,
              }),
              {
                chatId: this.chatId,
                sessionId: this.sessionId,
                type: "history_cursor",
              },
            ),
    };
  }

  async recordApplicationReply(
    command: Omit<
      AgentSessionApplicationReplyCommand,
      "chatId" | "sessionId"
    >,
  ): Promise<AgentSessionWriteResult> {
    return this.#recordInteraction(
      "write_agent_sdk_application_reply",
      command,
      null,
    );
  }

  async recordCallbackChoice(command: Readonly<{
    action: string;
    assistantText: string;
    pendingQuestion: boolean;
    updateId: number;
  }>): Promise<AgentSessionWriteResult> {
    return this.#recordInteraction(
      "write_agent_sdk_callback_choice",
      {
        activeDraftId: this.#snapshot.activeDraftId,
        assistantText: command.assistantText,
        pendingQuestion: command.pendingQuestion,
        updateId: command.updateId,
      },
      command.action,
    );
  }

  async runCompaction(): Promise<null> {
    if (
      this.#snapshot.version === 0 ||
      this.#snapshot.itemCount < AGENT_SESSION_COMPACTION_THRESHOLD
    ) {
      return null;
    }
    const throughSequence =
      this.#snapshot.firstWorkingSequence === null
        ? this.#snapshot.itemCount
        : this.#snapshot.firstWorkingSequence - 1;
    if (
      throughSequence < 1 ||
      (this.#snapshot.compactionCheckpoint?.throughSequence ?? 0) >=
        throughSequence
    ) {
      return null;
    }
    const checkpointId = randomUUID();
    const sealedCheckpoint = this.#cipher.seal(
      JSON.stringify({ kind: "local_checkpoint", throughSequence }),
      {
        chatId: this.chatId,
        checkpointId,
        sessionId: this.sessionId,
        type: "session_compaction",
      },
    );
    const result = sessionWriteResult(
      await this.#rpc("write_agent_sdk_compaction", {
        p_chat_id: this.chatId,
        p_checkpoint_id: checkpointId,
        p_expected_version: this.#snapshot.version,
        p_retention_seconds: this.#retentionSeconds,
        p_sealed_checkpoint: sealedCheckpoint,
        p_session_id: this.sessionId,
        p_through_sequence: throughSequence,
      }),
      this.#cipher,
    );
    if (result.kind !== "stale") {
      this.#snapshot = result.session;
    }
    return null;
  }

  async #recordInteraction(
    rpcName:
      | "write_agent_sdk_application_reply"
      | "write_agent_sdk_callback_choice",
    command: Readonly<{
      activeDraftId: string | null;
      assistantText: string;
      pendingQuestion: boolean;
      updateId: number;
    }>,
    callbackAction: string | null,
  ): Promise<AgentSessionWriteResult> {
    if (this.#snapshot.version === 0) {
      throw new Error("Agent session has not been persisted");
    }
    const itemId = randomUUID();
    const contextId = randomUUID();
    const assistantItem: AgentInputItem = {
      content: [{ text: command.assistantText, type: "output_text" }],
      role: "assistant",
      status: "completed",
    };
    const interaction: AgentSessionInteractionContext = {
      callbackChoice:
        callbackAction === null
          ? null
          : { action: callbackAction, updateId: command.updateId },
      pendingQuestion: command.pendingQuestion
        ? { text: command.assistantText, updateId: command.updateId }
        : null,
    };
    const result = sessionWriteResult(
      await this.#rpc(rpcName, {
        p_active_draft_id: command.activeDraftId,
        p_chat_id: this.chatId,
        p_context_id: contextId,
        p_expected_version: this.#snapshot.version,
        p_item_id: itemId,
        p_operation_id: command.updateId,
        p_retention_seconds: this.#retentionSeconds,
        p_sealed_context: this.#cipher.seal(
          JSON.stringify(interaction),
          {
            chatId: this.chatId,
            contextId,
            sessionId: this.sessionId,
            type: "session_context",
          },
        ),
        p_sealed_item: this.#cipher.seal(JSON.stringify(assistantItem), {
          chatId: this.chatId,
          itemId,
          sessionId: this.sessionId,
          type: "session_item",
        }),
        p_session_id: this.sessionId,
      }),
      this.#cipher,
    );
    if (result.kind !== "stale") {
      this.#snapshot = result.session;
    }
    return result;
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
