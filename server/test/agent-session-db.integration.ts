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

async function rpc(
  supabaseUrl: string,
  secretKey: string,
  name: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    body: JSON.stringify(body),
    headers: supabaseHeaders(secretKey, "application/json"),
    method: "POST",
  });
  expect(response.ok).toBe(true);
  return response.json();
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

describe("local Supabase durable agent persistence", () => {
  it("keeps encrypted SDK items with CAS and replay safety", async () => {
    const { config, session } = persistence();
    const identity = identities();
    const active = await session.open(identity.chatId);
    const durableItems = Array.from({ length: 16 }, (_, index) => ({
      content: `Private owner item ${index + 1}`,
      role: "user" as const,
    }));
    await active.addItems(durableItems);
    const initial = active.currentSnapshot();
    expect(initial.version).toBe(1);
    expect(initial.items.map((item) => item.item)).toEqual(
      durableItems,
    );
    const staleHandle = await session.open(identity.chatId);
    const first = await active.recordApplicationReply({
      activeDraftId: identity.draftId,
      assistantText: "Private application reply",
      pendingQuestion: "replace",
      updateId: identity.updateId,
    });
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") {
      throw new Error("agent application reply did not apply");
    }
    expect(first.session.version).toBe(2);
    expect(first.session.activeDraftId).toBe(identity.draftId);
    expect(first.session.itemCount).toBe(17);
    expect(first.session.interaction.pendingQuestion).toEqual({
      text: "Private application reply",
      updateId: identity.updateId,
    });

    const storedItems = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "agent_session_sdk_items",
      `&session_id=eq.${active.sessionId}`,
    );
    expect(storedItems).toHaveLength(17);
    expect(JSON.stringify(storedItems)).not.toContain("Private owner");
    expect(JSON.stringify(storedItems)).not.toContain(
      "Private application reply",
    );
    expect(
      storedItems.every(
        (item) =>
          typeof item.sealed_item === "string" &&
          String(item.sealed_item).includes(
            "shiori.agent.ephemeral.v1",
          ),
      ),
    ).toBe(true);

    await expect(
      active.recordApplicationReply({
        activeDraftId: identity.draftId,
        assistantText: "Duplicate application reply",
        pendingQuestion: "replace",
        updateId: identity.updateId,
      }),
    ).resolves.toMatchObject({
      kind: "replay",
      session: {
        itemCount: 17,
        version: 2,
      },
    });

    await expect(
      staleHandle.recordApplicationReply({
        activeDraftId: identity.draftId,
        assistantText: "Stale application reply",
        pendingQuestion: "replace",
        updateId: identity.updateId + 1,
      }),
    ).resolves.toEqual({ kind: "stale" });

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
        expectedSessionId: active.sessionId,
        reason: "confirmed",
        updateId: identity.updateId + 3,
      }),
    ).resolves.toEqual({ kind: "cleared" });
    await expect(session.read(identity.chatId)).resolves.toEqual({
      kind: "none",
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_session_sdk_items",
        `&session_id=eq.${active.sessionId}`,
      ),
    ).toEqual([]);
  });

  it("retries one exact approval and deletes it only on terminal paths", async () => {
    const { approval, config, session } = persistence();
    const identity = identities();
    const active = await session.open(identity.chatId);
    await active.addItems([
      {
        content: "Approval setup owner",
        role: "user",
      },
    ]);
    const created = await active.recordApplicationReply({
      activeDraftId: identity.draftId,
      assistantText: "Approval setup assistant",
      pendingQuestion: "clear",
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
      sessionId: active.sessionId,
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
      expiresAt: active.currentSnapshot().expiresAt,
      sealedRunState,
      sessionId: active.sessionId,
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
      expires_at: active.currentSnapshot().expiresAt,
      sealed_run_state: sealedRunState,
      session_id: active.sessionId,
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
    const approveCommand = {
      approvalId: restaged.approval.id,
      approvalVersion: restaged.approval.version,
      chatId: identity.chatId,
      decision: "approve",
      draftId: identity.draftId,
      draftVersion: 7,
      toolName: "execute_commitment",
      updateId: identity.updateId + 4,
    } as const;
    const claimed = {
      kind: "claimed",
      sealedRunState,
      sessionId: active.sessionId,
    } as const;
    await expect(approval.resolve(approveCommand)).resolves.toEqual(claimed);
    await expect(approval.resolve(approveCommand)).resolves.toEqual(claimed);
    await expect(
      approval.resolve({
        ...approveCommand,
        updateId: identity.updateId + 5,
      }),
    ).resolves.toEqual(claimed);
    await expect(
      approval.resolve({
        ...approveCommand,
        decision: "reject",
        updateId: identity.updateId + 6,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      approval.resolve({
        ...approveCommand,
        draftVersion: 8,
        updateId: identity.updateId + 7,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      approval.resolve({
        ...approveCommand,
        chatId: identity.chatId + 1,
        updateId: identity.updateId + 8,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      rpc(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "resolve_agent_approval",
        {
          p_approval_id: approveCommand.approvalId,
          p_approval_version: approveCommand.approvalVersion,
          p_chat_id: approveCommand.chatId,
          p_decision: "approve",
          p_draft_id: approveCommand.draftId,
          p_draft_version: approveCommand.draftVersion,
          p_tool_name: "read_calendar",
          p_update_id: identity.updateId + 9,
        },
      ),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      approval.read(
        identity.chatId,
        identity.draftId,
        7,
        "execute_commitment",
      ),
    ).resolves.toEqual({
      approval: restaged.approval,
      kind: "current",
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_pending_approvals",
        `&id=eq.${restaged.approval.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        approved_update_id: identity.updateId + 4,
        sealed_run_state: sealedRunState,
      }),
    ]);
    await expect(
      approval.clearForSession(active.sessionId, "confirmed"),
    ).resolves.toBeUndefined();

    const cleared = await approval.stage({
      ...stageCommand,
      updateId: identity.updateId + 10,
    });
    expect(cleared.kind).toBe("staged");
    await expect(
      approval.clearForSession(active.sessionId, "cancelled"),
    ).resolves.toBeUndefined();
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_pending_approvals",
        `&session_id=eq.${active.sessionId}`,
      ),
    ).toEqual([]);

    const sessionBound = await approval.stage({
      ...stageCommand,
      updateId: identity.updateId + 11,
    });
    expect(sessionBound.kind).toBe("staged");
    if (sessionBound.kind !== "staged") {
      throw new Error("session-bound approval did not stage");
    }
    const changedSession = await active.recordApplicationReply({
      activeDraftId: crypto.randomUUID(),
      assistantText: "Changed active draft",
      pendingQuestion: "clear",
      updateId: identity.updateId + 30,
    });
    expect(changedSession.kind).toBe("applied");
    await expect(
      approval.resolve({
        approvalId: sessionBound.approval.id,
        approvalVersion: sessionBound.approval.version,
        chatId: identity.chatId,
        decision: "approve",
        draftId: identity.draftId,
        draftVersion: 7,
        toolName: "execute_commitment",
        updateId: identity.updateId + 12,
      }),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      session.clear({
        chatId: identity.chatId,
        expectedSessionId: active.sessionId,
        reason: "confirmed",
        updateId: identity.updateId + 13,
      }),
    ).resolves.toEqual({ kind: "cleared" });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "agent_pending_approvals",
        `&session_id=eq.${active.sessionId}`,
      ),
    ).toEqual([]);
  });
});
