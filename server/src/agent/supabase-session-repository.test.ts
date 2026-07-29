import { describe, expect, it, vi } from "vitest";
import { createAgentSessionCipher } from "./session-crypto.js";
import {
  SupabaseAgentApprovalRepository,
  SupabaseAgentSessionRepository,
} from "./supabase-session-repository.js";

const secret = Buffer.alloc(32, 31).toString("base64");
const sessionId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const expiresAt = "2026-07-30T12:00:00.000Z";
const recordedAt = "2026-07-29T12:00:00.000Z";

function cipher() {
  let next = 1;
  return createAgentSessionCipher(secret, () =>
    Buffer.alloc(12, next++),
  );
}

function sessionRepository(
  fetchFromSupabase: typeof fetch,
  sessionCipher = cipher(),
) {
  return new SupabaseAgentSessionRepository({
    cipher: sessionCipher,
    createSessionId: () => sessionId,
    fetch: fetchFromSupabase,
    supabaseSecretKey: "header.payload.signature",
    supabaseUrl: "http://127.0.0.1:54321",
  });
}

function approvalRepository(fetchFromSupabase: typeof fetch) {
  return new SupabaseAgentApprovalRepository({
    fetch: fetchFromSupabase,
    supabaseSecretKey: "header.payload.signature",
    supabaseUrl: "http://127.0.0.1:54321",
  });
}

describe("SupabaseAgentSessionRepository", () => {
  it("persists more than six SDK items encrypted and restores the same session", async () => {
    const sessionCipher = cipher();
    const durableItems = Array.from({ length: 16 }, (_, index) => ({
      content: `private owner item ${index}`,
      role: "user" as const,
    }));
    let persistedSnapshot: Record<string, unknown> | undefined;
    const fetchFromSupabase = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<
        string,
        unknown
      >;
      if (!("p_items" in body)) {
        return Response.json(
          persistedSnapshot === undefined
            ? { kind: "none" }
            : { kind: "active", session: persistedSnapshot },
        );
      }
      expect(JSON.stringify(body)).not.toContain("private owner item");
      const sealed = body.p_items as Array<{
        id: string;
        sealedItem: string;
      }>;
      persistedSnapshot = {
        activeDraftId: null,
        chatId: 123,
        compaction: null,
        expiresAt,
        firstWorkingSequence: 1,
        id: sessionId,
        interaction: null,
        itemCount: sealed.length,
        items: sealed.map((item, index) => ({
          ...item,
          recordedAt,
          sequence: index + 1,
        })),
        version: 1,
      };
      return Response.json({
        kind: "applied",
        session: persistedSnapshot,
      });
    });
    const repository = sessionRepository(
      fetchFromSupabase as typeof fetch,
      sessionCipher,
    );
    const session = await repository.open(123);
    await session.addItems(durableItems);

    expect(await session.getItems()).toEqual(durableItems);
    const restarted = await repository.open(123);
    expect(await restarted.getSessionId()).toBe(sessionId);
    expect(await restarted.getItems()).toEqual(durableItems);
    const [url, options] = fetchFromSupabase.mock.calls[1];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/append_agent_sdk_items",
    );
    expect(options?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer header.payload.signature",
      "Content-Type": "application/json",
      apikey: "header.payload.signature",
    });
    expect(
      JSON.parse(String(options?.body)),
    ).toMatchObject({
      p_chat_id: 123,
      p_expected_session_id: null,
      p_expected_version: 0,
      p_proposed_session_id: sessionId,
      p_retention_seconds: 2_592_000,
    });
  });

  it("opens only SDK ciphertext bound to the exact session, chat, and item", async () => {
    const sessionCipher = cipher();
    const itemId = "44444444-4444-4444-8444-444444444444";
    const sealedItem = sessionCipher.seal(
      JSON.stringify({ content: "bounded owner", role: "user" }),
      {
        chatId: 123,
        itemId,
        sessionId,
        type: "session_item",
      },
    );
    const active = {
      activeDraftId: null,
      chatId: 123,
      compaction: null,
      expiresAt,
      firstWorkingSequence: 1,
      id: sessionId,
      interaction: null,
      itemCount: 1,
      items: [{
        id: itemId,
        recordedAt,
        sealedItem,
        sequence: 1,
      }],
      version: 7,
    };
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ kind: "active", session: active }),
    );

    await expect(
      sessionRepository(
        fetchFromSupabase as typeof fetch,
        sessionCipher,
      ).read(123),
    ).resolves.toMatchObject({
      kind: "active",
      session: {
        items: [
          {
            item: { content: "bounded owner", role: "user" },
            sequence: 1,
          },
        ],
        version: 7,
      },
    });

    const tamperedFetch = vi.fn(async () =>
      Response.json({
        kind: "active",
        session: { ...active, chatId: 124 },
      }),
    );
    await expect(
      sessionRepository(
        tamperedFetch as typeof fetch,
        sessionCipher,
      ).read(124),
    ).rejects.toThrow("Agent session persistence returned invalid data");
  });

  it("encrypts relevant callback and pending-question context", async () => {
    const sessionCipher = cipher();
    let persistedSnapshot: Record<string, unknown> | undefined;
    const fetchFromSupabase = vi.fn(async (url, options) => {
      if (String(url).endsWith("/read_agent_sdk_session")) {
        return Response.json({
          kind: "active",
          session: {
            activeDraftId: draftId,
            chatId: 123,
            compaction: null,
            expiresAt,
            firstWorkingSequence: null,
            id: sessionId,
            interaction: null,
            itemCount: 0,
            items: [],
            version: 1,
          },
        });
      }
      const body = JSON.parse(String(options?.body));
      expect(JSON.stringify(body)).not.toContain("private callback reply");
      expect(JSON.stringify(body)).not.toContain("confirm");
      if (persistedSnapshot !== undefined) {
        return Response.json({
          kind: "replay",
          session: persistedSnapshot,
        });
      }
      persistedSnapshot = {
        activeDraftId: draftId,
        chatId: 123,
        compaction: null,
        expiresAt,
        firstWorkingSequence: 1,
        id: sessionId,
        interaction: {
          contextId: body.p_context_id,
          sealedContext: body.p_sealed_context,
        },
        itemCount: 1,
        items: [{
          id: body.p_item_id,
          recordedAt,
          sealedItem: body.p_sealed_item,
          sequence: 1,
        }],
        version: 2,
      };
      return Response.json({
        kind: "applied",
        session: persistedSnapshot,
      });
    });
    const session = await sessionRepository(
      fetchFromSupabase as typeof fetch,
      sessionCipher,
    ).open(123);

    await expect(
      session.recordCallbackChoice({
        action: "confirm",
        assistantText: "private callback reply",
        pendingQuestion: true,
        updateId: 75,
      }),
    ).resolves.toMatchObject({ kind: "applied" });
    expect(session.currentSnapshot()).toMatchObject({
      interaction: {
        callbackChoice: { action: "confirm", updateId: 75 },
        pendingQuestion: {
          text: "private callback reply",
          updateId: 75,
        },
      },
      items: [{
        item: {
          content: [{
            text: "private callback reply",
            type: "output_text",
          }],
          role: "assistant",
        },
      }],
    });
    await expect(
      session.recordCallbackChoice({
        action: "confirm",
        assistantText: "private callback reply",
        pendingQuestion: true,
        updateId: 75,
      }),
    ).resolves.toMatchObject({ kind: "replay" });
    expect(session.currentSnapshot().itemCount).toBe(1);
    const firstWrite = JSON.parse(
      String(fetchFromSupabase.mock.calls[1][1]?.body),
    );
    const replayWrite = JSON.parse(
      String(fetchFromSupabase.mock.calls[2][1]?.body),
    );
    expect(replayWrite.p_operation_id).toBe(firstWrite.p_operation_id);
    expect(replayWrite.p_item_id).not.toBe(firstWrite.p_item_id);
  });

  it("records an ordinary answer without replacing the pending interaction", async () => {
    const sessionCipher = cipher();
    const contextId = "55555555-5555-4555-8555-555555555555";
    const pendingInteraction = {
      callbackChoice: {
        action: "work_session.no_preparation",
        updateId: 74,
      },
      pendingQuestion: {
        text: "Do you need preparation time?",
        updateId: 73,
      },
    };
    const sealedContext = sessionCipher.seal(
      JSON.stringify(pendingInteraction),
      {
        chatId: 123,
        contextId,
        sessionId,
        type: "session_context",
      },
    );
    const fetchFromSupabase = vi.fn(async (url, options) => {
      if (String(url).endsWith("/read_agent_sdk_session")) {
        return Response.json({
          kind: "active",
          session: {
            activeDraftId: draftId,
            chatId: 123,
            compaction: null,
            expiresAt,
            firstWorkingSequence: null,
            id: sessionId,
            interaction: { contextId, sealedContext },
            itemCount: 0,
            items: [],
            version: 7,
          },
        });
      }
      const body = JSON.parse(String(options?.body));
      expect(JSON.stringify(body)).not.toContain(
        "Do you need preparation time?",
      );
      return Response.json({
        kind: "applied",
        session: {
          activeDraftId: draftId,
          chatId: 123,
          compaction: null,
          expiresAt,
          firstWorkingSequence: 1,
          id: sessionId,
          interaction: {
            contextId: body.p_context_id,
            sealedContext: body.p_sealed_context,
          },
          itemCount: 1,
          items: [{
            id: body.p_item_id,
            recordedAt,
            sealedItem: body.p_sealed_item,
            sequence: 1,
          }],
          version: 8,
        },
      });
    });
    const session = await sessionRepository(
      fetchFromSupabase as typeof fetch,
      sessionCipher,
    ).open(123);

    await expect(
      session.recordApplicationReply({
        activeDraftId: draftId,
        assistantText: "Singapore uses UTC+08:00.",
        pendingQuestion: "preserve",
        updateId: 75,
      }),
    ).resolves.toMatchObject({ kind: "applied" });

    expect(session.currentSnapshot().interaction).toEqual(
      pendingInteraction,
    );
  });

  it("pages older items without overlap using an encrypted cursor", async () => {
    const sessionCipher = cipher();
    const sealed = (sequence: number) => {
      const id = `${String(sequence).padStart(8, "0")}-4444-4444-8444-444444444444`;
      return {
        id,
        recordedAt,
        sealedItem: sessionCipher.seal(
          JSON.stringify({
            content: `item-${sequence}`,
            role: "user",
          }),
          {
            chatId: 123,
            itemId: id,
            sessionId,
            type: "session_item",
          },
        ),
        sequence,
      };
    };
    const working = Array.from({ length: 40 }, (_, index) =>
      sealed(index + 61)
    );
    const fetchFromSupabase = vi.fn(async (url, options) => {
      if (String(url).endsWith("/read_agent_sdk_session")) {
        return Response.json({
          kind: "active",
          session: {
            activeDraftId: null,
            chatId: 123,
            compaction: null,
            expiresAt,
            firstWorkingSequence: 61,
            id: sessionId,
            interaction: null,
            itemCount: 100,
            items: working,
            version: 4,
          },
        });
      }
      const body = JSON.parse(String(options?.body));
      const end = Number(body.p_before_sequence) - 1;
      const start = Math.max(1, end - 19);
      return Response.json({
        items: Array.from({ length: end - start + 1 }, (_, index) =>
          sealed(start + index)
        ),
        kind: "active",
        nextBeforeSequence: start === 1 ? null : start,
      });
    });
    const session = await sessionRepository(
      fetchFromSupabase as typeof fetch,
      sessionCipher,
    ).open(123);
    const first = await session.readHistory();
    const second = await session.readHistory(first.nextCursor!);

    expect(first.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 41),
    );
    expect(second.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 21),
    );
    expect(first.nextCursor).not.toContain("41");
    expect(
      new Set([...first.items, ...second.items].map((item) => item.sequence))
        .size,
    ).toBe(40);
    expect(
      JSON.parse(String(fetchFromSupabase.mock.calls[2][1]?.body)),
    ).toMatchObject({ p_before_sequence: 41, p_limit: 40 });
  });

  it("drops reasoning items and resets only the durable agent session", async () => {
    const fetchFromSupabase = vi.fn(async (url, options) => {
      if (String(url).endsWith("/read_agent_sdk_session")) {
        return Response.json({ kind: "none" });
      }
      if (String(url).endsWith("/append_agent_sdk_items")) {
        const body = JSON.parse(String(options?.body));
        expect(body.p_items).toHaveLength(1);
        return Response.json({
          kind: "applied",
          session: {
            activeDraftId: null,
            chatId: 123,
            compaction: null,
            expiresAt,
            firstWorkingSequence: 1,
            id: sessionId,
            interaction: null,
            itemCount: 1,
            items: [{
              ...body.p_items[0],
              recordedAt,
              sequence: 1,
            }],
            version: 1,
          },
        });
      }
      return Response.json({ kind: "cleared" });
    });
    const session = await sessionRepository(
      fetchFromSupabase as typeof fetch,
    ).open(123);
    await session.addItems([
      {
        content: "durable",
        id: "provider-response-item",
        providerData: { privateProviderPayload: "must-not-persist" },
        role: "user",
      },
      {
        content: [],
        type: "reasoning",
      },
    ]);
    expect(await session.getItems()).toEqual([
      { content: "durable", role: "user" },
    ]);
    await session.reset("forget");
    expect(
      JSON.parse(String(fetchFromSupabase.mock.calls[2][1]?.body)),
    ).toEqual({
      p_chat_id: 123,
      p_mode: "forget",
      p_session_id: sessionId,
    });
  });

  it("fails closed on malformed persistence responses", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ kind: "active", session: { turns: [] } }),
    );
    await expect(
      sessionRepository(fetchFromSupabase as typeof fetch).read(123),
    ).rejects.toThrow("Agent session persistence returned invalid data");
  });
});

describe("SupabaseAgentApprovalRepository", () => {
  const approval = {
    chatId: 123,
    draftId,
    draftVersion: 4,
    expiresAt,
    id: approvalId,
    sealedRunState: "opaque sealed run state",
    sessionId,
    toolName: "execute_commitment",
    version: 1,
  } as const;

  it("stages and reads opaque run state without inspecting it", async () => {
    const fetchFromSupabase = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<
        string,
        unknown
      >;
      return Response.json(
        "p_expected_kind" in body
          ? { approval, kind: "staged" }
          : { approval, kind: "current" },
      );
    });
    const repository = approvalRepository(
      fetchFromSupabase as typeof fetch,
    );

    await expect(
      repository.stage({
        chatId: 123,
        draftId,
        draftVersion: 4,
        expected: { kind: "none" },
        sealedRunState: approval.sealedRunState,
        sessionId,
        toolName: "execute_commitment",
        updateId: 51,
      }),
    ).resolves.toEqual({ approval, kind: "staged" });
    await expect(
      repository.read(123, draftId, 4, "execute_commitment"),
    ).resolves.toEqual({ approval, kind: "current" });

    expect(
      JSON.parse(String(fetchFromSupabase.mock.calls[0][1]?.body)),
    ).toEqual({
      p_chat_id: 123,
      p_draft_id: draftId,
      p_draft_version: 4,
      p_expected_kind: "none",
      p_sealed_run_state: approval.sealedRunState,
      p_session_id: sessionId,
      p_tool_name: "execute_commitment",
      p_update_id: 51,
    });
  });

  it("claims only an exact approval and distinguishes rejection", async () => {
    const responses = [
      {
        kind: "claimed",
        sealedRunState: approval.sealedRunState,
        sessionId,
      },
      {
        kind: "claimed",
        sealedRunState: approval.sealedRunState,
        sessionId,
      },
      { kind: "rejected" },
      { kind: "replay" },
    ];
    const fetchFromSupabase = vi.fn(async () =>
      Response.json(responses.shift()),
    );
    const repository = approvalRepository(
      fetchFromSupabase as typeof fetch,
    );
    const command = {
      approvalId,
      approvalVersion: 1,
      chatId: 123,
      decision: "approve",
      draftId,
      draftVersion: 4,
      toolName: "execute_commitment",
      updateId: 52,
    } as const;

    await expect(repository.resolve(command)).resolves.toEqual({
      kind: "claimed",
      sealedRunState: approval.sealedRunState,
      sessionId,
    });
    await expect(
      repository.resolve({ ...command, updateId: 53 }),
    ).resolves.toEqual({
      kind: "claimed",
      sealedRunState: approval.sealedRunState,
      sessionId,
    });
    await expect(
      repository.resolve({
        ...command,
        decision: "reject",
        updateId: 54,
      }),
    ).resolves.toEqual({ kind: "rejected" });
    await expect(
      repository.resolve({ ...command, updateId: 55 }),
    ).resolves.toEqual({ kind: "replay" });
  });

  it("clears pending approval state by session without returning it", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ cleared: true }),
    );
    await expect(
      approvalRepository(
        fetchFromSupabase as typeof fetch,
      ).clearForSession(sessionId, "cancelled"),
    ).resolves.toBeUndefined();
    expect(
      JSON.parse(String(fetchFromSupabase.mock.calls[0][1]?.body)),
    ).toEqual({
      p_reason: "cancelled",
      p_session_id: sessionId,
    });
  });
});
