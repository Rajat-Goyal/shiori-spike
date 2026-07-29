import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { SupabaseConfirmationRepository } from "../src/confirmation.js";
import {
  type ConversationDraftResolution,
  type DecisionAudit,
  type ExpectedConversationFocus,
  SupabaseConversationRepository,
} from "../src/conversation/repository.js";
import type { DecisionContextFields } from "../src/decision/schema.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";

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
      `draft resolution is restricted to local Supabase on port ${expectedPort}`,
    );
  }
  return config;
}

function futureSingaporeTarget(days: number): string {
  const singapore = new Date(
    Date.now() +
      days * 24 * 60 * 60 * 1_000 +
      8 * 60 * 60 * 1_000,
  );
  return `${singapore.toISOString().slice(0, 19)}+08:00`;
}

function fields(
  definitionOfDone: string,
  days: number,
): DecisionContextFields {
  return {
    definitionOfDone,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: false,
    simpleAction: true,
    targetAt: futureSingaporeTarget(days),
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
}

function audit(candidate: DecisionContextFields): DecisionAudit {
  return {
    inputClass: "explicit_commitment",
    modelId: "gpt-test-model",
    payload: {
      ...candidate,
      missingFields: [],
      nextAction: "ready",
      turnRelation: "new_request",
    },
    promptVersion: "shiori-test-v1",
  };
}

function exact(result: ConversationDraftResolution): string {
  expect(result.kind).toBe("exact");
  if (result.kind !== "exact") {
    throw new Error("Expected one exact draft resolution");
  }
  expect(result.authority).toEqual({
    expectedVersion: result.draft.version,
    id: result.draft.id,
    kind: "draft",
  });
  return result.draft.id;
}

describe("local Supabase natural draft resolution", () => {
  it("ranks meaningful overlap and excludes unavailable drafts", async () => {
    const config = localConfig();
    const conversation = new SupabaseConversationRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const telegram = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const confirmation = new SupabaseConfirmationRepository({
      ownerId: config.telegramOwnerUserId,
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const marker = `resolver${randomInt(100_000, 999_999)}`;
    const terminalMarker = `terminal${randomInt(100_000, 999_999)}`;
    const baseUpdateId = 9_850_000_000 + randomInt(100_000_000);
    const definitions = [
      `Submit ${marker} quarterly finance report`,
      `Publish ${marker} launch report`,
      `Archive ${terminalMarker} unavailable dossier`,
    ] as const;
    let expectedFocus: ExpectedConversationFocus = { kind: "none" };
    const references: Array<{ id: string; version: number }> = [];

    const existing = await conversation.listDrafts({ limit: 20 });
    const existingFocus = existing.drafts.find((draft) => draft.focused);
    if (existingFocus) {
      expectedFocus = {
        id: existingFocus.id,
        kind: "draft",
        version: existingFocus.version,
      };
    }

    for (const [index, definition] of definitions.entries()) {
      const updateId = baseUpdateId + index;
      await expect(
        telegram.claimUpdate(updateId, config.telegramOwnerUserId),
      ).resolves.toBe(true);
      const candidate = fields(definition, index + 3);
      const result = await conversation.createFocusedDraft({
        audit: audit(candidate),
        expectedFocus,
        fields: candidate,
        phase: "complete",
        processingResult: "conversation",
        updateId,
      });
      expect(result).toMatchObject({
        completed: true,
        draftCreated: true,
        status: "applied",
      });
      expect(result.draftReference).toBeDefined();
      const reference = result.draftReference!;
      references.push(reference);
      expectedFocus = {
        id: reference.id,
        kind: "draft",
        version: reference.version,
      };
    }

    await expect(
      confirmation.resolve({
        action: "cancel",
        chatId: config.telegramOwnerUserId,
        draftId: references[2].id,
        updateId: baseUpdateId + 3,
        version: references[2].version,
      }),
    ).resolves.toMatchObject({
      completed: true,
      kind: "cancelled",
    });

    expect(
      exact(
        await conversation.resolveDraftReference(
          `Please move the ${marker} finance report to Friday`,
        ),
      ),
    ).toBe(references[0].id);
    expect(
      exact(await conversation.resolveDraftReference("The finance one")),
    ).toBe(references[0].id);

    const generic = await conversation.resolveDraftReference(
      `${marker} report`,
    );
    expect(generic.kind).toBe("ambiguous");
    if (generic.kind !== "ambiguous") {
      throw new Error("Expected tied report drafts");
    }
    expect(generic.candidates.map(({ authority }) => authority.id).sort())
      .toEqual([references[0].id, references[1].id].sort());

    await expect(
      conversation.resolveDraftReference("Where is the airport shuttle"),
    ).resolves.toEqual({ kind: "none" });
    await expect(
      conversation.resolveDraftReference(
        `${terminalMarker} unavailable dossier`,
      ),
    ).resolves.toEqual({ kind: "none" });
    await expect(
      conversation.resolveDraftReference(randomUUID()),
    ).resolves.toEqual({ kind: "none" });
  });
});
