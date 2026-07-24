import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
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

function singaporeInstant(millis: number): string {
  return `${new Date(millis + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

function nextBoundary(afterMillis: number): number {
  const halfHour = 30 * 60_000;
  return Math.ceil(afterMillis / halfHour) * halfHour;
}

describe("local Supabase versioned work-session draft", () => {
  it("keeps one draft, at most two sanitized options, stale actions inert, and product rows unchanged", async () => {
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
    const suffix = `${Date.now()}${randomInt(1_000_000)}`;
    const updateBase = Number(suffix.slice(-12));
    const now = Date.now();
    const targetAt = singaporeInstant(now + 3 * 24 * 60 * 60_000);
    const fields: DecisionContextFields = {
      definitionOfDone: `Finish bounded draft ${suffix}`,
      durationMinutes: null,
      offerWorkWindowHelp: false,
      possibleWorkSession: true,
      simpleAction: false,
      targetAt,
      targetTimeZone: "Asia/Singapore",
      timingConstraints: [],
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

    const productTables = [
      "commitments",
      "scheduled_messages",
      "commitment_events",
    ];
    const beforeCounts = Object.fromEntries(
      await Promise.all(
        productTables.map(async (table) => [
          table,
          (
            await rows(
              config.supabaseUrl,
              config.supabaseSecretKey,
              table,
            )
          ).length,
        ]),
      ),
    );

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
    expect(created.draftReference).toBeDefined();
    const reference = created.draftReference!;

    await expect(flow.read(reference)).resolves.toMatchObject({
      kind: "current",
      snapshot: {
        id: reference.id,
        options: [],
        stage: "offer_help",
        version: reference.version,
      },
    });

    const duration = await flow.transition({
      chatId: config.telegramOwnerUserId,
      expectedStage: "offer_help",
      nextStage: "awaiting_duration_help",
      reference,
      updateId: updateBase + 1,
    });
    expect(duration.kind).toBe("applied");
    if (duration.kind !== "applied") {
      throw new Error("duration transition did not apply");
    }
    const constraints = await flow.transition({
      chatId: config.telegramOwnerUserId,
      durationMinutes: 60,
      expectedStage: "awaiting_duration_help",
      nextStage: "awaiting_constraints",
      reference: duration.snapshot,
      updateId: updateBase + 2,
    });
    expect(constraints.kind).toBe("applied");
    if (constraints.kind !== "applied") {
      throw new Error("constraint transition did not apply");
    }
    await expect(
      flow.transition({
        chatId: config.telegramOwnerUserId,
        expectedStage: "awaiting_constraints",
        nextStage: "choosing",
        reference: constraints.snapshot,
        timingConstraints: "daily 20:00-08:00",
        updateId: updateBase + 20,
      }),
    ).rejects.toThrow("Work-session draft persistence failed");

    const optionStart = nextBoundary(now + 4 * 60 * 60_000);
    const options = [
      {
        endAt: singaporeInstant(optionStart + 60 * 60_000),
        startAt: singaporeInstant(optionStart),
      },
      {
        endAt: singaporeInstant(optionStart + 3 * 60 * 60_000),
        startAt: singaporeInstant(optionStart + 2 * 60 * 60_000),
      },
    ];
    const choosing = await flow.transition({
      calendarAttemptedAt: new Date(now).toISOString(),
      calendarCheckedAt: new Date(now + 1_000).toISOString(),
      chatId: config.telegramOwnerUserId,
      expectedStage: "awaiting_constraints",
      nextStage: "choosing",
      options,
      reference: constraints.snapshot,
      selectedWindow: null,
      timingConstraints: "daily 08:00-20:00",
      updateId: updateBase + 3,
    });
    expect(choosing.kind).toBe("applied");
    if (choosing.kind !== "applied") {
      throw new Error("option transition did not apply");
    }
    expect(choosing.snapshot.options).toEqual(options);
    expect(JSON.stringify(choosing.snapshot)).not.toMatch(
      /title|attendee|description|event|provider/i,
    );

    const stale = await flow.transition({
      chatId: config.telegramOwnerUserId,
      expectedStage: "awaiting_constraints",
      nextStage: "choosing",
      reference: constraints.snapshot,
      updateId: updateBase + 4,
    });
    expect(stale).toEqual({ kind: "stale" });
    await expect(
      flow.transition({
        chatId: config.telegramOwnerUserId,
        expectedStage: "awaiting_constraints",
        nextStage: "choosing",
        reference: constraints.snapshot,
        updateId: updateBase + 4,
      }),
    ).resolves.toEqual({ kind: "replay" });

    const optionRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "conversation_work_session_options",
      `&draft_id=eq.${reference.id}`,
    );
    expect(optionRows).toHaveLength(2);
    expect(
      optionRows.every((row) =>
        Object.keys(row).every((key) =>
          [
            "created_at",
            "draft_id",
            "draft_version",
            "end_at",
            "ordinal",
            "start_at",
          ].includes(key)
        )
      ),
    ).toBe(true);

    await rpc(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "claim_telegram_update",
      {
        p_owner_chat_id: config.telegramOwnerUserId,
        p_update_id: updateBase + 5,
      },
    );
    const correctedFields: DecisionContextFields = {
      ...fields,
      definitionOfDone: `${fields.definitionOfDone} corrected`,
      durationMinutes: 60,
      timingConstraints: ["daily 08:00-20:00"],
    };
    const corrected = await conversation.applyTurn({
      action: "update_draft",
      audit: {
        ...audit,
        payload: {
          ...correctedFields,
          missingFields: [],
          nextAction: "ready",
          turnRelation: "correction",
        },
      },
      expected: {
        id: choosing.snapshot.id,
        kind: "draft",
        version: choosing.snapshot.version,
      },
      fields: correctedFields,
      phase: "complete",
      processingResult: "conversation",
      updateId: updateBase + 5,
    });
    expect(corrected).toMatchObject({
      completed: true,
      draftCreated: false,
      status: "applied",
    });
    const correctedReference = corrected.draftReference!;
    await expect(flow.read(correctedReference)).resolves.toMatchObject({
      kind: "current",
      snapshot: {
        options: [],
        stage: "offer_help",
      },
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "conversation_work_session_options",
        `&draft_id=eq.${reference.id}`,
      ),
    ).toHaveLength(0);

    await expect(
      flow.transition({
        chatId: config.telegramOwnerUserId + 1,
        expectedStage: "offer_help",
        nextStage: "awaiting_duration_help",
        reference: correctedReference,
        updateId: updateBase + 6,
      }),
    ).rejects.toThrow("Work-session draft persistence failed");

    await expect(
      flow.cancel(
        updateBase + 7,
        config.telegramOwnerUserId,
        correctedReference,
        "offer_help",
      ),
    ).resolves.toMatchObject({ kind: "applied" });
    await expect(flow.read(correctedReference)).resolves.toEqual({
      kind: "expired",
    });

    const afterCounts = Object.fromEntries(
      await Promise.all(
        productTables.map(async (table) => [
          table,
          (
            await rows(
              config.supabaseUrl,
              config.supabaseSecretKey,
              table,
            )
          ).length,
        ]),
      ),
    );
    expect(afterCounts).toEqual(beforeCounts);
  });
});
