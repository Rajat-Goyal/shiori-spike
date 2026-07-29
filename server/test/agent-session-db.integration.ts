import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { createAgentSessionCipher } from "../src/agent/session-crypto.js";
import {
  SupabaseAgentApprovalRepository,
  SupabaseAgentSessionRepository,
} from "../src/agent/supabase-session-repository.js";
import { supabaseHeaders } from "../src/supabase.js";

function localConfig() {
  const config = readServerConfig();
  const url = new URL(config.supabaseUrl);
  const expectedPort =
    process.env.SHIORI_TEST_SUPABASE_PORT ?? "54321";
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== expectedPort
  ) {
    throw new Error(
      `test:db is restricted to the Docker-generated local Supabase API on port ${expectedPort}`,
    );
  }
  return config;
}

async function rows(
  supabaseUrl: string,
  secretKey: string,
  table: string,
  query = "",
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${table}?select=*${query}`,
    { headers: supabaseHeaders(secretKey) },
  );
  expect(response.ok).toBe(true);
  const value: unknown = await response.json();
  expect(Array.isArray(value)).toBe(true);
  return value as Array<Record<string, unknown>>;
}

function persistence() {
  const config = localConfig();
  const cipher = createAgentSessionCipher(
    Buffer.alloc(32, 61).toString("base64"),
  );
  return {
    approval: new SupabaseAgentApprovalRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    }),
    config,
    session: new SupabaseAgentSessionRepository({
      cipher,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    }),
  };
}

function identities() {
  const seed = 10_000_000_000 + randomInt(100_000_000);
  return {
    chatId: seed,
    draftId: crypto.randomUUID(),
    updateId: seed + 100_000_000,
  };
}

describe("local Supabase ephemeral agent persistence", () => {
  it("keeps a fixed-lifetime encrypted six-turn window with CAS and replay safety", async () => {
    const { config, session } = persistence();
    const identity = identities();
    const first = await session.recordTurn({
      activeDraftId: identity.draftId,
      assistantText: "Private assistant turn 1",
      chatId: identity.chatId,
      expected: { kind: "none" },
      ownerText: "Private owner turn 1",
      updateId: identity.updateId,
    });
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") {
      throw new Error("initial agent session turn did not apply");
    }
    const initialExpiry = first.session.expiresAt;
    let current = first.session;

    for (let index = 2; index <= 8; index += 1) {
      const result = await session.recordTurn({
        activeDraftId: identity.draftId,
        assistantText: `Private assistant turn ${index}`,
        chatId: identity.chatId,
        expected: {
          id: current.id,
          kind: "active",
          version: current.version,
        },
        ownerText: `Private owner turn ${index}`,
        updateId: identity.updateId + index - 1,
      });
      expect(result.kind).toBe("applied");
      if (result.kind !== "applied") {
        throw new Error("agent session continuation did not apply");
      }
      current = result.session;
      expect(current.expiresAt).toBe(initialExpiry);
    }

    expect(current.version).toBe(8);
    expect(current.turns).toHaveLength(6);
    expect(current.turns.map((turn) => turn.updateId)).toEqual(
      Array.from(
        { length: 6 },
        (_, index) => identity.updateId + index + 2,
      ),
    );
    expect(current.turns[0]).toMatchObject({
      assistantText: "Private assistant turn 3",
      ownerText: "Private owner turn 3",
    });

    const storedTurns = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "agent_session_turns",
      `&session_id=eq.${current.id}`,
    );
    expect(storedTurns).toHaveLength(6);
    expect(JSON.stringify(storedTurns)).not.toContain("Private owner");
    expect(JSON.stringify(storedTurns)).not.toContain("Private assistant");
    expect(
      storedTurns.every(
        (turn) =>
          typeof turn.sealed_turn === "string" &&
          String(turn.sealed_turn).includes(
            "shiori.agent.ephemeral.v1",
          ),
      ),
    ).toBe(true);

    await expect(
      session.recordTurn({
        activeDraftId: identity.draftId,
        assistantText: "duplicate assistant",
        chatId: identity.chatId,
        expected: {
          id: current.id,
          kind: "active",
          version: current.version,
        },
        ownerText: "duplicate owner",
        updateId: identity.updateId + 7,
      }),
    ).resolves.toEqual({ kind: "replay" });

    const staleUpdateId = identity.updateId + 20;
    await expect(
      session.recordTurn({
        activeDraftId: identity.draftId,
        assistantText: "stale assistant",
        chatId: identity.chatId,
        expected: {
          id: current.id,
          kind: "active",
          version: current.version - 1,
        },
        ownerText: "stale owner",
        updateId: staleUpdateId,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      session.recordTurn({
        activeDraftId: identity.draftId,
        assistantText: "stale retry assistant",
        chatId: identity.chatId,
        expected: {
          id: current.id,
          kind: "active",
          version: current.version,
        },
        ownerText: "stale retry owner",
        updateId: staleUpdateId,
      }),
    ).resolves.toEqual({ kind: "replay" });

    await expect(
      session.clear({
        chatId: identity.chatId,
        expectedSessionId: crypto.randomUUID(),
        reason: "cancelled",
        updateId: identity.updateId + 21,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      session.clear({
        chatId: identity.chatId,
        expectedSessionId: current.id,
        reason: "confirmed",
        updateId: identity.updateId + 22,
      }),
    ).resolves.toEqual({ kind: "cleared" });
    await expect(session.read(identity.chatId)).resolves.toEqual({
      kind: "none",
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_session_turns",
        `&session_id=eq.${current.id}`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_session_update_receipts",
        `&chat_id=eq.${identity.chatId}`,
      ),
    ).toHaveLength(11);
  });

  it("binds one opaque approval to the exact live session and deletes it on every terminal path", async () => {
    const { approval, config, session } = persistence();
    const identity = identities();
    const created = await session.recordTurn({
      activeDraftId: identity.draftId,
      assistantText: "Approval setup assistant",
      chatId: identity.chatId,
      expected: { kind: "none" },
      ownerText: "Approval setup owner",
      updateId: identity.updateId,
    });
    expect(created.kind).toBe("applied");
    if (created.kind !== "applied") {
      throw new Error("approval session did not apply");
    }

    const sealedRunState = "opaque-run-state-not-inspected";
    const stageCommand = {
      chatId: identity.chatId,
      draftId: identity.draftId,
      draftVersion: 7,
      expected: { kind: "none" },
      sealedRunState,
      sessionId: created.session.id,
      toolName: "execute_commitment",
      updateId: identity.updateId,
    } as const;
    const staged = await approval.stage(stageCommand);
    expect(staged.kind).toBe("staged");
    if (staged.kind !== "staged") {
      throw new Error("approval did not stage");
    }
    expect(staged.approval).toMatchObject({
      chatId: identity.chatId,
      draftId: identity.draftId,
      draftVersion: 7,
      expiresAt: created.session.expiresAt,
      sealedRunState,
      sessionId: created.session.id,
      toolName: "execute_commitment",
      version: 1,
    });
    await expect(approval.stage(stageCommand)).resolves.toEqual({
      kind: "replay",
    });
    await expect(
      approval.read(
        identity.chatId,
        identity.draftId,
        7,
        "execute_commitment",
      ),
    ).resolves.toEqual({
      approval: staged.approval,
      kind: "current",
    });

    const approvalRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "agent_pending_approvals",
      `&id=eq.${staged.approval.id}`,
    );
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]).toMatchObject({
      chat_id: identity.chatId,
      draft_id: identity.draftId,
      draft_version: 7,
      expires_at: created.session.expiresAt,
      sealed_run_state: sealedRunState,
      session_id: created.session.id,
      tool_name: "execute_commitment",
      version: 1,
    });

    const staleResolve = {
      approvalId: staged.approval.id,
      approvalVersion: 2,
      chatId: identity.chatId,
      decision: "approve",
      draftId: identity.draftId,
      draftVersion: 7,
      toolName: "execute_commitment",
      updateId: identity.updateId + 1,
    } as const;
    await expect(approval.resolve(staleResolve)).resolves.toEqual({
      kind: "stale",
    });
    await expect(
      approval.resolve({
        ...staleResolve,
        approvalVersion: 1,
      }),
    ).resolves.toEqual({ kind: "replay" });

    await expect(
      approval.resolve({
        ...staleResolve,
        approvalVersion: 1,
        decision: "reject",
        updateId: identity.updateId + 2,
      }),
    ).resolves.toEqual({ kind: "rejected" });
    await expect(
      approval.read(
        identity.chatId,
        identity.draftId,
        7,
        "execute_commitment",
      ),
    ).resolves.toEqual({ kind: "missing" });

    const restaged = await approval.stage({
      ...stageCommand,
      updateId: identity.updateId + 3,
    });
    expect(restaged.kind).toBe("staged");
    if (restaged.kind !== "staged") {
      throw new Error("approval did not restage");
    }
    await expect(
      approval.resolve({
        approvalId: restaged.approval.id,
        approvalVersion: restaged.approval.version,
        chatId: identity.chatId,
        decision: "approve",
        draftId: identity.draftId,
        draftVersion: 7,
        toolName: "execute_commitment",
        updateId: identity.updateId + 4,
      }),
    ).resolves.toEqual({
      kind: "claimed",
      sealedRunState,
      sessionId: created.session.id,
    });
    await expect(
      approval.read(
        identity.chatId,
        identity.draftId,
        7,
        "execute_commitment",
      ),
    ).resolves.toEqual({ kind: "missing" });

    const cleared = await approval.stage({
      ...stageCommand,
      updateId: identity.updateId + 5,
    });
    expect(cleared.kind).toBe("staged");
    await expect(
      approval.clearForSession(created.session.id, "cancelled"),
    ).resolves.toBeUndefined();
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_pending_approvals",
        `&session_id=eq.${created.session.id}`,
      ),
    ).toEqual([]);

    await expect(
      approval.stage({
        ...stageCommand,
        updateId: identity.updateId + 6,
      }),
    ).resolves.toMatchObject({ kind: "staged" });
    await expect(
      session.clear({
        chatId: identity.chatId,
        expectedSessionId: created.session.id,
        reason: "confirmed",
        updateId: identity.updateId + 7,
      }),
    ).resolves.toEqual({ kind: "cleared" });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_pending_approvals",
        `&session_id=eq.${created.session.id}`,
      ),
    ).toEqual([]);
  });
});
