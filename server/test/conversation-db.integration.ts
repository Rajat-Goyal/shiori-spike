import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import {
  type ActiveDraft,
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
    url.port !== "54321"
  ) {
    throw new Error(
      "test:db is restricted to the Docker-generated local Supabase API on port 54321",
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
  const body: unknown = await response.json();
  expect(Array.isArray(body)).toBe(true);
  return body as Array<Record<string, unknown>>;
}

function futureSingaporeTarget(): string {
  const singapore = new Date(
    Date.now() + 48 * 60 * 60 * 1_000 + 8 * 60 * 60 * 1_000,
  );
  return `${singapore.toISOString().slice(0, 19)}+08:00`;
}

function audit(
  fields: DecisionContextFields,
  options: {
    inputClass: DecisionAudit["inputClass"];
    nextAction: DecisionAudit["payload"]["nextAction"];
    turnRelation: DecisionAudit["payload"]["turnRelation"];
  },
): DecisionAudit {
  return {
    inputClass: options.inputClass,
    modelId: "gpt-test-model",
    payload: {
      ...fields,
      missingFields: [],
      nextAction: options.nextAction,
      turnRelation: options.turnRelation,
    },
    promptVersion: "shiori-test-v1",
  };
}

describe("local Supabase conversation state", () => {
  it("serializes initial creation, creates one draft, and CAS-updates once", async () => {
    const config = localConfig();
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const baseUpdateId = 9_000_000_000 + randomInt(100_000_000);
    const fields: DecisionContextFields = {
      definitionOfDone: "Submit the synthetic database note",
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: false,
      simpleAction: true,
      targetAt: futureSingaporeTarget(),
      targetTimeZone: "Asia/Singapore",
      timingConstraints: ["Before lunch"],
    };

    const initialIds = [baseUpdateId, baseUpdateId + 1];
    await Promise.all(
      initialIds.map((updateId) =>
        telegram.claimUpdate(updateId, config.telegramOwnerUserId),
      ),
    );
    const initialSnapshots = await Promise.all(
      initialIds.map((updateId) => conversation.readTurn(updateId)),
    );
    expect(
      initialSnapshots.every((snapshot) => snapshot.kind === "none"),
    ).toBe(true);

    const initialOutcomes = await Promise.all([
      conversation.applyTurn({
        action: "create_draft",
        audit: audit(fields, {
          inputClass: "explicit_commitment",
          nextAction: "ready",
          turnRelation: "new_request",
        }),
        expected: { kind: "none" },
        fields,
        phase: "complete",
        processingResult: "conversation",
        updateId: initialIds[0],
      }),
      conversation.applyTurn({
        action: "create_permission",
        audit: audit(fields, {
          inputClass: "implied_intention",
          nextAction: "ask_permission",
          turnRelation: "new_request",
        }),
        expected: { kind: "none" },
        fields,
        processingResult: "conversation",
        updateId: initialIds[1],
      }),
    ]);
    expect(
      initialOutcomes.map((outcome) => outcome.status).sort(),
    ).toEqual(["applied", "stale"]);

    let permissionRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_permission_candidates",
    );
    let activeRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_drafts",
      "&state=eq.active",
    );
    expect(permissionRows.length + activeRows.length).toBe(1);
    expect(
      permissionRows.length === 0 || activeRows.length === 0,
    ).toBe(true);

    const permissionAcceptanceIds: number[] = [];
    if (permissionRows.length === 1) {
      const permissionUpdateId = baseUpdateId + 2;
      permissionAcceptanceIds.push(permissionUpdateId);
      await expect(
        telegram.claimUpdate(
          permissionUpdateId,
          config.telegramOwnerUserId,
        ),
      ).resolves.toBe(true);
      const permission = await conversation.readTurn(permissionUpdateId);
      expect(permission).toMatchObject({
        correlatedUpdateId: permissionUpdateId,
        fields,
        kind: "permission",
        sourceUpdateId: initialIds[1],
      });
      if (permission.kind !== "permission") {
        throw new Error("Expected correlated permission candidate");
      }
      await expect(
        conversation.applyTurn({
          action: "accept_permission",
          audit: audit(fields, {
            inputClass: "explicit_commitment",
            nextAction: "ready",
            turnRelation: "permission_accepted",
          }),
          expected: permission,
          processingResult: "conversation",
          updateId: permissionUpdateId,
        }),
      ).resolves.toEqual({
        completed: true,
        draftCreated: true,
        status: "applied",
      });
      permissionRows = await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_permission_candidates",
      );
      activeRows = await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_drafts",
        "&state=eq.active",
      );
    }

    expect(permissionRows).toHaveLength(0);
    const createdRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_drafts",
      "&state=eq.active",
    );
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({
      definition_of_done: fields.definitionOfDone,
      duration_minutes: null,
      offer_work_window_help: false,
      phase: "complete",
      possible_work_session: false,
      simple_action: true,
      target_at: fields.targetAt,
      target_time_zone: "Asia/Singapore",
      timing_constraints: fields.timingConstraints,
      version: 1,
    });

    const correctionIds = [baseUpdateId + 3, baseUpdateId + 4];
    await Promise.all(
      correctionIds.map((updateId) =>
        telegram.claimUpdate(updateId, config.telegramOwnerUserId),
      ),
    );
    const snapshots = await Promise.all(
      correctionIds.map((updateId) => conversation.readTurn(updateId)),
    );
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.kind === "draft" && snapshot.version === 1,
      ),
    ).toBe(true);

    const outcomes = await Promise.all(
      snapshots.map((snapshot, index) => {
        if (snapshot.kind !== "draft") {
          throw new Error("Expected active draft");
        }
        return conversation.applyTurn({
          action: "update_draft",
          audit: audit(
            {
              ...snapshot.fields,
              definitionOfDone: `Accepted correction ${index + 1}`,
            },
            {
              inputClass: "explicit_commitment",
              nextAction: "ready",
              turnRelation: "correction",
            },
          ),
          expected: snapshot,
          fields: {
            ...snapshot.fields,
            definitionOfDone: `Accepted correction ${index + 1}`,
          },
          phase: "complete",
          processingResult: "conversation",
          updateId: correctionIds[index],
        });
      }),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "applied",
      "stale",
    ]);

    const finalRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_drafts",
      "&state=eq.active",
    );
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0].version).toBe(2);
    expect(["Accepted correction 1", "Accepted correction 2"]).toContain(
      finalRows[0].definition_of_done,
    );

    const auditedUpdateIds = [
      ...initialIds,
      ...permissionAcceptanceIds,
      ...correctionIds,
    ];
    const decisionRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "model_decisions",
      `&update_id=in.(${auditedUpdateIds.join(",")})`,
    );
    expect(decisionRows).toHaveLength(auditedUpdateIds.length);
    expect(Object.keys(decisionRows[0]).sort()).toEqual([
      "created_at",
      "decision_payload",
      "draft_id",
      "id",
      "input_class",
      "model_id",
      "prompt_version",
      "update_id",
    ]);
    expect(
      decisionRows.filter((row) => row.draft_id === null),
    ).toHaveLength(auditedUpdateIds.length - 3);
    expect(
      decisionRows.filter((row) => row.draft_id !== null),
    ).toHaveLength(3);
    for (const row of decisionRows) {
      expect(row).toMatchObject({
        model_id: "gpt-test-model",
        prompt_version: "shiori-test-v1",
      });
      expect(Object.keys(row.decision_payload as object).sort()).toEqual([
        "definitionOfDone",
        "durationMinutes",
        "missingFields",
        "nextAction",
        "offerWorkWindowHelp",
        "possibleWorkSession",
        "simpleAction",
        "targetAt",
        "targetTimeZone",
        "timingConstraints",
        "turnRelation",
      ]);
      expect(JSON.stringify(row)).not.toMatch(
        /response|ownerText|transcript|providerPayload|providerTrace/,
      );
    }

    const updateRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "telegram_updates",
      `&update_id=in.(${auditedUpdateIds.join(",")})`,
    );
    expect(updateRows).toHaveLength(auditedUpdateIds.length);
    expect(
      updateRows.every(
        (row) =>
          row.processing_status === "processed" &&
          row.processed_at !== null,
      ),
    ).toBe(true);
    expect(
      updateRows.filter(
        (row) => row.processing_result === "conversation_stale",
      ),
    ).toHaveLength(2);
    expect(
      updateRows.filter(
        (row) => row.processing_result === "conversation",
      ),
    ).toHaveLength(auditedUpdateIds.length - 2);

    const invalidArrayUpdateId = baseUpdateId + 5;
    await telegram.claimUpdate(
      invalidArrayUpdateId,
      config.telegramOwnerUserId,
    );
    const beforeInvalid = await conversation.readTurn(invalidArrayUpdateId);
    if (beforeInvalid.kind !== "draft") {
      throw new Error("Expected draft before invalid array check");
    }
    await expect(
      conversation.applyTurn({
        action: "update_draft",
        audit: audit(beforeInvalid.fields, {
          inputClass: "explicit_commitment",
          nextAction: "ready",
          turnRelation: "correction",
        }),
        expected: beforeInvalid,
        fields: {
          ...beforeInvalid.fields,
          timingConstraints: [null] as unknown as string[],
        },
        phase: "complete",
        processingResult: "conversation",
        updateId: invalidArrayUpdateId,
      }),
    ).rejects.toThrow("Conversation apply failed");
    await expect(
      conversation.applyTurn({
        action: "preserve",
        expected: beforeInvalid,
        processingResult: "conversation_failed",
        updateId: invalidArrayUpdateId,
      }),
    ).resolves.toMatchObject({
      completed: true,
      status: "applied",
    });

    const restoredUpdateId = baseUpdateId + 6;
    await telegram.claimUpdate(
      restoredUpdateId,
      config.telegramOwnerUserId,
    );
    const restored = await new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    }).readTurn(restoredUpdateId);
    expect(restored).toMatchObject({
      kind: "draft",
      version: 2,
    });
    expect(
      Object.keys((restored as ActiveDraft).fields).sort(),
    ).toEqual([
      "definitionOfDone",
      "durationMinutes",
      "offerWorkWindowHelp",
      "possibleWorkSession",
      "simpleAction",
      "targetAt",
      "targetTimeZone",
      "timingConstraints",
    ]);
    if (restored.kind !== "draft") {
      throw new Error("Expected restored active draft");
    }
    await expect(
      conversation.applyTurn({
        action: "preserve",
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
          {
            inputClass: "ordinary_question",
            nextAction: "answer",
            turnRelation: "none",
          },
        ),
        expected: restored,
        processingResult: "conversation",
        updateId: restoredUpdateId,
      }),
    ).resolves.toMatchObject({
      completed: true,
      status: "applied",
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "commitments",
      ),
    ).toHaveLength(0);
  });
});
