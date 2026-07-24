import { describe, expect, it, vi } from "vitest";
import {
  googleOAuthScopes,
  SupabaseGoogleOAuthRepository,
} from "./repository.js";

function repositoryWith(fetchFromSupabase: typeof fetch) {
  return new SupabaseGoogleOAuthRepository({
    fetch: fetchFromSupabase,
    supabaseSecretKey: "unit-test-supabase-key",
    supabaseUrl: "http://127.0.0.1:54321",
  });
}

describe("SupabaseGoogleOAuthRepository", () => {
  it("persists only digests and an encrypted PKCE verifier for an attempt", async () => {
    const fetchFromSupabase = vi.fn(async () => Response.json(true));
    const repository = repositoryWith(fetchFromSupabase);

    await repository.createAttempt({
      encryptedVerifier: {
        ciphertext: "encrypted-verifier",
        keyVersion: 2,
        nonce: Buffer.alloc(12, 1).toString("base64"),
        tag: Buffer.alloc(16, 2).toString("base64"),
      },
      expiresAt: "2026-07-24T14:10:00.000Z",
      intent: "connect",
      nonceDigest: "n".repeat(43),
      sessionDigest: "s".repeat(43),
      stateDigest: "t".repeat(43),
    });

    const [url, request] = fetchFromSupabase.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:54321/rest/v1/rpc/create_google_oauth_attempt",
    );
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({
      p_expires_at: "2026-07-24T14:10:00.000Z",
      p_intent: "connect",
      p_key_version: 2,
      p_nonce_digest: "n".repeat(43),
      p_session_digest: "s".repeat(43),
      p_state_digest: "t".repeat(43),
      p_verifier_ciphertext: "encrypted-verifier",
      p_verifier_nonce: Buffer.alloc(12, 1).toString("base64"),
      p_verifier_tag: Buffer.alloc(16, 2).toString("base64"),
    });
    expect(JSON.stringify(body)).not.toContain("code_verifier");
  });

  it("claims one encrypted attempt and consumes one bounded outcome", async () => {
    const fetchFromSupabase = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          intent: "reconnect",
          key_version: 2,
          nonce_digest: "n".repeat(43),
          verifier_ciphertext: "encrypted-verifier",
          verifier_nonce: Buffer.alloc(12, 1).toString("base64"),
          verifier_tag: Buffer.alloc(16, 2).toString("base64"),
        }),
      )
      .mockResolvedValueOnce(Response.json("identity_mismatch"));
    const repository = repositoryWith(fetchFromSupabase);

    await expect(
      repository.claimAttempt("t".repeat(43), "s".repeat(43)),
    ).resolves.toMatchObject({
      intent: "reconnect",
      nonceDigest: "n".repeat(43),
    });
    await expect(
      repository.consumeOutcome("s".repeat(43)),
    ).resolves.toBe("identity_mismatch");

    expect(fetchFromSupabase.mock.calls[0][0]).toContain(
      "/rpc/claim_google_oauth_attempt",
    );
    expect(fetchFromSupabase.mock.calls[1][0]).toContain(
      "/rpc/consume_google_oauth_outcome",
    );
  });

  it("atomically replaces and reads only bounded connection state", async () => {
    const fetchFromSupabase = vi
      .fn()
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(
        Response.json({
          calendar_id: "primary",
          key_version: 2,
          last_successful_check_at: null,
          scopes: googleOAuthScopes,
          status: "connected",
          verified_email: "owner@example.com",
        }),
      );
    const repository = repositoryWith(fetchFromSupabase);

    await repository.replaceConnection({
      calendarId: "primary",
      encryptedRefreshToken: {
        ciphertext: "encrypted-refresh-token",
        keyVersion: 2,
        nonce: Buffer.alloc(12, 1).toString("base64"),
        tag: Buffer.alloc(16, 2).toString("base64"),
      },
      verifiedEmail: "owner@example.com",
    });
    await expect(repository.readConnection()).resolves.toEqual({
      calendarId: "primary",
      keyVersion: 2,
      lastSuccessfulCheckAt: null,
      scopes: googleOAuthScopes,
      status: "connected",
      verifiedEmail: "owner@example.com",
    });

    const replacementBody = JSON.parse(
      String(fetchFromSupabase.mock.calls[0][1]?.body),
    );
    expect(replacementBody).toMatchObject({
      p_calendar_id: "primary",
      p_scopes: googleOAuthScopes,
    });
    expect(fetchFromSupabase.mock.calls[1][0]).toContain(
      "/rpc/read_google_calendar_connection_state",
    );
  });

  it.each([
    [...googleOAuthScopes, "profile"],
    googleOAuthScopes.slice(0, 3),
    [...googleOAuthScopes].reverse(),
  ])("rejects non-exact stored scope set %j", async (scopes) => {
    const fetchFromSupabase = vi.fn(async () =>
      Response.json({
        calendar_id: "primary",
        key_version: 2,
        last_successful_check_at: null,
        scopes,
        status: "connected",
        verified_email: "owner@example.com",
      }),
    );

    await expect(repositoryWith(fetchFromSupabase).readConnection()).rejects.toThrow(
      "Google connection persistence returned invalid data",
    );
  });
});
