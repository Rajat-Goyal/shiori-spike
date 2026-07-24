import { supabaseHeaders } from "../supabase.js";
import type { EncryptedSecret } from "./crypto.js";

export const googleOAuthScopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

export type GoogleOAuthIntent = "connect" | "reconnect";
export type GoogleOAuthOutcome =
  | "connected"
  | "reconnected"
  | "invalid_state"
  | "identity_mismatch"
  | "denied"
  | "failed";

export type GoogleOAuthAttempt = Readonly<{
  encryptedVerifier: EncryptedSecret;
  expiresAt: string;
  intent: GoogleOAuthIntent;
  nonceDigest: string;
  sessionDigest: string;
  stateDigest: string;
}>;

export type ClaimedGoogleOAuthAttempt = Readonly<{
  encryptedVerifier: EncryptedSecret;
  intent: GoogleOAuthIntent;
  nonceDigest: string;
}>;

export type StoredGoogleConnection = Readonly<{
  calendarId: "primary";
  encryptedRefreshToken: EncryptedSecret;
  verifiedEmail: string;
}>;

export type GoogleConnectionRecord = Readonly<{
  calendarId: "primary";
  keyVersion: number;
  lastSuccessfulCheckAt: string | null;
  scopes: readonly string[];
  status: "authorization_expired" | "connected";
  verifiedEmail: string;
}>;

export type GoogleCalendarCredential = Readonly<{
  calendarId: "primary";
  encryptedRefreshToken: EncryptedSecret;
  scopes: readonly string[];
  status: "authorization_expired" | "connected";
  verifiedEmail: string;
}>;

export interface GoogleCalendarCredentialRepository {
  markAuthorizationExpired(): Promise<void>;
  readCredential(): Promise<GoogleCalendarCredential | undefined>;
}

export interface GoogleOAuthRepository {
  claimAttempt(
    stateDigest: string,
    sessionDigest: string,
  ): Promise<ClaimedGoogleOAuthAttempt | undefined>;
  consumeOutcome(
    sessionDigest: string,
  ): Promise<GoogleOAuthOutcome | undefined>;
  createAttempt(attempt: GoogleOAuthAttempt): Promise<void>;
  readConnection(): Promise<GoogleConnectionRecord | undefined>;
  replaceConnection(connection: StoredGoogleConnection): Promise<void>;
  storeOutcome(
    sessionDigest: string,
    outcome: GoogleOAuthOutcome,
    expiresAt: string,
  ): Promise<void>;
}

type SupabaseGoogleOAuthRepositoryOptions = {
  fetch?: typeof fetch;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasExactGoogleScopes(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length === googleOAuthScopes.length &&
    value.every((scope, index) => scope === googleOAuthScopes[index])
  );
}

function isClaimedAttempt(value: unknown): value is {
  intent: GoogleOAuthIntent;
  key_version: number;
  nonce_digest: string;
  verifier_ciphertext: string;
  verifier_nonce: string;
  verifier_tag: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    ["connect", "reconnect"].includes(String(row.intent)) &&
    Number.isSafeInteger(row.key_version) &&
    Number(row.key_version) > 0 &&
    typeof row.nonce_digest === "string" &&
    typeof row.verifier_ciphertext === "string" &&
    typeof row.verifier_nonce === "string" &&
    typeof row.verifier_tag === "string"
  );
}

function isConnectionRecord(value: unknown): value is {
  calendar_id: "primary";
  key_version: number;
  last_successful_check_at: string | null;
  scopes: string[];
  status: "authorization_expired" | "connected";
  verified_email: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    row.calendar_id === "primary" &&
    Number.isSafeInteger(row.key_version) &&
    Number(row.key_version) > 0 &&
    (row.last_successful_check_at === null ||
      (typeof row.last_successful_check_at === "string" &&
        !Number.isNaN(Date.parse(row.last_successful_check_at)))) &&
    hasExactGoogleScopes(row.scopes) &&
    (row.status === "connected" || row.status === "authorization_expired") &&
    typeof row.verified_email === "string"
  );
}

function isCredentialRecord(value: unknown): value is {
  calendar_id: "primary";
  key_version: number;
  refresh_token_ciphertext: string;
  refresh_token_nonce: string;
  refresh_token_tag: string;
  scopes: string[];
  status: "authorization_expired" | "connected";
  verified_email: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    row.calendar_id === "primary" &&
    Number.isSafeInteger(row.key_version) &&
    Number(row.key_version) > 0 &&
    typeof row.refresh_token_ciphertext === "string" &&
    row.refresh_token_ciphertext.length > 0 &&
    typeof row.refresh_token_nonce === "string" &&
    row.refresh_token_nonce.length > 0 &&
    typeof row.refresh_token_tag === "string" &&
    row.refresh_token_tag.length > 0 &&
    hasExactGoogleScopes(row.scopes) &&
    (row.status === "connected" || row.status === "authorization_expired") &&
    typeof row.verified_email === "string"
  );
}

export class SupabaseGoogleOAuthRepository
  implements GoogleOAuthRepository, GoogleCalendarCredentialRepository
{
  readonly #fetch: typeof fetch;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseGoogleOAuthRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async #rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/rpc/${name}`,
      {
        body: JSON.stringify(body),
        headers: supabaseHeaders(
          this.#supabaseSecretKey,
          "application/json",
        ),
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) {
      throw new Error("Google OAuth persistence failed");
    }
    return response.json();
  }

  async createAttempt(attempt: GoogleOAuthAttempt): Promise<void> {
    const result = await this.#rpc("create_google_oauth_attempt", {
      p_expires_at: attempt.expiresAt,
      p_intent: attempt.intent,
      p_key_version: attempt.encryptedVerifier.keyVersion,
      p_nonce_digest: attempt.nonceDigest,
      p_session_digest: attempt.sessionDigest,
      p_state_digest: attempt.stateDigest,
      p_verifier_ciphertext: attempt.encryptedVerifier.ciphertext,
      p_verifier_nonce: attempt.encryptedVerifier.nonce,
      p_verifier_tag: attempt.encryptedVerifier.tag,
    });
    if (result !== true) {
      throw new Error("Google OAuth attempt persistence failed");
    }
  }

  async claimAttempt(
    stateDigest: string,
    sessionDigest: string,
  ): Promise<ClaimedGoogleOAuthAttempt | undefined> {
    const result = await this.#rpc("claim_google_oauth_attempt", {
      p_session_digest: sessionDigest,
      p_state_digest: stateDigest,
    });
    if (result === null) {
      return undefined;
    }
    if (!isClaimedAttempt(result)) {
      throw new Error("Google OAuth attempt persistence returned invalid data");
    }
    return {
      encryptedVerifier: {
        ciphertext: result.verifier_ciphertext,
        keyVersion: result.key_version,
        nonce: result.verifier_nonce,
        tag: result.verifier_tag,
      },
      intent: result.intent,
      nonceDigest: result.nonce_digest,
    };
  }

  async storeOutcome(
    sessionDigest: string,
    outcome: GoogleOAuthOutcome,
    expiresAt: string,
  ): Promise<void> {
    const result = await this.#rpc("store_google_oauth_outcome", {
      p_expires_at: expiresAt,
      p_outcome: outcome,
      p_session_digest: sessionDigest,
    });
    if (result !== true) {
      throw new Error("Google OAuth outcome persistence failed");
    }
  }

  async consumeOutcome(
    sessionDigest: string,
  ): Promise<GoogleOAuthOutcome | undefined> {
    const result = await this.#rpc("consume_google_oauth_outcome", {
      p_session_digest: sessionDigest,
    });
    if (result === null) {
      return undefined;
    }
    if (
      ![
        "connected",
        "reconnected",
        "invalid_state",
        "identity_mismatch",
        "denied",
        "failed",
      ].includes(String(result))
    ) {
      throw new Error("Google OAuth outcome persistence returned invalid data");
    }
    return result as GoogleOAuthOutcome;
  }

  async replaceConnection(
    connection: StoredGoogleConnection,
  ): Promise<void> {
    const result = await this.#rpc("replace_google_calendar_connection", {
      p_calendar_id: connection.calendarId,
      p_key_version: connection.encryptedRefreshToken.keyVersion,
      p_refresh_token_ciphertext:
        connection.encryptedRefreshToken.ciphertext,
      p_refresh_token_nonce: connection.encryptedRefreshToken.nonce,
      p_refresh_token_tag: connection.encryptedRefreshToken.tag,
      p_scopes: googleOAuthScopes,
      p_verified_email: connection.verifiedEmail,
    });
    if (result !== true) {
      throw new Error("Google connection persistence failed");
    }
  }

  async readConnection(): Promise<GoogleConnectionRecord | undefined> {
    const result = await this.#rpc(
      "read_google_calendar_connection_state",
      {},
    );
    if (result === null) {
      return undefined;
    }
    if (!isConnectionRecord(result)) {
      throw new Error("Google connection persistence returned invalid data");
    }
    return {
      calendarId: result.calendar_id,
      keyVersion: result.key_version,
      lastSuccessfulCheckAt: result.last_successful_check_at,
      scopes: result.scopes,
      status: result.status,
      verifiedEmail: result.verified_email,
    };
  }

  async readCredential(): Promise<GoogleCalendarCredential | undefined> {
    const result = await this.#rpc(
      "read_google_calendar_credential",
      {},
    );
    if (result === null) {
      return undefined;
    }
    if (!isCredentialRecord(result)) {
      throw new Error("Google credential persistence returned invalid data");
    }
    return {
      calendarId: result.calendar_id,
      encryptedRefreshToken: {
        ciphertext: result.refresh_token_ciphertext,
        keyVersion: result.key_version,
        nonce: result.refresh_token_nonce,
        tag: result.refresh_token_tag,
      },
      scopes: result.scopes,
      status: result.status,
      verifiedEmail: result.verified_email,
    };
  }

  async markAuthorizationExpired(): Promise<void> {
    const result = await this.#rpc(
      "mark_google_calendar_authorization_expired",
      {},
    );
    if (result !== true) {
      throw new Error("Google credential persistence failed");
    }
  }
}
