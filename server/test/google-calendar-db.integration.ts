import { randomBytes, randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { digest, encryptSecret } from "../src/google/crypto.js";
import {
  googleOAuthScopes,
  SupabaseGoogleOAuthRepository,
} from "../src/google/repository.js";
import { supabaseHeaders } from "../src/supabase.js";

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

describe("local Supabase Google Calendar connection", () => {
  it("keeps attempts and outcomes one-use and reconnect replacement atomic", async () => {
    const config = localConfig();
    const repository = new SupabaseGoogleOAuthRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const suffix = `${Date.now()}-${randomInt(1_000_000_000)}`;
    const stateDigest = digest(`state-${suffix}`);
    const sessionDigest = digest(`session-${suffix}`);
    const encryptedVerifier = encryptSecret({
      email: config.googleOwnerEmail,
      key: Buffer.from(config.googleTokenEncryptionKey, "base64"),
      keyVersion: config.googleTokenKeyVersion,
      ownerReference: "owner",
      plaintext: `verifier-${suffix}`,
      purpose: "pkce_verifier",
    });

    await repository.createAttempt({
      encryptedVerifier,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      intent: "connect",
      nonceDigest: digest(`nonce-${suffix}`),
      sessionDigest,
      stateDigest,
    });
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "google_oauth_attempts",
        `&session_digest=eq.${sessionDigest}`,
      ),
    ).toHaveLength(1);

    await expect(
      repository.claimAttempt(stateDigest, sessionDigest),
    ).resolves.toMatchObject({ intent: "connect" });
    await expect(
      repository.claimAttempt(stateDigest, sessionDigest),
    ).resolves.toBeUndefined();
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "google_oauth_attempts",
        `&session_digest=eq.${sessionDigest}`,
      ),
    ).toHaveLength(0);

    await repository.storeOutcome(
      sessionDigest,
      "connected",
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "google_oauth_outcomes",
        `&session_digest=eq.${sessionDigest}`,
      ),
    ).toHaveLength(1);
    await expect(repository.consumeOutcome(sessionDigest)).resolves.toBe(
      "connected",
    );
    await expect(repository.consumeOutcome(sessionDigest)).resolves.toBeUndefined();
    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "google_oauth_outcomes",
        `&session_digest=eq.${sessionDigest}`,
      ),
    ).toHaveLength(0);

    const baselineToken = encryptSecret({
      email: config.googleOwnerEmail,
      key: Buffer.from(config.googleTokenEncryptionKey, "base64"),
      keyVersion: config.googleTokenKeyVersion,
      ownerReference: "owner",
      plaintext: `baseline-refresh-${suffix}`,
      purpose: "refresh_token",
    });
    await repository.replaceConnection({
      calendarId: "primary",
      encryptedRefreshToken: baselineToken,
      verifiedEmail: config.googleOwnerEmail,
    });
    const baselineRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "google_calendar_connection",
    );
    expect(baselineRows).toHaveLength(1);
    const baselineBytes = JSON.stringify(baselineRows[0]);
    expect(baselineBytes).not.toContain(`baseline-refresh-${suffix}`);
    expect(baselineRows[0]).toMatchObject({
      calendar_id: "primary",
      key_version: config.googleTokenKeyVersion,
      scopes: googleOAuthScopes,
      singleton: true,
      status: "connected",
      verified_email: config.googleOwnerEmail,
    });

    for (const outcome of ["denied", "failed", "identity_mismatch"] as const) {
      await repository.storeOutcome(
        digest(`${outcome}-${suffix}`),
        outcome,
        new Date(Date.now() + 10 * 60_000).toISOString(),
      );
      const afterFailure = await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "google_calendar_connection",
      );
      expect(afterFailure).toHaveLength(1);
      expect(JSON.stringify(afterFailure[0])).toBe(baselineBytes);
    }

    const reconnectedToken = encryptSecret({
      email: config.googleOwnerEmail,
      key: Buffer.from(config.googleTokenEncryptionKey, "base64"),
      keyVersion: config.googleTokenKeyVersion,
      ownerReference: "owner",
      plaintext: `reconnected-refresh-${suffix}`,
      purpose: "refresh_token",
    });
    await repository.replaceConnection({
      calendarId: "primary",
      encryptedRefreshToken: reconnectedToken,
      verifiedEmail: config.googleOwnerEmail,
    });
    const reconnectedRows = await rows(
      config.supabaseUrl,
      config.supabaseSecretKey,
      "google_calendar_connection",
    );
    expect(reconnectedRows).toHaveLength(1);
    expect(JSON.stringify(reconnectedRows[0])).not.toBe(baselineBytes);
    expect(reconnectedRows[0]).toMatchObject({
      calendar_id: "primary",
      key_version: config.googleTokenKeyVersion,
      scopes: googleOAuthScopes,
      singleton: true,
      status: "connected",
    });
  });

  it("prunes expired outcomes from prior owner sessions", async () => {
    const config = localConfig();
    const repository = new SupabaseGoogleOAuthRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const suffix = randomBytes(12).toString("base64url");
    const expiredSession = digest(`expired-${suffix}`);
    await repository.storeOutcome(
      expiredSession,
      "failed",
      new Date(Date.now() + 1_000).toISOString(),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await repository.storeOutcome(
      digest(`current-${suffix}`),
      "connected",
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );

    expect(
      await rows(
        config.supabaseUrl,
        config.supabaseSecretKey,
        "google_oauth_outcomes",
        `&session_digest=eq.${expiredSession}`,
      ),
    ).toHaveLength(0);
  });
});
