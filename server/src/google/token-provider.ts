import {
  decodeGoogleEncryptionKey,
  decryptSecret,
} from "./crypto.js";
import type {
  GoogleCalendarTokenProvider,
  GoogleCalendarTokenResult,
} from "./calendar.js";
import {
  googleOAuthScopes,
  type GoogleCalendarCredentialRepository,
} from "./repository.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OWNER_REFERENCE = "owner";
const PROVIDER_TIMEOUT_MS = 5_000;

type GoogleRefreshTokenProviderOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  fetch?: typeof fetch;
  keyVersion: number;
  ownerEmail: string;
  repository: GoogleCalendarCredentialRepository;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function responseRecord(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    return record(await response.json());
  } catch {
    return undefined;
  }
}

export class GoogleRefreshTokenProvider
  implements GoogleCalendarTokenProvider
{
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #encryptionKey: Buffer;
  readonly #fetch: typeof fetch;
  readonly #keyVersion: number;
  readonly #ownerEmail: string;
  readonly #repository: GoogleCalendarCredentialRepository;

  constructor(options: GoogleRefreshTokenProviderOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#encryptionKey = decodeGoogleEncryptionKey(options.encryptionKey);
    this.#fetch = options.fetch ?? fetch;
    this.#keyVersion = options.keyVersion;
    this.#ownerEmail = options.ownerEmail;
    this.#repository = options.repository;
  }

  async getToken(): Promise<GoogleCalendarTokenResult> {
    let credential;
    try {
      credential = await this.#repository.readCredential();
    } catch {
      return { status: "unavailable" };
    }
    if (!credential) {
      return { status: "unavailable" };
    }
    if (credential.status === "authorization_expired") {
      return { status: "authorization_expired" };
    }
    if (
      credential.calendarId !== "primary" ||
      credential.verifiedEmail !== this.#ownerEmail ||
      credential.scopes.length !== googleOAuthScopes.length ||
      credential.scopes.some(
        (scope, index) => scope !== googleOAuthScopes[index],
      )
    ) {
      return { status: "unavailable" };
    }

    let refreshToken: string;
    try {
      refreshToken = decryptSecret(credential.encryptedRefreshToken, {
        email: this.#ownerEmail,
        key: this.#encryptionKey,
        keyVersion: this.#keyVersion,
        ownerReference: OWNER_REFERENCE,
        purpose: "refresh_token",
      });
    } catch {
      return { status: "unavailable" };
    }
    if (refreshToken.length === 0 || refreshToken.length > 8_192) {
      return { status: "unavailable" };
    }

    let response: Response;
    try {
      response = await this.#fetch(GOOGLE_TOKEN_URL, {
        body: new URLSearchParams({
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      return { status: "provider_failure" };
    }

    const body = await responseRecord(response);
    if (!response.ok) {
      if (body?.error === "invalid_grant") {
        try {
          await this.#repository.markAuthorizationExpired();
        } catch {
          // The provider result remains authoritative for this request.
        }
        return { status: "authorization_expired" };
      }
      return { status: "provider_failure" };
    }

    const accessToken = body?.access_token;
    const expiresIn = body?.expires_in;
    const tokenType = body?.token_type;
    if (
      typeof accessToken !== "string" ||
      accessToken.length === 0 ||
      accessToken.length > 8_192 ||
      typeof expiresIn !== "number" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      tokenType !== "Bearer"
    ) {
      return { status: "provider_failure" };
    }

    return { accessToken, status: "ok" };
  }
}
