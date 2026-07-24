import { describe, expect, it, vi } from "vitest";
import type { DecisionContextFields } from "../decision/schema.js";
import {
  type DecisionAudit,
  SupabaseConversationRepository,
} from "./repository.js";

const simpleFields: DecisionContextFields = {
  definitionOfDone: "Submit the synthetic note",
  durationMinutes: null,
  offerWorkWindowHelp: false,
  possibleWorkSession: false,
  simpleAction: true,
  targetAt: "2026-07-26T10:00:00+08:00",
  targetTimeZone: "Asia/Singapore",
  timingConstraints: ["Before lunch"],
};
const explicitAudit = {
  inputClass: "explicit_commitment",
  modelId: "gpt-test-model",
  payload: {
    ...simpleFields,
    missingFields: [],
    nextAction: "ready",
    turnRelation: "correction",
  },
  promptVersion: "shiori-test-v1",
} satisfies DecisionAudit;

function repositoryWith(fetchFromSupabase: typeof fetch) {
  return new SupabaseConversationRepository({
    fetch: fetchFromSupabase,
    supabaseSecretKey: "header.payload.signature",
    supabaseUrl: "http://127.0.0.1:54321",
  });
}

describe("SupabaseConversationRepository", () => {
  it("reads only bounded draft fields and version context", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        ...simpleFields,
        expiresAt: "2026-07-26T12:00:00.000Z",
        id: "11111111-1111-4111-8111-111111111111",
        kind: "draft",
        phase: "complete",
        version: 4,
      }),
    );

    await expect(
      repositoryWith(fetchFromSupabase as typeof fetch).readTurn(9001),
    ).resolves.toEqual({
      expiresAt: "2026-07-26T12:00:00.000Z",
      fields: simpleFields,
      id: "11111111-1111-4111-8111-111111111111",
      kind: "draft",
      phase: "complete",
      version: 4,
    });

    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/read_conversation_turn",
    );
    expect(options?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer header.payload.signature",
      "Content-Type": "application/json",
      apikey: "header.payload.signature",
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      p_update_id: 9001,
    });
  });

  it("reads exact permission correlation without raw owner material", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        ...simpleFields,
        correlatedUpdateId: 9003,
        expiresAt: "2026-07-26T12:00:00.000Z",
        id: "22222222-2222-4222-8222-222222222222",
        kind: "permission",
        sourceUpdateId: 9002,
      }),
    );

    const result = await repositoryWith(
      fetchFromSupabase as typeof fetch,
    ).readTurn(9003);

    expect(result).toEqual({
      correlatedUpdateId: 9003,
      expiresAt: "2026-07-26T12:00:00.000Z",
      fields: simpleFields,
      id: "22222222-2222-4222-8222-222222222222",
      kind: "permission",
      sourceUpdateId: 9002,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ownerText|transcript|provider|response/,
    );
  });

  it("sends candidate fields only for candidate-writing actions", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        completed: true,
        draftCreated: false,
        status: "applied",
      }),
    );
    const repository = repositoryWith(
      fetchFromSupabase as typeof fetch,
    );

    await repository.applyTurn({
      action: "update_draft",
      audit: explicitAudit,
      expected: {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "draft",
        version: 7,
      },
      fields: simpleFields,
      phase: "complete",
      processingResult: "conversation",
      updateId: 9004,
    });
    await repository.applyTurn({
      action: "preserve",
      audit: explicitAudit,
      expected: {
        id: "33333333-3333-4333-8333-333333333333",
        kind: "draft",
        version: 8,
      },
      processingResult: "conversation",
      updateId: 9005,
    });

    const candidateBody = JSON.parse(
      String(fetchFromSupabase.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(candidateBody).toMatchObject({
      p_action: "update_draft",
      p_definition_of_done: simpleFields.definitionOfDone,
      p_expected_id: "33333333-3333-4333-8333-333333333333",
      p_expected_kind: "draft",
      p_expected_version: 7,
      p_phase: "complete",
      p_target_at: simpleFields.targetAt,
      p_timing_constraints: simpleFields.timingConstraints,
      p_update_id: 9004,
    });

    const preserveBody = JSON.parse(
      String(fetchFromSupabase.mock.calls[1][1]?.body),
    ) as Record<string, unknown>;
    expect(preserveBody).toMatchObject({
      p_action: "preserve",
      p_definition_of_done: null,
      p_duration_minutes: null,
      p_offer_work_window_help: null,
      p_phase: null,
      p_possible_work_session: null,
      p_simple_action: null,
      p_target_at: null,
      p_target_time_zone: null,
      p_timing_constraints: null,
      p_update_id: 9005,
    });
    expect(preserveBody.p_audit_input_class).toBe("explicit_commitment");
    expect(preserveBody.p_audit_payload).toEqual(explicitAudit.payload);
    expect(preserveBody.p_model_id).toBe("gpt-test-model");
    expect(preserveBody.p_prompt_version).toBe("shiori-test-v1");
    expect(JSON.stringify(preserveBody)).not.toMatch(
      /response|ownerText|transcript|provider/,
    );
  });

  it("accepts permission by correlation identity without resending candidate fields", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        completed: true,
        draftCreated: true,
        status: "applied",
      }),
    );

    await expect(
      repositoryWith(fetchFromSupabase as typeof fetch).applyTurn({
        action: "accept_permission",
        audit: {
          ...explicitAudit,
          payload: {
            ...explicitAudit.payload,
            turnRelation: "permission_accepted",
          },
        },
        expected: {
          correlatedUpdateId: 9007,
          id: "44444444-4444-4444-8444-444444444444",
          kind: "permission",
          sourceUpdateId: 9006,
        },
        processingResult: "conversation",
        updateId: 9007,
      }),
    ).resolves.toEqual({
      completed: true,
      draftCreated: true,
      status: "applied",
    });

    const body = JSON.parse(
      String(fetchFromSupabase.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      p_action: "accept_permission",
      p_definition_of_done: null,
      p_expected_correlated_update_id: 9007,
      p_expected_id: "44444444-4444-4444-8444-444444444444",
      p_expected_kind: "permission",
      p_expected_source_update_id: 9006,
      p_timing_constraints: null,
      p_update_id: 9007,
    });
    expect(body.p_definition_of_done).toBeNull();
    expect(body.p_audit_payload).toMatchObject({
      definitionOfDone: simpleFields.definitionOfDone,
      turnRelation: "permission_accepted",
    });
  });

  it("routes accepted work-session permission through the bounded work RPC", async () => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        completed: true,
        draftCreated: true,
        draftReference: {
          id: "55555555-5555-4555-8555-555555555555",
          version: 1,
        },
        status: "applied",
      }),
    );
    const fields: DecisionContextFields = {
      ...simpleFields,
      possibleWorkSession: true,
      simpleAction: false,
    };

    await repositoryWith(fetchFromSupabase as typeof fetch).applyTurn({
      action: "accept_work_permission",
      audit: explicitAudit,
      expected: {
        correlatedUpdateId: 9012,
        id: "66666666-6666-4666-8666-666666666666",
        kind: "permission",
        sourceUpdateId: 9011,
      },
      fields,
      phase: "complete",
      processingResult: "conversation",
      updateId: 9012,
    });

    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/accept_work_session_permission",
    );
    expect(JSON.parse(String(options?.body))).toMatchObject({
      p_expected_correlated_update_id: 9012,
      p_expected_id: "66666666-6666-4666-8666-666666666666",
      p_expected_kind: "permission",
      p_expected_source_update_id: 9011,
      p_possible_work_session: true,
      p_simple_action: false,
      p_update_id: 9012,
    });
  });

  it.each([
    { kind: "busy", completed: true },
    { kind: "expired", completed: true },
    { kind: "interrupted", completed: true },
  ])("accepts terminal pre-engine result $kind", async (result) => {
    const fetchFromSupabase = vi.fn(async () => Response.json(result));

    await expect(
      repositoryWith(fetchFromSupabase as typeof fetch).readTurn(9008),
    ).resolves.toEqual(result);
  });

  it.each(["applied", "expired", "interrupted", "stale"] as const)(
    "accepts bounded apply status %s",
    async (status) => {
      const fetchFromSupabase = vi.fn(async () =>
        Response.json({
          completed: true,
          draftCreated: false,
          status,
        }),
      );

      await expect(
        repositoryWith(fetchFromSupabase as typeof fetch).applyTurn({
          action: "preserve",
          audit: explicitAudit,
          expected: { kind: "none" },
          processingResult: "conversation",
          updateId: 9011,
        }),
      ).resolves.toEqual({
        completed: true,
        draftCreated: false,
        status,
      });
    },
  );

  it("fails closed on malformed repository responses", async () => {
    const invalidRead = repositoryWith(
      vi.fn(async () =>
        Response.json({
          ...simpleFields,
          expiresAt: "2026-07-26T12:00:00.000Z",
          id: "opaque",
          kind: "draft",
          phase: "complete",
          version: 0,
        }),
      ) as typeof fetch,
    );
    const invalidApply = repositoryWith(
      vi.fn(async () =>
        Response.json({
          completed: "yes",
          draftCreated: false,
          status: "applied",
        }),
      ) as typeof fetch,
    );

    await expect(invalidRead.readTurn(9009)).rejects.toThrow(
      "Conversation read returned an invalid draft",
    );
    await expect(
      invalidApply.applyTurn({
        action: "preserve",
        expected: { kind: "none" },
        processingResult: "conversation_failed",
        updateId: 9010,
      }),
    ).rejects.toThrow("Conversation apply returned an invalid response");
  });
});
