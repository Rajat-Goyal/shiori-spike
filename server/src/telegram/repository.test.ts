import { describe, expect, it, vi } from "vitest";
import { SupabaseTelegramRepository } from "./repository.js";

describe("SupabaseTelegramRepository", () => {
  it("claims only update identity and optional owner chat through the RPC", async () => {
    const fetchFromSupabase = vi.fn(async () => Response.json(true));
    const repository = new SupabaseTelegramRepository({
      fetch: fetchFromSupabase as typeof fetch,
      supabaseSecretKey: "sb_secret_opaque-test-key",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await expect(repository.claimUpdate(7001, 123456789)).resolves.toBe(true);

    expect(fetchFromSupabase).toHaveBeenCalledOnce();
    const [url, options] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/claim_telegram_update",
    );
    expect(options?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: "sb_secret_opaque-test-key",
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      p_owner_chat_id: 123456789,
      p_update_id: 7001,
    });
  });

  it("completes with a bounded result and reads only active commitment identity", async () => {
    const fetchFromSupabase = vi
      .fn()
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(Response.json([]));
    const repository = new SupabaseTelegramRepository({
      fetch: fetchFromSupabase as typeof fetch,
      supabaseSecretKey: "header.payload.signature",
      supabaseUrl: "http://127.0.0.1:54321",
    });

    await repository.completeUpdate(7002, "status_empty");
    await expect(repository.hasActiveCommitments()).resolves.toBe(false);

    const [completionUrl, completionOptions] = fetchFromSupabase.mock.calls[0];
    expect(completionUrl).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/complete_telegram_update",
    );
    expect(completionOptions?.headers).toMatchObject({
      Authorization: "Bearer header.payload.signature",
      apikey: "header.payload.signature",
    });
    expect(JSON.parse(String(completionOptions?.body))).toEqual({
      p_processing_result: "status_empty",
      p_update_id: 7002,
    });
    expect(fetchFromSupabase.mock.calls[1][0]).toBe(
      "http://127.0.0.1:54321/rest/v1/commitments?select=id&status=eq.active&limit=1",
    );
  });
});
