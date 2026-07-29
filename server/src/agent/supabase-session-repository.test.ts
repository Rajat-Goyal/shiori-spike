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
  it("seals a new turn before sending it and returns plaintext only after opening", async () => {
    const sessionCipher = cipher();
    const fetchFromSupabase = vi.fn(async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(body)).not.toContain("private owner turn");
      expect(JSON.stringify(body)).not.toContain("private assistant turn");
      return Response.json({
        kind: "applied",
        session: {
          activeDraftId: draftId,
          chatId: 123,
          expiresAt,
          id: sessionId,
          turns: [
            {
              recordedAt,
              sealedTurn: body.p_sealed_turn,
              updateId: 41,
            },
          ],
          version: 1,
        },
      });
    });

    await expect(
      sessionRepository(
        fetchFromSupabase as typeof fetch,
        sessionCipher,
      ).recordTurn({
        activeDraftId: draftId,
        assistantText: "private assistant turn",
        chatId: 123,
        expected: { kind: "none" },
        ownerText: "private owner turn",
        updateId: 41,
      }),
    ).resolves.toEqual({
      kind: "applied",
      session: {
        activeDraftId: draftId,
        chatId: 123,
        expiresAt,
        id: sessionId,
        turns: [
          {
            assistantText: "private assistant turn",
            ownerText: "private owner turn",
            recordedAt,
            updateId: 41,
          },
        ],
        version: 1,
      },
    });

    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/record_agent_session_turn",
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
      p_active_draft_id: draftId,
      p_chat_id: 123,
      p_expected_kind: "none",
      p_expected_session_id: null,
      p_expected_version: null,
      p_proposed_session_id: sessionId,
      p_update_id: 41,
    });
  });

  it("opens only ciphertext bound to the exact session, chat, and update", async () => {
    const sessionCipher = cipher();
    const sealedTurn = sessionCipher.seal(
      JSON.stringify({
        assistantText: "bounded assistant",
        ownerText: "bounded owner",
      }),
      {
        chatId: 123,
        sessionId,
        type: "session_turn",
        updateId: 42,
      },
    );
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        kind: "active",
        session: {
          activeDraftId: null,
          chatId: 123,
          expiresAt,
          id: sessionId,
          turns: [{ recordedAt, sealedTurn, updateId: 42 }],
          version: 7,
        },
      }),
    );

    await expect(
      sessionRepository(
        fetchFromSupabase as typeof fetch,
        sessionCipher,
      ).read(123),
    ).resolves.toMatchObject({
      kind: "active",
      session: {
        turns: [
          {
            assistantText: "bounded assistant",
            ownerText: "bounded owner",
            updateId: 42,
          },
        ],
        version: 7,
      },
    });

    const tamperedFetch = vi.fn(async () =>
      Response.json({
        kind: "active",
        session: {
          activeDraftId: null,
          chatId: 124,
          expiresAt,
          id: sessionId,
          turns: [{ recordedAt, sealedTurn, updateId: 42 }],
          version: 7,
        },
      }),
    );
    await expect(
      sessionRepository(
        tamperedFetch as typeof fetch,
        sessionCipher,
      ).read(124),
    ).rejects.toThrow("Agent session persistence returned invalid data");
  });

  it("uses active identity and version for CAS without extending the API shape", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ kind: "stale" }),
    );
    await expect(
      sessionRepository(fetchFromSupabase as typeof fetch).recordTurn({
        activeDraftId: null,
        assistantText: "assistant",
        chatId: 123,
        expected: { id: sessionId, kind: "active", version: 5 },
        ownerText: "owner",
        updateId: 43,
      }),
    ).resolves.toEqual({ kind: "stale" });

    expect(
      JSON.parse(String(fetchFromSupabase.mock.calls[0][1]?.body)),
    ).toMatchObject({
      p_expected_kind: "active",
      p_expected_session_id: sessionId,
      p_expected_version: 5,
      p_proposed_session_id: sessionId,
      p_update_id: 43,
    });
  });

  it("maps bounded read, replay, and clear results", async () => {
    const responses = [
      { kind: "none" },
      { kind: "expired" },
      { kind: "replay" },
      { kind: "cleared" },
    ];
    const fetchFromSupabase = vi.fn(async () =>
      Response.json(responses.shift()),
    );
    const repository = sessionRepository(
      fetchFromSupabase as typeof fetch,
    );

    await expect(repository.read(123)).resolves.toEqual({ kind: "none" });
    await expect(repository.read(123)).resolves.toEqual({
      kind: "expired",
    });
    await expect(
      repository.recordTurn({
        activeDraftId: null,
        assistantText: "assistant",
        chatId: 123,
        expected: { kind: "none" },
        ownerText: "owner",
        updateId: 44,
      }),
    ).resolves.toEqual({ kind: "replay" });
    await expect(
      repository.clear({
        chatId: 123,
        expectedSessionId: sessionId,
        reason: "confirmed",
        updateId: 45,
      }),
    ).resolves.toEqual({ kind: "cleared" });
    expect(
      JSON.parse(String(fetchFromSupabase.mock.calls[3][1]?.body)),
    ).toEqual({
      p_chat_id: 123,
      p_expected_session_id: sessionId,
      p_reason: "confirmed",
      p_update_id: 45,
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
      repository.resolve({
        ...command,
        decision: "reject",
        updateId: 53,
      }),
    ).resolves.toEqual({ kind: "rejected" });
    await expect(
      repository.resolve({ ...command, updateId: 54 }),
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
