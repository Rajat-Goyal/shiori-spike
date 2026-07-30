import { execFileSync } from "node:child_process";
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

function localSql(statement: string): void {
  execFileSync(
    "docker",
    [
      "exec",
      process.env.SHIORI_TEST_SUPABASE_DB_CONTAINER ??
        "supabase_db_shiori-spike",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-c",
      statement,
    ],
    { stdio: "pipe" },
  );
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

  it("restores linked focus when permission expires during read or resolution", async () => {
    const config = localConfig();
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    let updateId = 9_800_000_000 + randomInt(100_000_000);
    const oldFields: DecisionContextFields = {
      definitionOfDone: "Preserve the prior expiry-race draft",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: true,
      targetAt: futureTarget(72),
      targetTimeZone: "Asia/Singapore",
      timingConstraints: [],
    };
    const impliedFields: DecisionContextFields = {
      definitionOfDone: "Start the separate expiry-race request",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: false,
      targetAt: null,
      targetTimeZone: null,
      timingConstraints: [],
    };

    const reset = async () => {
      updateId += 1;
      await telegram.claimUpdate(updateId, config.telegramOwnerUserId);
      await conversation.resetUnconfirmed(
        updateId,
        config.telegramOwnerUserId,
      );
    };
    const createLinkedPermission = async () => {
      updateId += 1;
      await telegram.claimUpdate(updateId, config.telegramOwnerUserId);
      const empty = await conversation.readTurn(updateId);
      expect(empty).toEqual({ kind: "none" });
      const oldCreated = await conversation.applyTurn({
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
        updateId,
      });

      updateId += 1;
      await telegram.claimUpdate(updateId, config.telegramOwnerUserId);
      const oldSnapshot = await conversation.readTurn(updateId);
      if (oldSnapshot.kind !== "draft") {
        throw new Error("expected focused prior draft");
      }
      await conversation.applyTurn({
        action: "create_permission",
        audit: audit(
          impliedFields,
          "implied_intention",
          "separate_request",
          "ask_permission",
        ),
        expected: oldSnapshot,
        fields: impliedFields,
        processingResult: "conversation",
        updateId,
      });
      return oldCreated.draftReference!;
    };

    await reset();
    const resolutionPrior = await createLinkedPermission();
    updateId += 1;
    await telegram.claimUpdate(updateId, config.telegramOwnerUserId);
    const permission = await conversation.readTurn(updateId);
    if (permission.kind !== "permission") {
      throw new Error("expected permission before expiry race");
    }

    const invalidAuthority = await fetch(
      `${config.supabaseUrl}/rest/v1/rpc/resolve_separate_conversation_permission`,
      {
        body: JSON.stringify({
          p_action: "accept_permission",
          p_audit_input_class: "explicit_commitment",
          p_audit_payload: audit(
            impliedFields,
            "explicit_commitment",
            "permission_accepted",
            "ask_target",
          ).payload,
          p_expected_correlated_update_id:
            permission.correlatedUpdateId,
          p_expected_id: null,
          p_expected_source_update_id: permission.sourceUpdateId,
          p_model_id: "gpt-test-model",
          p_processing_result: "conversation",
          p_prompt_version: "shiori-test-v1",
          p_update_id: updateId,
        }),
        headers: supabaseHeaders(
          config.supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
      },
    );
    expect(invalidAuthority.ok).toBe(false);

    localSql(
      "update public.conversation_permission_candidates set expires_at = now() - interval '1 second' where singleton",
    );
    const acceptCommand = {
      action: "accept_permission" as const,
      audit: audit(
        impliedFields,
        "explicit_commitment",
        "permission_accepted",
        "ask_target",
      ),
      expected: permission,
      processingResult: "conversation" as const,
      updateId,
    };
    const interrupted = await conversation.applyTurn(acceptCommand);
    expect(interrupted).toMatchObject({
      completed: true,
      draftCreated: false,
      draftReference: resolutionPrior,
      status: "interrupted",
    });
    await expect(conversation.applyTurn(acceptCommand)).resolves.toEqual(
      interrupted,
    );
    await expect(
      conversation.applyTurn({
        ...acceptCommand,
        audit: audit(
          impliedFields,
          "implied_intention",
          "permission_accepted",
          "ask_target",
        ),
      }),
    ).rejects.toThrow();
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        `&id=eq.${resolutionPrior.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        state: "active",
        version: resolutionPrior.version,
      }),
    ]);

    await reset();
    const readPrior = await createLinkedPermission();
    localSql(
      "update public.conversation_permission_candidates set expires_at = now() - interval '1 second' where singleton",
    );
    updateId += 1;
    await telegram.claimUpdate(updateId, config.telegramOwnerUserId);
    await expect(conversation.readTurn(updateId)).resolves.toEqual({
      completed: true,
      kind: "interrupted",
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        `&id=eq.${readPrior.id}`,
      ),
    ).toEqual([
      expect.objectContaining({
        state: "active",
        version: readPrior.version,
      }),
    ]);

    await reset();
    const expiredPrior = await createLinkedPermission();
    localSql(
      `update public.conversation_drafts set expires_at = now() - interval '1 second' where id = '${expiredPrior.id}'; update public.conversation_permission_candidates set expires_at = now() - interval '1 second' where singleton`,
    );
    updateId += 1;
    await telegram.claimUpdate(updateId, config.telegramOwnerUserId);
    await expect(conversation.readTurn(updateId)).resolves.toEqual({
      completed: true,
      kind: "interrupted",
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        `&id=eq.${expiredPrior.id}`,
      ),
    ).toEqual([expect.objectContaining({ state: "expired" })]);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        "&state=in.(active,parked)",
      ),
    ).toHaveLength(0);
  });

  it("fences an older claimed model turn after owner reset", async () => {
    const config = localConfig();
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const base = 9_900_000_000 + randomInt(90_000_000);

    await telegram.claimUpdate(base, config.telegramOwnerUserId);
    await conversation.resetUnconfirmed(
      base,
      config.telegramOwnerUserId,
    );

    const slowUpdate = base + 1;
    await telegram.claimUpdate(slowUpdate, config.telegramOwnerUserId);
    const preResetSnapshot = await conversation.readTurn(slowUpdate);
    expect(preResetSnapshot).toEqual({ kind: "none" });

    const resetUpdate = base + 2;
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

    const proposedFields: DecisionContextFields = {
      definitionOfDone: "This slow pre-reset result must not be saved",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: true,
      targetAt: futureTarget(48),
      targetTimeZone: "Asia/Singapore",
      timingConstraints: [],
    };
    const staleCommand = {
      action: "create_draft" as const,
      audit: audit(
        proposedFields,
        "explicit_commitment",
        "new_request",
        "ready",
      ),
      expected: preResetSnapshot,
      fields: proposedFields,
      phase: "complete" as const,
      processingResult: "conversation" as const,
      updateId: slowUpdate,
    };
    const stale = await conversation.applyTurn(staleCommand);
    expect(stale).toEqual({
      completed: true,
      draftCreated: false,
      status: "stale",
    });
    await expect(conversation.applyTurn(staleCommand)).resolves.toEqual(
      stale,
    );
    await expect(
      conversation.applyTurn({
        ...staleCommand,
        fields: {
          ...proposedFields,
          definitionOfDone: "A changed stale replay also cannot save",
        },
      }),
    ).resolves.toEqual(stale);
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
        "telegram_updates",
        `&update_id=eq.${slowUpdate}`,
      ),
    ).toEqual([
      expect.objectContaining({
        processing_result: "conversation_interrupted",
        processing_status: "processed",
      }),
    ]);
  });
});
