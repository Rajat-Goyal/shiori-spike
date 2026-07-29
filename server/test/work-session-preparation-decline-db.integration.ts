import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SupabaseConfirmationRepository } from "../src/confirmation.js";
import { readServerConfig } from "../src/config.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseWorkSessionFlowRepository } from "../src/work-sessions/flow-repository.js";

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

async function rows(
  supabaseUrl: string,
  secretKey: string,
  table: string,
  query: string,
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

function singaporeInstant(millis: number): string {
  return `${new Date(millis + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

describe("local Supabase preparation decline", () => {
  it("atomically turns the offer-help draft into a clean simple action", async () => {
    const config = localConfig();
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const flow = new SupabaseWorkSessionFlowRepository({
      ownerId: config.telegramOwnerUserId,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const confirmation = new SupabaseConfirmationRepository({
      ownerId: config.telegramOwnerUserId,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const suffix = `${Date.now()}${randomInt(1_000_000)}`;
    const updateBase = Number(suffix.slice(-12));
    const targetAt = singaporeInstant(Date.now() + 3 * 24 * 60 * 60_000);
    const fields: DecisionContextFields = {
      definitionOfDone: `Finish without preparation ${suffix}`,
      durationMinutes: 60,
      offerWorkWindowHelp: false,
      possibleWorkSession: true,
      simpleAction: false,
      targetAt,
      targetTimeZone: "Asia/Singapore",
      timingConstraints: ["daily 08:00-20:00"],
    };
    const audit: DecisionAudit = {
      inputClass: "explicit_commitment",
      modelId: "db-test-model",
      payload: {
        ...fields,
        missingFields: [],
        nextAction: "offer_work_window",
        turnRelation: "new_request",
      },
      promptVersion: "db-test-prompt-v1",
    };

    await rpc(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "claim_telegram_update",
      {
        p_owner_chat_id: config.telegramOwnerUserId,
        p_update_id: updateBase,
      },
    );
    const created = await conversation.applyTurn({
      action: "create_draft",
      audit,
      expected: { kind: "none" },
      fields,
      phase: "complete",
      processingResult: "conversation",
      updateId: updateBase,
    });
    expect(created).toMatchObject({
      completed: true,
      draftCreated: true,
      status: "applied",
    });
    const reference = created.draftReference;
    expect(reference).toBeDefined();
    if (!reference) {
      throw new Error("work-session draft was not created");
    }

    const decisionsBefore = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "model_decisions",
      `&draft_id=eq.${reference.id}`,
    );
    expect(decisionsBefore).toHaveLength(1);

    await expect(
      flow.declinePreparation(
        updateBase + 1,
        config.telegramOwnerUserId,
        { ...reference, version: reference.version + 1 },
      ),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      flow.declinePreparation(
        updateBase + 1,
        config.telegramOwnerUserId,
        reference,
      ),
    ).resolves.toEqual({ kind: "replay" });

    const applied = await flow.declinePreparation(
      updateBase + 2,
      config.telegramOwnerUserId,
      reference,
    );
    expect(applied).toEqual({
      draft: {
        definitionOfDone: fields.definitionOfDone,
        id: reference.id,
        targetAt,
        version: reference.version + 1,
      },
      kind: "applied",
    });
    await expect(
      flow.declinePreparation(
        updateBase + 2,
        config.telegramOwnerUserId,
        reference,
      ),
    ).resolves.toEqual({ kind: "replay" });

    const draftRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_drafts",
      `&id=eq.${reference.id}`,
    );
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]).toMatchObject({
      calendar_attempted_at: null,
      calendar_checked_at: null,
      conflict_consent: false,
      duration_minutes: null,
      final_calendar_observation: null,
      last_update_id: updateBase + 2,
      last_work_session_transition_id: null,
      offer_work_window_help: false,
      possible_work_session: false,
      selected_end_at: null,
      selected_start_at: null,
      simple_action: true,
      state: "active",
      timing_constraints: [],
      version: reference.version + 1,
      work_session_stage: null,
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_work_session_options",
        `&draft_id=eq.${reference.id}`,
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "model_decisions",
        `&draft_id=eq.${reference.id}`,
      ),
    ).toEqual(decisionsBefore);
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "telegram_updates",
        `&update_id=eq.${updateBase + 2}`,
      ),
    ).toEqual([
      expect.objectContaining({
        processing_result: "work_session_draft_resolved",
        processing_status: "processed",
        resolved_action_key:
          `w:${reference.id}:${reference.version}:no_preparation`,
      }),
    ]);

    await expect(
      flow.read({
        id: reference.id,
        version: reference.version + 1,
      }),
    ).resolves.toEqual({ kind: "missing" });
    await expect(
      confirmation.resolve({
        action: "cancel",
        chatId: config.telegramOwnerUserId,
        draftId: reference.id,
        updateId: updateBase + 3,
        version: reference.version + 1,
      }),
    ).resolves.toMatchObject({ completed: true, kind: "cancelled" });
  });
});
