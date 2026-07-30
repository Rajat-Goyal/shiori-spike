import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";

function localConfig() {
  const config = readServerConfig();
  const url = new URL(config.supabaseUrl);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== (process.env.SHIORI_TEST_SUPABASE_PORT ?? "54321")
  ) {
    throw new Error("conversation control DB tests require local Supabase");
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
  const body: unknown = await response.json();
  expect(Array.isArray(body)).toBe(true);
  return body as Array<Record<string, unknown>>;
}

function futureTarget(hours = 48): string {
  const singapore = new Date(
    Date.now() + hours * 60 * 60 * 1_000 + 8 * 60 * 60 * 1_000,
  );
  return `${singapore.toISOString().slice(0, 19)}+08:00`;
}

function audit(
  fields: DecisionContextFields,
  inputClass: DecisionAudit["inputClass"],
  turnRelation: DecisionAudit["payload"]["turnRelation"],
  nextAction: DecisionAudit["payload"]["nextAction"],
): DecisionAudit {
  return {
    inputClass,
    modelId: "gpt-test-model",
    payload: {
      ...fields,
      missingFields: [],
      nextAction,
      turnRelation,
    },
    promptVersion: "shiori-test-v1",
  };
}

describe("local Supabase conversation controls", () => {
  it("parks and resolves separate permission focus, replays exactly, and resets only unconfirmed state", async () => {
    const config = localConfig();
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const base = 9_700_000_000 + randomInt(100_000_000);
    const confirmedBefore = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "commitments",
    );

    await telegram.claimUpdate(base, config.telegramOwnerUserId);
    await expect(
      conversation.resetUnconfirmed(base, config.telegramOwnerUserId),
    ).resolves.toMatchObject({ completed: true, status: "applied" });

    const oldFields: DecisionContextFields = {
      definitionOfDone: "Publish the old synthetic note",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: true,
      targetAt: futureTarget(72),
      targetTimeZone: "Asia/Singapore",
      timingConstraints: [],
    };
    const createOldUpdate = base + 1;
    await telegram.claimUpdate(createOldUpdate, config.telegramOwnerUserId);
    expect(await conversation.readTurn(createOldUpdate)).toEqual({
      kind: "none",
    });
    const oldCreated = await conversation.applyTurn({
      action: "create_draft",
      audit: audit(
        oldFields,
        "explicit_commitment",
        "new_request",
        "ready",
      ),
      expected: { kind: "none" },
      fields: oldFields,
      phase: "complete",
      processingResult: "conversation",
      updateId: createOldUpdate,
    });
    const oldReference = oldCreated.draftReference!;

    const impliedFields: DecisionContextFields = {
      definitionOfDone: "Finish revamping the synthetic prototype",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: false,
      targetAt: null,
      targetTimeZone: null,
      timingConstraints: [],
    };
    const permissionUpdate = base + 2;
    await telegram.claimUpdate(permissionUpdate, config.telegramOwnerUserId);
    const oldSnapshot = await conversation.readTurn(permissionUpdate);
    expect(oldSnapshot).toMatchObject({
      id: oldReference.id,
      kind: "draft",
      version: oldReference.version,
    });
    if (oldSnapshot.kind !== "draft") {
      throw new Error("expected old focused draft");
    }
    const createPermissionCommand = {
      action: "create_permission" as const,
      audit: audit(
        impliedFields,
        "implied_intention",
        "separate_request",
        "ask_permission",
      ),
      expected: oldSnapshot,
      fields: impliedFields,
      processingResult: "conversation" as const,
      updateId: permissionUpdate,
    };
    await expect(
      conversation.applyTurn(createPermissionCommand),
    ).resolves.toMatchObject({
      completed: true,
      draftCreated: false,
      status: "applied",
    });
    await expect(
      conversation.applyTurn(createPermissionCommand),
    ).resolves.toMatchObject({
      completed: true,
      draftCreated: false,
      status: "applied",
    });

    const [parkedOld] = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_drafts",
      `&id=eq.${oldReference.id}`,
    );
    expect(parkedOld).toMatchObject({
      state: "parked",
      version: oldReference.version,
    });
    const [storedPermission] = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_permission_candidates",
    );
    expect(storedPermission).toMatchObject({
      return_draft_id: oldReference.id,
      return_draft_version: oldReference.version,
      source_update_id: permissionUpdate,
    });

    const acceptUpdate = base + 3;
    await telegram.claimUpdate(acceptUpdate, config.telegramOwnerUserId);
    const permission = await conversation.readTurn(acceptUpdate);
    expect(permission).toMatchObject({
      kind: "permission",
      sourceUpdateId: permissionUpdate,
    });
    if (permission.kind !== "permission") {
      throw new Error("expected correlated permission");
    }
    const acceptCommand = {
      action: "accept_permission",
      audit: audit(
        impliedFields,
        "explicit_commitment",
        "permission_accepted",
        "ask_target",
      ),
      expected: permission,
      processingResult: "conversation" as const,
      updateId: acceptUpdate,
    } as const;
    const accepted = await conversation.applyTurn(acceptCommand);
    expect(accepted).toMatchObject({
      completed: true,
      draftCreated: true,
      status: "applied",
    });
    expect(accepted.draftReference?.id).not.toBe(oldReference.id);
    await expect(conversation.applyTurn(acceptCommand)).resolves.toEqual(
      accepted,
    );
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        "&state=eq.active",
      ),
    ).toEqual([
      expect.objectContaining({
        definition_of_done: impliedFields.definitionOfDone,
        phase: "awaiting_target",
        version: 1,
      }),
    ]);

    await telegram.claimUpdate(base + 4, config.telegramOwnerUserId);
    await conversation.resetUnconfirmed(
      base + 4,
      config.telegramOwnerUserId,
    );

    await telegram.claimUpdate(base + 5, config.telegramOwnerUserId);
    const empty = await conversation.readTurn(base + 5);
    expect(empty).toEqual({ kind: "none" });
    const secondOld = await conversation.applyTurn({
      action: "create_draft",
      audit: audit(
        oldFields,
        "explicit_commitment",
        "new_request",
        "ready",
      ),
      expected: empty,
      fields: oldFields,
      phase: "complete",
      processingResult: "conversation",
      updateId: base + 5,
    });
    const secondOldReference = secondOld.draftReference!;
    await telegram.claimUpdate(base + 6, config.telegramOwnerUserId);
    const secondOldSnapshot = await conversation.readTurn(base + 6);
    if (secondOldSnapshot.kind !== "draft") {
      throw new Error("expected second old draft");
    }
    await conversation.applyTurn({
      ...createPermissionCommand,
      expected: secondOldSnapshot,
      updateId: base + 6,
    });

    await telegram.claimUpdate(base + 7, config.telegramOwnerUserId);
    const declinePermission = await conversation.readTurn(base + 7);
    if (declinePermission.kind !== "permission") {
      throw new Error("expected permission before decline");
    }
    const declineCommand = {
      action: "terminate_permission",
      audit: audit(
        {
          definitionOfDone: null,
          durationMinutes: null,
          offerWorkWindowHelp: false,
          possibleWorkSession: false,
          simpleAction: false,
          targetAt: null,
          targetTimeZone: null,
          timingConstraints: [],
        },
        "ordinary_question",
        "permission_declined",
        "answer",
      ),
      expected: declinePermission,
      processingResult: "conversation" as const,
      updateId: base + 7,
    } as const;
    const declined = await conversation.applyTurn(declineCommand);
    expect(declined).toMatchObject({
      completed: true,
      draftCreated: false,
      draftReference: secondOldReference,
      status: "applied",
    });
    await expect(conversation.applyTurn(declineCommand)).resolves.toEqual(
      declined,
    );
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        `&id=eq.${secondOldReference.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        state: "active",
        version: secondOldReference.version,
      }),
    ]);

    const resetUpdate = base + 8;
    await telegram.claimUpdate(resetUpdate, config.telegramOwnerUserId);
    const resetResult = await conversation.resetUnconfirmed(
      resetUpdate,
      config.telegramOwnerUserId,
    );
    await expect(
      conversation.resetUnconfirmed(
        resetUpdate,
        config.telegramOwnerUserId,
      ),
    ).resolves.toEqual(resetResult);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        "&state=in.(active,parked)",
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_permission_candidates",
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "commitments",
      ),
    ).toHaveLength(confirmedBefore.length);
  });
});
