import {
  createPublicKey,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  decodeGoogleEncryptionKey,
  decryptSecret,
  digest,
  encryptSecret,
  pkceChallenge,
  randomOpaqueValue,
} from "./crypto.js";
import {
  type GoogleConnectionRecord,
  type GoogleOAuthIntent,
  type GoogleOAuthOutcome,
  type GoogleOAuthRepository,
  googleOAuthScopes,
} from "./repository.js";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;
const PROVIDER_TIMEOUT_MS = 5_000;
const OWNER_REFERENCE = "owner";

export type GoogleConnectionState =
  | Readonly<{
      action: "connect";
      outcome?: GoogleOAuthOutcome;
      state: "disconnected";
    }>
  | Readonly<{
      action: "reconnect";
      lastSuccessfulCheckAt: string | null;
      outcome?: GoogleOAuthOutcome;
      state: "authorization-expired" | "connected";
      verifiedEmail: string;
    }>
  | Readonly<{
      action: "reconnect";
      outcome?: GoogleOAuthOutcome;
      state: "unavailable";
    }>;

export interface GoogleCalendarService {
  complete(
    sessionToken: string,
    query: Readonly<{
      code?: string;
      error?: string;
      state?: string;
    }>,
  ): Promise<void>;
  readState(sessionToken: string): Promise<GoogleConnectionState>;
  start(sessionToken: string): Promise<{ authorizationUrl: string }>;
}

type GoogleOAuthServiceOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  fetch?: typeof fetch;
  keyVersion: number;
  now?: () => Date;
  ownerEmail: string;
  publicAppBaseUrl: string;
  randomBytes?: (size: number) => Buffer;
  repository: GoogleOAuthRepository;
}>;

type TokenResponse = Readonly<{
  idToken: string;
  refreshToken: string;
  scopes: string[];
}>;

type JwtHeader = Readonly<{
  alg: "RS256";
  kid: string;
}>;

type JwtPayload = Readonly<{
  aud: string;
  email: string;
  email_verified: true;
  exp: number;
  iss: string;
  nonce: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJwtPart(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function sameDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function exactScopes(value: string): string[] | undefined {
  const actual = value.split(/\s+/).filter(Boolean);
  return (
    actual.length === googleOAuthScopes.length &&
      googleOAuthScopes.every((scope) => actual.includes(scope)) &&
      actual.every((scope) =>
        (googleOAuthScopes as readonly string[]).includes(scope),
      )
  )
    ? [...googleOAuthScopes]
    : undefined;
}

function isJwtHeader(value: Record<string, unknown>): value is JwtHeader {
  return value.alg === "RS256" && typeof value.kid === "string";
}

function isJwtPayload(value: Record<string, unknown>): value is JwtPayload {
  return (
    typeof value.aud === "string" &&
    typeof value.email === "string" &&
    value.email_verified === true &&
    typeof value.exp === "number" &&
    Number.isSafeInteger(value.exp) &&
    typeof value.iss === "string" &&
    typeof value.nonce === "string"
  );
}

export class GoogleOAuthService implements GoogleCalendarService {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #encryptionKey: Buffer;
  readonly #fetch: typeof fetch;
  readonly #keyVersion: number;
  readonly #now: () => Date;
  readonly #ownerEmail: string;
  readonly #publicAppBaseUrl: string;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #repository: GoogleOAuthRepository;

  constructor(options: GoogleOAuthServiceOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#encryptionKey = decodeGoogleEncryptionKey(options.encryptionKey);
    this.#fetch = options.fetch ?? fetch;
    this.#keyVersion = options.keyVersion;
    this.#now = options.now ?? (() => new Date());
    this.#ownerEmail = options.ownerEmail;
    this.#publicAppBaseUrl = options.publicAppBaseUrl;
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#repository = options.repository;
  }

  #sessionDigest(sessionToken: string): string {
    return digest(sessionToken);
  }

  #redirectUri(): string {
    return `${this.#publicAppBaseUrl}/api/google-calendar/callback`;
  }

  #expiresAt(): string {
    return new Date(this.#now().getTime() + ATTEMPT_LIFETIME_MS).toISOString();
  }

  async start(
    sessionToken: string,
  ): Promise<{ authorizationUrl: string }> {
    const current = await this.#repository.readConnection();
    const intent: GoogleOAuthIntent = current ? "reconnect" : "connect";
    const state = randomOpaqueValue(32, this.#randomBytes);
    const nonce = randomOpaqueValue(32, this.#randomBytes);
    const verifier = randomOpaqueValue(64, this.#randomBytes);
    const encryptedVerifier = encryptSecret({
      email: this.#ownerEmail,
      key: this.#encryptionKey,
      keyVersion: this.#keyVersion,
      ownerReference: OWNER_REFERENCE,
      plaintext: verifier,
      purpose: "pkce_verifier",
      randomBytes: this.#randomBytes,
    });

    await this.#repository.createAttempt({
      encryptedVerifier,
      expiresAt: this.#expiresAt(),
      intent,
      nonceDigest: digest(nonce),
      sessionDigest: this.#sessionDigest(sessionToken),
      stateDigest: digest(state),
    });

    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      access_type: "offline",
      client_id: this.#clientId,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      nonce,
      prompt: "consent",
      redirect_uri: this.#redirectUri(),
      response_type: "code",
      scope: googleOAuthScopes.join(" "),
      state,
    }).toString();

    return { authorizationUrl: url.toString() };
  }

  async #storeOutcome(
    sessionDigest: string,
    outcome: GoogleOAuthOutcome,
  ): Promise<void> {
    await this.#repository.storeOutcome(
      sessionDigest,
      outcome,
      this.#expiresAt(),
    );
  }

  async complete(
    sessionToken: string,
    query: Readonly<{
      code?: string;
      error?: string;
      state?: string;
    }>,
  ): Promise<void> {
    const sessionDigest = this.#sessionDigest(sessionToken);
    if (!query.state) {
      await this.#storeOutcome(sessionDigest, "invalid_state");
      return;
    }

    const attempt = await this.#repository.claimAttempt(
      digest(query.state),
      sessionDigest,
    );
    if (!attempt) {
      await this.#storeOutcome(sessionDigest, "invalid_state");
      return;
    }
    if (query.error) {
      await this.#storeOutcome(sessionDigest, "denied");
      return;
    }
    if (!query.code) {
      await this.#storeOutcome(sessionDigest, "failed");
      return;
    }

    try {
      const verifier = decryptSecret(attempt.encryptedVerifier, {
        email: this.#ownerEmail,
        key: this.#encryptionKey,
        keyVersion: this.#keyVersion,
        ownerReference: OWNER_REFERENCE,
        purpose: "pkce_verifier",
      });
      const tokens = await this.#exchange(query.code, verifier);
      const identity = await this.#verifyIdentity(
        tokens.idToken,
        attempt.nonceDigest,
      );
      if (identity.email !== this.#ownerEmail) {
        await this.#storeOutcome(sessionDigest, "identity_mismatch");
        return;
      }

      const encryptedRefreshToken = encryptSecret({
        email: identity.email,
        key: this.#encryptionKey,
        keyVersion: this.#keyVersion,
        ownerReference: OWNER_REFERENCE,
        plaintext: tokens.refreshToken,
        purpose: "refresh_token",
        randomBytes: this.#randomBytes,
      });
      await this.#repository.replaceConnection({
        calendarId: "primary",
        encryptedRefreshToken,
        verifiedEmail: identity.email,
      });
      await this.#storeOutcome(
        sessionDigest,
        attempt.intent === "connect" ? "connected" : "reconnected",
      );
    } catch {
      await this.#storeOutcome(sessionDigest, "failed");
    }
  }

  async #exchange(code: string, verifier: string): Promise<TokenResponse> {
    const response = await this.#fetch(TOKEN_URL, {
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: this.#redirectUri(),
      }).toString(),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error("Google OAuth exchange failed");
    }

    const body: unknown = await response.json();
    const record = asRecord(body);
    if (
      !record ||
      typeof record.id_token !== "string" ||
      typeof record.refresh_token !== "string" ||
      record.refresh_token.length === 0 ||
      typeof record.scope !== "string"
    ) {
      throw new Error("Google OAuth exchange returned invalid data");
    }
    const scopes = exactScopes(record.scope);
    if (!scopes) {
      throw new Error("Google OAuth exchange returned invalid scopes");
    }
    return {
      idToken: record.id_token,
      refreshToken: record.refresh_token,
      scopes,
    };
  }

  async #verifyIdentity(
    token: string,
    expectedNonceDigest: string,
  ): Promise<{ email: string }> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Google identity token is invalid");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseJwtPart(encodedHeader);
    const payload = parseJwtPart(encodedPayload);
    if (!header || !payload || !isJwtHeader(header) || !isJwtPayload(payload)) {
      throw new Error("Google identity token is invalid");
    }

    const response = await this.#fetch(JWKS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error("Google identity keys are unavailable");
    }
    const body: unknown = await response.json();
    const record = asRecord(body);
    const keys = Array.isArray(record?.keys) ? record.keys : [];
    const key = keys
      .map(asRecord)
      .find(
        (candidate) =>
          candidate?.kid === header.kid &&
          candidate.kty === "RSA" &&
          (candidate.alg === undefined || candidate.alg === "RS256") &&
          (candidate.use === undefined || candidate.use === "sig"),
      );
    if (!key) {
      throw new Error("Google identity key is unavailable");
    }

    let signatureIsValid = false;
    try {
      signatureIsValid = verify(
        "RSA-SHA256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ format: "jwk", key }),
        Buffer.from(encodedSignature, "base64url"),
      );
    } catch {
      throw new Error("Google identity signature is invalid");
    }
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (
      !signatureIsValid ||
      !["accounts.google.com", "https://accounts.google.com"].includes(
        payload.iss,
      ) ||
      payload.aud !== this.#clientId ||
      payload.exp <= nowSeconds ||
      !sameDigest(digest(payload.nonce), expectedNonceDigest)
    ) {
      throw new Error("Google identity claims are invalid");
    }

    return { email: payload.email };
  }

  async readState(sessionToken: string): Promise<GoogleConnectionState> {
    let connection: GoogleConnectionRecord | undefined;
    try {
      connection = await this.#repository.readConnection();
    } catch {
      return { action: "reconnect", state: "unavailable" };
    }

    let outcome: GoogleOAuthOutcome | undefined;
    try {
      outcome = await this.#repository.consumeOutcome(
        this.#sessionDigest(sessionToken),
      );
    } catch {
      outcome = undefined;
    }

    if (!connection) {
      return {
        action: "connect",
        ...(outcome ? { outcome } : {}),
        state: "disconnected",
      };
    }
    const state =
      connection.status === "authorization_expired" ||
      connection.keyVersion !== this.#keyVersion
        ? "authorization-expired"
        : "connected";
    return {
      action: "reconnect",
      lastSuccessfulCheckAt: connection.lastSuccessfulCheckAt,
      ...(outcome ? { outcome } : {}),
      state,
      verifiedEmail: connection.verifiedEmail,
    };
  }
}
