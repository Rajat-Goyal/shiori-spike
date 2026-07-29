import { describe, expect, it, vi } from "vitest";

import {
  ApprovedCommitmentChangeService,
  commitmentChangeCopy,
  commitmentEditApprovalReference,
  commitmentEditPreview,
  parseCommitmentEditApproval,
  SupabaseCommitmentChangeRepository,
  type CommitmentChangeRepository,
  type CommitmentEditProposal,
} from "./approved-change.js";

const commitmentId = "11111111-1111-4111-8111-111111111111";
const proposal: CommitmentEditProposal = {
  calendarPolicy: {
    conflict: "reject",
    unavailable: "reject",
  },
  commitmentId,
  definitionOfDone: "Publish the final video",
  expectedVersion: 4,
  preparation: {
    nextWorkSession: {
      durationMinutes: 60,
      endAt: "2026-08-01T04:00:00.000Z",
      startAt: "2026-08-01T03:00:00.000Z",
      timingConstraints: "before lunch",
    },
    required: true,
  },
  targetAt: "2026-08-01T09:00:00.000Z",
};
const authority = {
  chatId: 42,
  commitmentId,
  expectedVersion: 4,
  updateId: 900,
};

describe("approved commitment changes", () => {
  it("renders application-owned exact preview actions without exposing callback authority in copy", () => {
    const approve = commitmentEditApprovalReference(
      proposal,
      "approve",
    );
    const preview = commitmentEditPreview(proposal);

    expect(parseCommitmentEditApproval(approve)).toEqual({
      action: "approve",
      commitmentId,
      version: 4,
    });
    expect(preview.actions).toEqual([
      { callbackData: approve, text: "Approve change" },
      {
        callbackData: `e:${commitmentId}:4:reject`,
        text: "Reject",
      },
    ]);
    expect(preview.text).toContain("Nothing has been changed yet.");
    expect(preview.text).toContain("Will be rechecked");
    expect(preview.text).not.toContain(approve);
    expect(
      parseCommitmentEditApproval(
        `e:${commitmentId}:5:approve:extra`,
      ),
    ).toBeNull();
  });

  it("rechecks Calendar before mutation and refuses an unapproved conflict", async () => {
    const repository: CommitmentChangeRepository = {
      apply: vi.fn(),
    };
    const calendar = {
      verify: vi.fn(async () => ({
        attemptedAt: "2026-07-31T00:00:00.000Z",
        checkedAt: "2026-07-31T00:00:01.000Z",
        status: "conflict" as const,
      })),
    };
    const service = new ApprovedCommitmentChangeService({
      calendar,
      repository,
    });

    await expect(service.apply(authority, proposal)).resolves.toEqual({
      reply: { text: commitmentChangeCopy.calendarConflict },
      status: "executed",
    });
    expect(calendar.verify).toHaveBeenCalledWith(
      proposal.preparation.nextWorkSession,
    );
    expect(repository.apply).not.toHaveBeenCalled();
  });

  it("passes only final sanitized Calendar audit into the atomic repository", async () => {
    const repository: CommitmentChangeRepository = {
      apply: vi.fn(async () => ({ kind: "applied", version: 5 })),
    };
    const service = new ApprovedCommitmentChangeService({
      calendar: {
        verify: vi.fn(async () => ({
          attemptedAt: "2026-07-31T00:00:00.000Z",
          checkedAt: "2026-07-31T00:00:01.000Z",
          status: "free" as const,
        })),
      },
      repository,
    });

    await expect(service.apply(authority, proposal)).resolves.toEqual({
      reply: {
        text:
          "Promise updated. The next work session was free when rechecked.",
      },
      status: "executed",
    });
    expect(repository.apply).toHaveBeenCalledWith({
      authority,
      calendar: {
        attemptedAt: "2026-07-31T00:00:00.000Z",
        checkedAt: "2026-07-31T00:00:01.000Z",
        conflictConsent: false,
        finalObservation: "free",
        status: "free",
      },
      proposal,
    });
  });

  it("reports an active work session without projecting an edit success", async () => {
    const service = new ApprovedCommitmentChangeService({
      calendar: {
        verify: vi.fn(async () => ({
          attemptedAt: "2026-07-31T00:00:00.000Z",
          checkedAt: "2026-07-31T00:00:01.000Z",
          status: "free" as const,
        })),
      },
      repository: {
        apply: vi.fn(async () => ({ kind: "in_progress" as const })),
      },
    });

    await expect(service.apply(authority, proposal)).resolves.toEqual({
      reply: { text: commitmentChangeCopy.inProgress },
      status: "executed",
    });
  });

  it("honors an exact unverified-save policy and projects stale/replay safely", async () => {
    const apply = vi
      .fn<CommitmentChangeRepository["apply"]>()
      .mockResolvedValueOnce({ kind: "stale" })
      .mockResolvedValueOnce({ kind: "replay" });
    const service = new ApprovedCommitmentChangeService({
      calendar: {
        verify: vi.fn(async () => ({
          attemptedAt: "2026-07-31T00:00:00.000Z",
          checkedAt: null,
          status: "unavailable" as const,
        })),
      },
      repository: { apply },
    });
    const unverified = {
      ...proposal,
      calendarPolicy: {
        ...proposal.calendarPolicy,
        unavailable: "save_unverified" as const,
      },
    };

    await expect(service.apply(authority, unverified)).resolves.toEqual({
      reply: { text: commitmentChangeCopy.stale },
      status: "executed",
    });
    expect(apply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        calendar: {
          attemptedAt: "2026-07-31T00:00:00.000Z",
          checkedAt: null,
          conflictConsent: false,
          finalObservation: "unavailable",
          status: "unverified",
        },
      }),
    );
    await expect(service.apply(authority, unverified)).resolves.toEqual({
      reply: { text: commitmentChangeCopy.replay },
      status: "replay",
    });
  });

  it("uses one bounded RPC with exact owner/entity/version authority", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({ kind: "applied", version: 5 })
    );
    const repository = new SupabaseCommitmentChangeRepository({
      fetch: fetchFromSupabase as typeof fetch,
      ownerId: 42,
      supabaseSecretKey: "sb_secret",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(
      repository.apply({
        authority,
        calendar: {
          attemptedAt: "2026-07-31T00:00:00.000Z",
          checkedAt: "2026-07-31T00:00:01.000Z",
          conflictConsent: false,
          finalObservation: "free",
          status: "free",
        },
        proposal,
      }),
    ).resolves.toEqual({ kind: "applied", version: 5 });

    expect(fetchFromSupabase).toHaveBeenCalledWith(
      "http://127.0.0.1:54321/rest/v1/rpc/apply_approved_commitment_change",
      expect.objectContaining({
        body: JSON.stringify({
          p_calendar_attempted_at: "2026-07-31T00:00:00.000Z",
          p_calendar_checked_at: "2026-07-31T00:00:01.000Z",
          p_calendar_status: "free",
          p_commitment_id: commitmentId,
          p_conflict_consent: false,
          p_definition_of_done: "Publish the final video",
          p_expected_version: 4,
          p_final_observation: "free",
          p_next_duration_minutes: 60,
          p_next_end_at: "2026-08-01T04:00:00.000Z",
          p_next_start_at: "2026-08-01T03:00:00.000Z",
          p_owner_chat_id: 42,
          p_owner_id: "42",
          p_preparation_required: true,
          p_target_at: "2026-08-01T09:00:00.000Z",
          p_timing_constraints: "before lunch",
          p_update_id: 900,
        }),
        method: "POST",
      }),
    );
  });
});
