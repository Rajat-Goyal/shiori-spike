import assert from "node:assert/strict";
import type { ServerConfig } from "../../src/config.js";
import { SupabaseSimpleCommitmentActionRepository } from "../../src/commitments/simple-action.js";
import { SupabaseConfirmationRepository } from "../../src/confirmation.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "../../src/conversation/repository.js";
import type { DecisionContextFields } from "../../src/decision/schema.js";
import {
  type DashboardSummary,
  SupabaseDashboardRepository,
} from "../../src/dashboard.js";
import { supabaseHeaders } from "../../src/supabase.js";
import { SupabaseTelegramRepository } from "../../src/telegram/repository.js";
import { SupabaseWorkSessionCommitter } from "../../src/work-sessions/confirm.js";
import { SupabaseWorkSessionFlowRepository } from "../../src/work-sessions/flow-repository.js";
import { SupabaseWorkSessionOutcomeRepository } from "../../src/work-sessions/outcomes.js";

export const dashboardFixtureDefinitions = {
  done: "Archive the synthetic release note",
  simple: "Submit the synthetic QA summary",
  work: "Review the synthetic implementation brief",
} as const;

type SeedDashboardFixtureOptions = Readonly<{
  baseUpdateId?: number;
  now?: number;
}>;

type SeedDashboardFixtureResult = Readonly<{
  summary: DashboardSummary;
  workSessionId: string;
}>;

function assertDisposableLocal(config: ServerConfig): void {
  const url = new URL(config.supabaseUrl);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === "54321",
    "dashboard QA fixture is restricted to disposable local Supabase on port 54321",
  );
}

function singaporeInstant(millis: number): string {
  return `${new Date(millis + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 19)}+08:00`;
}

export function nextSingaporeHalfHour(millis: number): string {
  const halfHour = 30 * 60_000;
  return singaporeInstant(Math.ceil(millis / halfHour) * halfHour);
}

function audit(fields: DecisionContextFields): DecisionAudit {
  return {
    inputClass: "explicit_commitment",
    modelId: "s01-11-qa-fixture",
    payload: {
      ...fields,
      missingFields: [],
      nextAction: "ready",
      turnRelation: "new_request",
    },
    promptVersion: "s01-11-qa-fixture-v1",
  };
}

async function rows(
  config: ServerConfig,
  table: string,
  query: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `${config.supabaseUrl}/rest/v1/${table}?select=*${query}`,
    { headers: supabaseHeaders(config.supabaseSecretKey) },
  );
  assert.equal(response.ok, true, `failed to read ${table}`);
  const value: unknown = await response.json();
  assert.ok(Array.isArray(value), `${table} did not return rows`);
  return value as Array<Record<string, unknown>>;
}

function dashboardRepository(config: ServerConfig) {
  return new SupabaseDashboardRepository({
    ownerId: config.telegramOwnerUserId,
    ownerTimeZone: config.ownerTimeZone,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
}

async function createDraft(
  config: ServerConfig,
  updateId: number,
  fields: DecisionContextFields,
) {
  const telegram = new SupabaseTelegramRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  assert.equal(
    await telegram.claimUpdate(updateId, config.telegramOwnerUserId),
    true,
  );
  const conversation = new SupabaseConversationRepository({
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const result = await conversation.applyTurn({
    action: "create_draft",
    audit: audit(fields),
    expected: { kind: "none" },
    fields,
    phase: "complete",
    processingResult: "conversation",
    updateId,
  });
  assert.ok(result.draftReference, "conversation draft was not created");
  return result.draftReference;
}

async function commitmentForDraft(
  config: ServerConfig,
  draftId: string,
): Promise<string> {
  const commitments = await rows(
    config,
    "commitments",
    `&source_draft_id=eq.${draftId}`,
  );
  assert.equal(commitments.length, 1);
  return String(commitments[0].id);
}

async function createSimpleCommitment(
  config: ServerConfig,
  updateId: number,
  definitionOfDone: string,
  targetAt: string,
): Promise<string> {
  const fields: DecisionContextFields = {
    definitionOfDone,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: false,
    simpleAction: true,
    targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
  const draft = await createDraft(config, updateId, fields);
  const confirmation = new SupabaseConfirmationRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const result = await confirmation.resolve({
    action: "confirm",
    chatId: config.telegramOwnerUserId,
    draftId: draft.id,
    updateId: updateId + 1,
    version: draft.version,
  });
  assert.equal(result.kind, "confirmed");
  return commitmentForDraft(config, draft.id);
}

async function createWorkCommitment(
  config: ServerConfig,
  updateId: number,
  targetAt: string,
  startAt: string,
  attemptedAt: string,
): Promise<{ commitmentId: string; sessionId: string }> {
  const fields: DecisionContextFields = {
    definitionOfDone: dashboardFixtureDefinitions.work,
    durationMinutes: null,
    offerWorkWindowHelp: false,
    possibleWorkSession: true,
    simpleAction: false,
    targetAt,
    targetTimeZone: "Asia/Singapore",
    timingConstraints: [],
  };
  const draft = await createDraft(config, updateId, fields);
  const startMillis = Date.parse(startAt);
  const selectedWindow = {
    endAt: singaporeInstant(startMillis + 60 * 60_000),
    startAt,
  };
  const flow = new SupabaseWorkSessionFlowRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const transition = await flow.transition({
    calendarAttemptedAt: attemptedAt,
    calendarCheckedAt: null,
    chatId: config.telegramOwnerUserId,
    conflictConsent: false,
    durationMinutes: 60,
    expectedStage: "offer_help",
    finalObservation: "unavailable",
    nextStage: "unverified_confirming",
    options: [],
    reference: draft,
    selectedWindow,
    timingConstraints: "default",
    updateId: updateId + 1,
  });
  assert.equal(transition.kind, "applied");
  if (transition.kind !== "applied") {
    throw new Error("work-session draft did not transition");
  }
  const committer = new SupabaseWorkSessionCommitter({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  assert.deepEqual(
    await committer.commit({
      action: "save_unverified",
      calendar: {
        attemptedAt,
        checkedAt: null,
        conflictConsent: false,
        finalObservation: "unavailable",
        status: "unverified",
      },
      chatId: config.telegramOwnerUserId,
      definitionOfDone: dashboardFixtureDefinitions.work,
      draft: {
        id: transition.snapshot.id,
        version: transition.snapshot.version,
      },
      durationMinutes: 60,
      expectedStage: "unverified_confirming",
      selectedWindow,
      targetAt,
      timingConstraints: "default",
      updateId: updateId + 2,
    }),
    { kind: "applied" },
  );
  const commitmentId = await commitmentForDraft(config, draft.id);
  const sessions = await rows(
    config,
    "work_sessions",
    `&commitment_id=eq.${commitmentId}`,
  );
  assert.equal(sessions.length, 1);
  return {
    commitmentId,
    sessionId: String(sessions[0].id),
  };
}

export async function seedDashboardQaFixture(
  config: ServerConfig,
  options: SeedDashboardFixtureOptions = {},
): Promise<SeedDashboardFixtureResult> {
  assertDisposableLocal(config);
  const existing = await dashboardRepository(config).readSummary();
  assert.deepEqual(
    {
      active: existing.commitments.length,
      events: existing.events.length,
      sessions: existing.sessionHistory.length,
      terminal: existing.terminalCommitments.length,
    },
    { active: 0, events: 0, sessions: 0, terminal: 0 },
    "dashboard QA fixture requires a clean synthetic owner",
  );

  const baseUpdateId = options.baseUpdateId ?? 1_911_000_000;
  const now = options.now ?? Date.now();
  const simpleId = await createSimpleCommitment(
    config,
    baseUpdateId,
    dashboardFixtureDefinitions.simple,
    singaporeInstant(now + 24 * 60 * 60_000),
  );
  const doneId = await createSimpleCommitment(
    config,
    baseUpdateId + 10,
    dashboardFixtureDefinitions.done,
    singaporeInstant(now + 48 * 60 * 60_000),
  );
  const done = new SupabaseSimpleCommitmentActionRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const doneResult = await done.resolve({
    action: "done",
    chatId: config.telegramOwnerUserId,
    commitmentId: doneId,
    updateId: baseUpdateId + 12,
    version: 1,
  });
  assert.equal(doneResult.kind, "done");

  const work = await createWorkCommitment(
    config,
    baseUpdateId + 20,
    singaporeInstant(now + 72 * 60 * 60_000),
    nextSingaporeHalfHour(now + 6 * 60 * 60_000),
    new Date(now).toISOString(),
  );
  const sessions = await rows(
    config,
    "work_sessions",
    `&id=eq.${work.sessionId}`,
  );
  assert.equal(sessions.length, 1);
  const outcome = new SupabaseWorkSessionOutcomeRepository({
    ownerId: config.telegramOwnerUserId,
    supabaseSecretKey: config.supabaseSecretKey,
    supabaseUrl: config.supabaseUrl,
  });
  const outcomeResult = await outcome.resolve({
    action: "more",
    chatId: config.telegramOwnerUserId,
    sessionId: work.sessionId,
    updateId: baseUpdateId + 23,
    version: Number(sessions[0].action_version),
  });
  assert.equal(outcomeResult.kind, "more");

  const summary = await dashboardRepository(config).readSummary();
  assert.equal(summary.counts.active, 2);
  assert.deepEqual(
    summary.commitments.map(({ id }) => id),
    [simpleId, work.commitmentId],
  );
  assert.equal(summary.sessionHistory.length, 1);
  assert.equal(
    summary.sessionHistory[0].sessions[0].status,
    "more_work_needed",
  );
  assert.ok(
    summary.terminalCommitments.some(({ id }) => id === doneId),
  );
  assert.ok(
    summary.events.some(
      ({ eventType }) => eventType === "work_session.more_work_needed",
    ),
  );
  return { summary, workSessionId: work.sessionId };
}
