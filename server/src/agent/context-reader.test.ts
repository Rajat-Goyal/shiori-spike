import type { AgentInputItem } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import type { AgentSdkSession } from "./session.js";
import { SupabaseAgentContextReader } from "./context-reader.js";

const ownerId = 998877;
const ids = {
  commitment1: "10000000-0000-4000-8000-000000000001",
  commitment2: "10000000-0000-4000-8000-000000000002",
  draft1: "20000000-0000-4000-8000-000000000001",
  draft2: "20000000-0000-4000-8000-000000000002",
  session1: "30000000-0000-4000-8000-000000000001",
} as const;

function response(overrides: Record<string, unknown> = {}) {
  return {
    commitments: [
      {
        definitionOfDone: "Send the launch proposal",
        id: ids.commitment1,
        providerCredential: "must-not-leak",
        status: "active",
        targetAt: "2026-08-01T02:00:00.000Z",
        version: 1,
      },
      {
        definitionOfDone: "Review the launch proposal",
        id: ids.commitment2,
        status: "done",
        targetAt: "2026-08-02T02:00:00.000Z",
        version: 2,
      },
    ],
    drafts: [
      {
        definitionOfDone: "Send the launch proposal",
        focused: true,
        fullCalendarEvent: { description: "must-not-leak" },
        id: ids.draft1,
        mode: "possible_work_session",
        phase: "complete",
        targetAt: "2026-08-01T02:00:00.000Z",
        version: 3,
      },
      {
        definitionOfDone: "Prepare the launch proposal",
        focused: false,
        id: ids.draft2,
        mode: "unresolved",
        phase: "awaiting_target",
        targetAt: null,
        version: 1,
      },
    ],
    focusedEntity: {
      entity: {
        definitionOfDone: "Send the launch proposal",
        focused: true,
        id: ids.draft1,
        mode: "possible_work_session",
        phase: "complete",
        targetAt: "2026-08-01T02:00:00.000Z",
        version: 3,
      },
      kind: "draft",
    },
    recentOutcomes: [
      {
        commitmentId: ids.commitment2,
        occurredAt: "2026-07-30T03:00:00.000Z",
        status: "done",
        workSessionId: ids.session1,
      },
    ],
    truncated: {
      commitments: false,
      drafts: false,
      recentOutcomes: false,
      workSessions: false,
    },
    workSessions: [
      {
        attendees: ["must-not-leak@example.com"],
        commitmentId: ids.commitment1,
        durationMinutes: 45,
        endAt: "2026-07-31T02:45:00.000Z",
        id: ids.session1,
        startAt: "2026-07-31T02:00:00.000Z",
        status: "planned",
      },
    ],
    ...overrides,
  };
}

function reader(fetchFromSupabase: typeof fetch) {
  return new SupabaseAgentContextReader({
    fetch: fetchFromSupabase,
    ownerId,
    supabaseSecretKey: "sb_secret_server-only",
    supabaseUrl: "http://127.0.0.1:54321",
  });
}

describe("SupabaseAgentContextReader", () => {
  it("returns one strict bounded product projection and exact focus", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json(response())
    );
    const context = await reader(
      fetchFromSupabase as typeof fetch,
    ).readProductContext({
      chatId: ownerId,
      focusedEntityId: ids.draft1,
      limit: 5,
      query: null,
    });

    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/read_agent_product_context",
      expect.objectContaining({
        body: JSON.stringify({
          p_focused_entity_id: ids.draft1,
          p_limit: 5,
          p_owner_id: String(ownerId),
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          apikey: "sb_secret_server-only",
        },
        method: "POST",
      }),
    );
    expect(context.focusedEntity).toEqual({
      entity: context.drafts[0],
      kind: "draft",
    });
    expect(context.workSessions).toEqual([
      {
        commitmentId: ids.commitment1,
        durationMinutes: 45,
        endAt: "2026-07-31T02:45:00.000Z",
        id: ids.session1,
        startAt: "2026-07-31T02:00:00.000Z",
        status: "planned",
      },
    ]);
    expect(JSON.stringify(context)).not.toMatch(
      /attendees|calendarEvent|credential|description|must-not-leak/i,
    );
  });

  it("returns bounded clarification candidates without changing data", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json(
        response({
          commitments: [
            {
              definitionOfDone: "Send the annual report",
              id: ids.commitment1,
              status: "active",
              targetAt: "2026-08-01T02:00:00.000Z",
              version: 1,
            },
            {
              definitionOfDone: "Review the annual report",
              id: ids.commitment2,
              status: "done",
              targetAt: "2026-08-02T02:00:00.000Z",
              version: 2,
            },
          ],
          drafts: [],
        }),
      )
    );
    const context = await reader(
      fetchFromSupabase as typeof fetch,
    ).readProductContext({
      chatId: ownerId,
      focusedEntityId: null,
      query: "move the report to Friday",
    });

    expect(context.ambiguity).toEqual({
      candidates: [
        {
          id: ids.commitment1,
          kind: "commitment",
          label: "Send the annual report",
          version: 1,
        },
        {
          id: ids.commitment2,
          kind: "commitment",
          label: "Review the annual report",
          version: 2,
        },
      ],
      query: "move the report to friday",
    });
    expect(fetchFromSupabase).toHaveBeenCalledTimes(1);
    expect(fetchFromSupabase.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("rejects non-owner and invalid requests before database access", async () => {
    const fetchFromSupabase = vi.fn();
    const contextReader = reader(fetchFromSupabase as typeof fetch);

    await expect(
      contextReader.readProductContext({
        chatId: ownerId + 1,
        focusedEntityId: null,
        query: null,
      }),
    ).rejects.toThrow("not authorized");
    await expect(
      contextReader.readProductContext({
        chatId: ownerId,
        focusedEntityId: "not-an-id",
        query: null,
      }),
    ).rejects.toThrow("focused entity id is invalid");
    await expect(
      contextReader.readProductContext({
        chatId: ownerId,
        focusedEntityId: null,
        limit: 11,
        query: null,
      }),
    ).rejects.toThrow("between 1 and 10");
    expect(fetchFromSupabase).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase exceeds a requested bound", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json(
        response({
          drafts: Array.from({ length: 3 }, (_, index) => ({
            definitionOfDone: `Draft ${index}`,
            focused: index === 0,
            id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            mode: "unresolved",
            phase: "awaiting_target",
            targetAt: null,
            version: 1,
          })),
        }),
      )
    );

    await expect(
      reader(fetchFromSupabase as typeof fetch).readProductContext({
        chatId: ownerId,
        focusedEntityId: null,
        limit: 2,
        query: null,
      }),
    ).rejects.toThrow("exceeded its bounds");
  });

  it("pages SDK-safe history through the owner session's opaque cursor", async () => {
    const storedItem = {
      content: [{ text: "Earlier owner turn", type: "input_text" }],
      role: "user",
    } as AgentInputItem;
    const readHistory = vi.fn(async () => ({
      items: [
        {
          item: storedItem,
          recordedAt: "2026-07-30T02:00:00.000Z",
          sequence: 7,
        },
      ],
      nextCursor: "opaque.encrypted.cursor",
    }));
    const session = {
      chatId: ownerId,
      readHistory,
    } as unknown as AgentSdkSession;

    await expect(
      reader(vi.fn() as unknown as typeof fetch).readHistory(
        session,
        "opaque.input.cursor",
        4,
      ),
    ).resolves.toEqual({
      items: [storedItem],
      nextCursor: "opaque.encrypted.cursor",
    });
    expect(readHistory).toHaveBeenCalledWith(
      "opaque.input.cursor",
      4,
    );
  });

  it("rejects history from a session not bound to the configured owner", async () => {
    const session = {
      chatId: ownerId + 1,
      readHistory: vi.fn(),
    } as unknown as AgentSdkSession;

    await expect(
      reader(vi.fn() as unknown as typeof fetch).readHistory(session),
    ).rejects.toThrow("not authorized");
    expect(session.readHistory).not.toHaveBeenCalled();
  });
});
