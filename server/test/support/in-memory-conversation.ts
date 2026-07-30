/**
 * Stateful in-memory persistence for the conformance harness.
 *
 * The point of the harness is to exercise the real prompt, the real model, the
 * real agent runtime, the real semantic validation and the real conversation
 * service across several turns. Supabase is the one part that adds nothing to
 * that, so it is replaced here rather than mocked away in pieces.
 *
 * These fakes hold state and evolve it exactly as the SQL does for the paths the
 * harness drives: create a focused draft, patch it, park and accept a permission
 * candidate, and preserve on a rejected turn.
 */
import type { AgentInputItem } from "@openai/agents";
import type {
  AgentProductContext,
  AgentContextReader,
} from "../../src/agent/context-reader.js";
import type {
  AgentSdkSession,
  AgentSessionRepository,
} from "../../src/agent/session.js";
import type {
  ActiveDraft,
  ConversationApplyResult,
  ConversationCommand,
  ConversationDraftPage,
  ConversationDraftResolution,
  ConversationDraftSummary,
  ConversationReadResult,
  ConversationTurnFailureRecord,
  DecisionAudit,
  PatchFocusedDraftCommand,
  PermissionCandidate,
} from "../../src/conversation/repository.js";
import type { DecisionContextFields } from "../../src/decision/schema.js";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const SEPARATE_DRAFT_ID = "22222222-2222-4222-8222-222222222222";
const PERMISSION_ID = "33333333-3333-4333-8333-333333333333";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function phaseOf(fields: DecisionContextFields): ActiveDraft["phase"] {
  if (fields.definitionOfDone === null) {
    return "awaiting_definition";
  }
  return fields.targetAt === null ? "awaiting_target" : "complete";
}

export class InMemoryConversationStore {
  readonly audits: DecisionAudit[] = [];
  readonly commands: string[] = [];
  readonly turnFailures: ConversationTurnFailureRecord[] = [];
  #draft: ActiveDraft | null = null;
  #permission: PermissionCandidate | null = null;
  #separate: ActiveDraft | null = null;

  get draft(): ActiveDraft | null {
    return this.#draft;
  }

  get permission(): PermissionCandidate | null {
    return this.#permission;
  }

  async readTurn(): Promise<ConversationReadResult> {
    if (this.#permission !== null) {
      return this.#permission;
    }
    if (this.#draft !== null) {
      return this.#draft;
    }
    return { completed: true, kind: "none" };
  }

  async applyTurn(
    command: ConversationCommand,
  ): Promise<ConversationApplyResult> {
    this.commands.push(command.action);
    if (command.audit) {
      this.audits.push(command.audit);
    }
    let draftCreated = false;

    switch (command.action) {
      case "create_draft":
      case "accept_work_permission": {
        this.#draft = {
          expiresAt: FAR_FUTURE,
          fields: command.fields,
          id: DRAFT_ID,
          kind: "draft",
          phase: phaseOf(command.fields),
          version: 1,
        };
        this.#permission = null;
        draftCreated = true;
        break;
      }
      case "create_separate_draft": {
        this.#separate = {
          expiresAt: FAR_FUTURE,
          fields: command.fields,
          id: SEPARATE_DRAFT_ID,
          kind: "draft",
          phase: phaseOf(command.fields),
          version: 1,
        };
        draftCreated = true;
        break;
      }
      case "update_draft": {
        if (this.#draft !== null) {
          this.#draft = {
            ...this.#draft,
            fields: command.fields,
            phase: phaseOf(command.fields),
            version: this.#draft.version + 1,
          };
        }
        break;
      }
      case "create_permission": {
        this.#permission = {
          correlatedUpdateId: command.updateId,
          expiresAt: FAR_FUTURE,
          fields: command.fields,
          id: PERMISSION_ID,
          kind: "permission",
          sourceUpdateId: command.updateId,
        };
        break;
      }
      case "accept_permission": {
        if (this.#permission !== null) {
          this.#draft = {
            expiresAt: FAR_FUTURE,
            fields: this.#permission.fields,
            id: DRAFT_ID,
            kind: "draft",
            phase: phaseOf(this.#permission.fields),
            version: 1,
          };
          this.#permission = null;
          draftCreated = true;
        }
        break;
      }
      case "terminate_permission": {
        this.#permission = null;
        break;
      }
      case "rearm_permission":
      case "preserve":
        break;
    }

    const reference = this.#draft ?? this.#separate;
    return {
      completed: true,
      draftCreated,
      status: "applied",
      ...(reference === null
        ? {}
        : {
            draftReference: {
              id: reference.id,
              version: reference.version,
            },
          }),
    };
  }

  async patchFocusedDraft(
    command: PatchFocusedDraftCommand,
  ): Promise<ConversationApplyResult> {
    this.commands.push("patch_focused_draft");
    this.audits.push(command.audit);
    if (this.#draft === null) {
      return { completed: true, draftCreated: false, status: "stale" };
    }
    this.#draft = {
      ...this.#draft,
      fields: command.fields,
      phase: phaseOf(command.fields),
      version: this.#draft.version + 1,
    };
    return {
      completed: true,
      draftCreated: false,
      draftReference: { id: this.#draft.id, version: this.#draft.version },
      status: "applied",
    };
  }

  async recordDecision(): Promise<void> {}

  async recordTurnFailure(
    record: ConversationTurnFailureRecord,
  ): Promise<void> {
    this.turnFailures.push(record);
  }

  async resolveDraftReference(): Promise<ConversationDraftResolution> {
    return { kind: "none" };
  }

  async listDrafts(): Promise<ConversationDraftPage> {
    return { drafts: this.#summaries(), nextCursor: null };
  }

  #summaries(): ConversationDraftSummary[] {
    const summaries: ConversationDraftSummary[] = [];
    if (this.#draft !== null) {
      summaries.push({
        ...this.#draft,
        focused: true,
        updatedAt: FAR_FUTURE,
      });
    }
    if (this.#separate !== null) {
      summaries.push({
        ...this.#separate,
        focused: false,
        updatedAt: FAR_FUTURE,
      });
    }
    return summaries;
  }

  /** Product context the agent reads, derived from the same in-memory state. */
  contextReader(): AgentContextReader {
    const store = this;
    return {
      async readProductContext(): Promise<AgentProductContext> {
        return {
          ambiguity: null,
          commitments: [],
          drafts: store.#summaries().map((draft) => ({
            definitionOfDone: draft.fields.definitionOfDone,
            durationMinutes: draft.fields.durationMinutes,
            focused: draft.focused,
            id: draft.id,
            phase: draft.phase,
            possibleWorkSession: draft.fields.possibleWorkSession,
            preparation: null,
            simpleAction: draft.fields.simpleAction,
            targetAt: draft.fields.targetAt,
            targetTimeZone: draft.fields.targetTimeZone,
            timingConstraints: draft.fields.timingConstraints,
            version: draft.version,
          })),
          focusedEntity: null,
          matchedEntity: null,
          truncated: { commitments: false, drafts: false },
        } as unknown as AgentProductContext;
      },
    } as AgentContextReader;
  }
}

/** Stateful session so conversational continuity is genuinely exercised. */
export function inMemorySessionRepository(
  chatId: number,
): AgentSessionRepository {
  const items: Array<{
    item: AgentInputItem;
    recordedAt: string;
    sequence: number;
  }> = [];
  let pendingQuestion: string | null = null;
  let activeDraftId: string | null = null;
  const sessionId = "44444444-4444-4444-8444-444444444444";

  const session: AgentSdkSession = {
    addItems: async (added: AgentInputItem[]) => {
      for (const item of added) {
        items.push({
          item,
          recordedAt: FAR_FUTURE,
          sequence: items.length + 1,
        });
      }
    },
    chatId,
    clearSession: async () => undefined,
    currentSnapshot: () => ({
      activeDraftId,
      chatId,
      compactionCheckpoint: null,
      expiresAt: FAR_FUTURE,
      firstWorkingSequence: items.length > 0 ? 1 : null,
      id: sessionId,
      interaction: { callbackChoice: null, pendingQuestion },
      itemCount: items.length,
      items: [...items],
      version: 1,
    }),
    getItems: async (limit?: number) =>
      items.slice(-(limit ?? items.length)).map((entry) => entry.item),
    getSessionId: async () => sessionId,
    popItem: async () => {
      const last = items.pop();
      return last?.item;
    },
    readHistory: async () => ({ items: [], nextCursor: null }),
    recordApplicationReply: async (command) => {
      activeDraftId = command.activeDraftId;
      if (command.pendingQuestion === "replace") {
        pendingQuestion = command.assistantText;
      } else if (command.pendingQuestion === "clear") {
        pendingQuestion = null;
      }
      items.push({
        // Must match the shape the Supabase session repository stores: the
        // Responses model reads `content` as output parts, and a bare string
        // makes it throw while building the request.
        item: {
          content: [
            { text: command.assistantText, type: "output_text" },
          ],
          role: "assistant",
          status: "completed",
        } as unknown as AgentInputItem,
        recordedAt: FAR_FUTURE,
        sequence: items.length + 1,
      });
      return { kind: "applied" };
    },
    recordCallbackChoice: async () => ({ kind: "applied" }),
    reset: async () => undefined,
    runCompaction: async () => null,
    sessionId,
  } as unknown as AgentSdkSession;

  return {
    clear: async () => ({ kind: "cleared" }) as never,
    open: async () => session,
    read: async () => ({ kind: "session", session }) as never,
  } as AgentSessionRepository;
}
