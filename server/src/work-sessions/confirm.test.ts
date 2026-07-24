import { describe, expect, it, vi } from "vitest";
import type { WorkSessionCommitRequest } from "./flow.js";
import { SupabaseWorkSessionCommitter } from "./confirm.js";

const request: WorkSessionCommitRequest = {
  action: "confirm",
  calendar: {
    attemptedAt: "2026-07-27T00:03:00.000Z",
    checkedAt: "2026-07-27T00:03:01.000Z",
    conflictConsent: true,
    finalObservation: "free",
    status: "conflict_kept",
  },
  chatId: 123456789,
  definitionOfDone: "Submit the synthetic note",
  draft: {
    id: "11111111-1111-4111-8111-111111111111",
    version: 7,
  },
  durationMinutes: 60,
  expectedStage: "conflict_confirming",
  selectedWindow: {
    endAt: "2026-07-27T11:00:00+08:00",
    startAt: "2026-07-27T10:00:00+08:00",
  },
  targetAt: "2026-07-27T18:00:00+08:00",
  timingConstraints: "default",
  updateId: 8001,
};

describe("SupabaseWorkSessionCommitter", () => {
  it("sends only the authorized action and bounded Calendar audit", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ kind: "applied" }),
    );
    const committer = new SupabaseWorkSessionCommitter({
      fetch: fetchFromSupabase as typeof fetch,
      ownerId: request.chatId,
      supabaseSecretKey: "test-secret",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(committer.commit(request)).resolves.toEqual({
      kind: "applied",
    });

    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/confirm_work_session",
      expect.objectContaining({
        body: JSON.stringify({
          p_action: "confirm",
          p_calendar_attempted_at:
            request.calendar.attemptedAt,
          p_calendar_checked_at: request.calendar.checkedAt,
          p_calendar_status: "conflict_kept",
          p_conflict_consent: true,
          p_draft_id: request.draft.id,
          p_expected_stage: "conflict_confirming",
          p_final_observation: "free",
          p_owner_chat_id: request.chatId,
          p_owner_id: String(request.chatId),
          p_update_id: request.updateId,
          p_version: request.draft.version,
        }),
        method: "POST",
      }),
    );
    expect(
      JSON.parse(
        String(fetchFromSupabase.mock.calls[0][1]?.body),
      ),
    ).not.toHaveProperty("definitionOfDone");
    expect(String(fetchFromSupabase.mock.calls[0][1]?.body)).not.toMatch(
      /title|attendee|description|event|credential|token/i,
    );
  });

  it.each(["applied", "replay", "resolved", "stale"] as const)(
    "accepts the bounded %s result",
    async (kind) => {
      const committer = new SupabaseWorkSessionCommitter({
        fetch: (async () => Response.json({ kind })) as typeof fetch,
        ownerId: request.chatId,
        supabaseSecretKey: "test-secret",
        supabaseUrl: "http://127.0.0.1:54321",
      });

      await expect(committer.commit(request)).resolves.toEqual({ kind });
    },
  );

  it("fails closed on transport and malformed results", async () => {
    const failed = new SupabaseWorkSessionCommitter({
      fetch: (async () =>
        new Response("{}", { status: 409 })) as typeof fetch,
      ownerId: request.chatId,
      supabaseSecretKey: "test-secret",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    await expect(failed.commit(request)).rejects.toThrow(
      "Work-session confirmation failed",
    );

    const malformed = new SupabaseWorkSessionCommitter({
      fetch: (async () => Response.json({ kind: "unknown" })) as typeof fetch,
      ownerId: request.chatId,
      supabaseSecretKey: "test-secret",
      supabaseUrl: "http://127.0.0.1:54321",
    });
    await expect(malformed.commit(request)).rejects.toThrow(
      "Work-session confirmation returned invalid data",
    );
  });
});
