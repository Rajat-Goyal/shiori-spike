import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppOptions } from "../app.js";
import type { ServerConfig } from "../config.js";
import { ownerSession } from "../owner-auth.js";
import { decryptSecret, digest, pkceChallenge } from "./crypto.js";
import { GoogleOAuthService } from "./oauth.js";
import {
  type ClaimedGoogleOAuthAttempt,
  type GoogleConnectionRecord,
  type GoogleOAuthAttempt,
  type GoogleOAuthOutcome,
  type GoogleOAuthRepository,
  googleOAuthScopes,
  type StoredGoogleConnection,
} from "./repository.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const sessionToken = "private-owner-session";
const clientId = "google-test-client.apps.googleusercontent.com";
const ownerEmail = "owner@example.com";
const encryptionKey = Buffer.alloc(32, 31);
const keyVersion = 2;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  alg: "RS256",
  kid: "unit-test-key",
  use: "sig",
};

class ControlledRepository implements GoogleOAuthRepository {
  readonly attempts = new Map<string, GoogleOAuthAttempt>();
  readonly outcomes = new Map<string, GoogleOAuthOutcome>();
  readonly replacements: StoredGoogleConnection[] = [];
  connection?: GoogleConnectionRecord;
  readFailure = false;

  async createAttempt(attempt: GoogleOAuthAttempt): Promise<void> {
    for (const [key, existing] of this.attempts) {
      if (existing.sessionDigest === attempt.sessionDigest) {
        this.attempts.delete(key);
      }
    }
    this.attempts.set(attempt.stateDigest, attempt);
  }

  async claimAttempt(
    stateDigest: string,
    sessionDigest: string,
  ): Promise<ClaimedGoogleOAuthAttempt | undefined> {
    const attempt = this.attempts.get(stateDigest);
    if (!attempt || attempt.sessionDigest !== sessionDigest) {
      return undefined;
    }
    this.attempts.delete(stateDigest);
    return {
      encryptedVerifier: attempt.encryptedVerifier,
      intent: attempt.intent,
      nonceDigest: attempt.nonceDigest,
    };
  }

  async storeOutcome(
    sessionDigest: string,
    outcome: GoogleOAuthOutcome,
  ): Promise<void> {
    this.outcomes.set(sessionDigest, outcome);
  }

  async consumeOutcome(
    sessionDigest: string,
  ): Promise<GoogleOAuthOutcome | undefined> {
    const outcome = this.outcomes.get(sessionDigest);
    this.outcomes.delete(sessionDigest);
    return outcome;
  }

  async replaceConnection(connection: StoredGoogleConnection): Promise<void> {
    this.replacements.push(connection);
    this.connection = {
      calendarId: connection.calendarId,
      keyVersion: connection.encryptedRefreshToken.keyVersion,
      lastSuccessfulCheckAt: null,
      scopes: googleOAuthScopes,
      status: "connected",
      verifiedEmail: connection.verifiedEmail,
    };
  }

  async readConnection(): Promise<GoogleConnectionRecord | undefined> {
    if (this.readFailure) {
      throw new Error("private persistence detail");
    }
    return this.connection;
  }
}

function jwt(
  nonce: string,
  changes: Record<string, unknown> = {},
  corruptSignature = false,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "unit-test-key", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: clientId,
      email: ownerEmail,
      email_verified: true,
      exp: Math.floor(now.getTime() / 1_000) + 600,
      iss: "https://accounts.google.com",
      nonce,
      sub: "synthetic-owner",
      ...changes,
    }),
  ).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  );
  if (corruptSignature) {
    signature[0] ^= 1;
  }
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

type Harness = {
  fetchFromGoogle: ReturnType<typeof vi.fn>;
  repository: ControlledRepository;
  service: GoogleOAuthService;
  setNonce(value: string): void;
  setTokenBody(value: Record<string, unknown>): void;
};

function harness(connection?: GoogleConnectionRecord): Harness {
  const repository = new ControlledRepository();
  repository.connection = connection;
  let nonce = "nonce-not-set";
  let tokenBody: Record<string, unknown> | undefined;
  let randomByte = 0;
  const fetchFromGoogle = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json(
        tokenBody ?? {
          id_token: jwt(nonce),
          refresh_token: "private-refresh-token",
          scope: googleOAuthScopes.join(" "),
        },
      );
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({ keys: [publicJwk] });
    }
    throw new Error("Unexpected controlled Google URL");
  });
  const service = new GoogleOAuthService({
    clientId,
    clientSecret: "private-google-client-secret",
    encryptionKey: encryptionKey.toString("base64"),
    fetch: fetchFromGoogle as typeof fetch,
    keyVersion,
    now: () => now,
    ownerEmail,
    publicAppBaseUrl: "http://localhost:3000",
    randomBytes: (size) => Buffer.alloc(size, ++randomByte),
    repository,
  });

  return {
    fetchFromGoogle,
    repository,
    service,
    setNonce(value) {
      nonce = value;
    },
    setTokenBody(value) {
      tokenBody = value;
    },
  };
}

async function begin(h: Harness) {
  const started = await h.service.start(sessionToken);
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get("state");
  const nonce = url.searchParams.get("nonce");
  if (!state || !nonce) {
    throw new Error("Controlled OAuth URL lacks state or nonce");
  }
  h.setNonce(nonce);
  return { state, url };
}

describe("GoogleOAuthService", () => {
  it("starts a session-bound one-use PKCE flow with exactly four scopes", async () => {
    const h = harness();
    const { state, url } = await begin(h);
    const [attempt] = h.repository.attempts.values();
    const verifier = decryptSecret(attempt.encryptedVerifier, {
      email: ownerEmail,
      key: encryptionKey,
      keyVersion,
      ownerReference: "owner",
      purpose: "pkce_verifier",
    });

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: "offline",
      client_id: clientId,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri:
        "http://localhost:3000/api/google-calendar/callback",
      response_type: "code",
      scope: googleOAuthScopes.join(" "),
      state,
    });
    expect(attempt).toMatchObject({
      intent: "connect",
      sessionDigest: digest(sessionToken),
      stateDigest: digest(state),
    });
    expect(attempt.nonceDigest).toBe(
      digest(String(url.searchParams.get("nonce"))),
    );
    expect(JSON.stringify(attempt)).not.toContain(sessionToken);
    expect(JSON.stringify(attempt)).not.toContain(verifier);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      googleOAuthScopes,
    );
  });

  it("validates identity and atomically stores one encrypted primary connection", async () => {
    const h = harness();
    const { state } = await begin(h);

    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state,
    });

    expect(h.repository.replacements).toHaveLength(1);
    const replacement = h.repository.replacements[0];
    expect(replacement).toMatchObject({
      calendarId: "primary",
      verifiedEmail: ownerEmail,
    });
    expect(replacement.encryptedRefreshToken.ciphertext).not.toContain(
      "private-refresh-token",
    );
    expect(
      decryptSecret(replacement.encryptedRefreshToken, {
        email: ownerEmail,
        key: encryptionKey,
        keyVersion,
        ownerReference: "owner",
        purpose: "refresh_token",
      }),
    ).toBe("private-refresh-token");
    expect(h.repository.outcomes.get(digest(sessionToken))).toBe("connected");

    const tokenRequest = h.fetchFromGoogle.mock.calls.find(
      ([url]) => String(url) === "https://oauth2.googleapis.com/token",
    );
    const tokenBody = new URLSearchParams(
      String(tokenRequest?.[1]?.body),
    );
    expect(tokenBody.get("code")).toBe("private-authorization-code");
    expect(tokenBody.get("client_secret")).toBe(
      "private-google-client-secret",
    );
    expect(tokenBody.get("code_verifier")).toBeTruthy();
  });

  it("claims state before denial and never exchanges or stores a connection", async () => {
    const h = harness();
    const { state } = await begin(h);

    await h.service.complete(sessionToken, {
      error: "access_denied",
      state,
    });

    expect(h.repository.attempts).toHaveLength(0);
    expect(h.fetchFromGoogle).not.toHaveBeenCalled();
    expect(h.repository.replacements).toHaveLength(0);
    expect(h.repository.outcomes.get(digest(sessionToken))).toBe("denied");
  });

  it("rejects invalid or replayed state before provider exchange", async () => {
    const h = harness();

    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state: "invalid-state",
    });

    expect(h.fetchFromGoogle).not.toHaveBeenCalled();
    expect(h.repository.replacements).toHaveLength(0);
    expect(h.repository.outcomes.get(digest(sessionToken))).toBe(
      "invalid_state",
    );

    const started = await begin(h);
    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state: started.state,
    });
    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state: started.state,
    });
    expect(h.repository.replacements).toHaveLength(1);
    expect(
      h.fetchFromGoogle.mock.calls.filter(
        ([url]) => String(url) === "https://oauth2.googleapis.com/token",
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      changes: { iss: "https://issuer.example.com" },
      label: "issuer",
    },
    {
      changes: { aud: "different-client" },
      label: "audience",
    },
    {
      changes: { exp: Math.floor(now.getTime() / 1_000) },
      label: "expiry",
    },
    {
      changes: { nonce: "different-nonce" },
      label: "nonce",
    },
    {
      changes: { email_verified: false },
      label: "email verification",
    },
  ])("preserves an existing connection for invalid $label", async ({ changes }) => {
    const existing: GoogleConnectionRecord = {
      calendarId: "primary",
      keyVersion,
      lastSuccessfulCheckAt: null,
      scopes: googleOAuthScopes,
      status: "connected",
      verifiedEmail: ownerEmail,
    };
    const h = harness(existing);
    const started = await begin(h);
    h.setTokenBody({
      id_token: jwt(
        String(started.url.searchParams.get("nonce")),
        changes,
      ),
      refresh_token: "private-refresh-token",
      scope: googleOAuthScopes.join(" "),
    });

    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state: started.state,
    });

    expect(h.repository.replacements).toHaveLength(0);
    expect(h.repository.connection).toEqual(existing);
    expect(h.repository.outcomes.get(digest(sessionToken))).toBe("failed");
  });

  it("separately reports the exact configured-email mismatch", async () => {
    const h = harness();
    const started = await begin(h);
    h.setTokenBody({
      id_token: jwt(String(started.url.searchParams.get("nonce")), {
        email: "other@example.com",
      }),
      refresh_token: "private-refresh-token",
      scope: googleOAuthScopes.join(" "),
    });

    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state: started.state,
    });

    expect(h.repository.replacements).toHaveLength(0);
    expect(h.repository.outcomes.get(digest(sessionToken))).toBe(
      "identity_mismatch",
    );
  });

  it("rejects a bad ID-token signature, missing refresh token, or extra scope", async () => {
    for (const tokenBody of [
      (nonce: string) => ({
        id_token: jwt(nonce, {}, true),
        refresh_token: "private-refresh-token",
        scope: googleOAuthScopes.join(" "),
      }),
      (nonce: string) => ({
        id_token: jwt(nonce),
        scope: googleOAuthScopes.join(" "),
      }),
      (nonce: string) => ({
        id_token: jwt(nonce),
        refresh_token: "private-refresh-token",
        scope: `${googleOAuthScopes.join(" ")} profile`,
      }),
    ]) {
      const h = harness();
      const started = await begin(h);
      h.setTokenBody(
        tokenBody(String(started.url.searchParams.get("nonce"))),
      );

      await h.service.complete(sessionToken, {
        code: "private-authorization-code",
        state: started.state,
      });

      expect(h.repository.replacements).toHaveLength(0);
      expect(h.repository.outcomes.get(digest(sessionToken))).toBe("failed");
    }
  });

  it("uses reconnect intent and atomically preserves the old row on failure", async () => {
    const existing: GoogleConnectionRecord = {
      calendarId: "primary",
      keyVersion,
      lastSuccessfulCheckAt: "2026-07-24T11:00:00.000Z",
      scopes: googleOAuthScopes,
      status: "connected",
      verifiedEmail: ownerEmail,
    };
    const h = harness(existing);
    const started = await begin(h);
    expect([...h.repository.attempts.values()][0].intent).toBe("reconnect");
    h.setTokenBody({ error: "provider failure" });

    await h.service.complete(sessionToken, {
      code: "private-authorization-code",
      state: started.state,
    });

    expect(h.repository.connection).toEqual(existing);
    expect(h.repository.replacements).toHaveLength(0);
  });

  it("maps disconnected, connected, unknown-key, and unavailable states without leaking secrets", async () => {
    const h = harness();
    h.repository.outcomes.set(digest(sessionToken), "connected");
    await expect(h.service.readState(sessionToken)).resolves.toEqual({
      action: "connect",
      outcome: "connected",
      state: "disconnected",
    });
    await expect(h.service.readState(sessionToken)).resolves.toEqual({
      action: "connect",
      state: "disconnected",
    });

    h.repository.connection = {
      calendarId: "primary",
      keyVersion,
      lastSuccessfulCheckAt: null,
      scopes: googleOAuthScopes,
      status: "connected",
      verifiedEmail: ownerEmail,
    };
    await expect(h.service.readState(sessionToken)).resolves.toMatchObject({
      action: "reconnect",
      state: "connected",
      verifiedEmail: ownerEmail,
    });

    h.repository.connection = {
      ...h.repository.connection,
      keyVersion: keyVersion + 1,
    };
    await expect(h.service.readState(sessionToken)).resolves.toMatchObject({
      action: "reconnect",
      state: "authorization-expired",
    });

    h.repository.readFailure = true;
    await expect(h.service.readState(sessionToken)).resolves.toEqual({
      action: "reconnect",
      lastSuccessfulCheckAt: null,
      state: "unavailable",
      verifiedEmail: ownerEmail,
    });
  });
});

const routeConfig: ServerConfig = {
  dashboardPasswordHash:
    "$argon2id$v=19$m=65536,t=3,p=1$c2hpb3JpLXRlc3Qtc2FsdA$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ",
  dashboardSessionSecret: Buffer.alloc(32, 9).toString("base64"),
  googleOAuthClientId: clientId,
  googleOAuthClientSecret: "unit-test-google-client-secret",
  googleOwnerEmail: ownerEmail,
  googleTokenEncryptionKey: encryptionKey.toString("base64"),
  googleTokenKeyVersion: keyVersion,
  openaiApiKey: "unit-test-openai-key",
  openaiModel: "gpt-test-model",
  openaiPromptVersion: "shiori-test-v1",
  ownerTimeZone: "Asia/Singapore",
  publicAppBaseUrl: "http://localhost:3000",
  supabaseSecretKey: "unit-test-supabase-key",
  supabaseUrl: "http://127.0.0.1:54321",
  telegramBotToken: "unit-test-bot-token",
  telegramOwnerUserId: 123456789,
  telegramWebhookSecret: "unit-test-webhook-secret",
};

function ownerCookie(): string {
  return `${ownerSession.cookieName}=${ownerSession.issue(
    routeConfig.dashboardSessionSecret,
    now,
  )}`;
}

async function routeApp(
  service: GoogleCalendarService,
  logger: AppOptions["logger"] = false,
) {
  return buildApp({
    config: routeConfig,
    dashboardRepository: {
      readSummary: vi.fn().mockResolvedValue({
        commitments: [],
        counts: { active: 0, dueToday: 0, overdue: 0 },
        updatedAt: now.toISOString(),
      }),
    },
    googleCalendarService: service,
    logger,
    now: () => now,
    serveStatic: false,
  });
}

describe("Google OAuth HTTP boundary", () => {
  it("requires an owner session for start and connection state", async () => {
    const service: GoogleCalendarService = {
      complete: vi.fn(),
      readState: vi.fn(),
      start: vi.fn(),
    };
    const app = await routeApp(service);

    for (const request of [
      { method: "POST" as const, url: "/api/google-calendar/connect" },
      { method: "GET" as const, url: "/api/google-calendar/connection" },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
    expect(service.start).not.toHaveBeenCalled();
    expect(service.readState).not.toHaveBeenCalled();
    await app.close();
  });

  it("starts OAuth and reads state only through the authenticated server", async () => {
    const service: GoogleCalendarService = {
      complete: vi.fn(),
      readState: vi.fn().mockResolvedValue({
        action: "connect",
        state: "disconnected",
      }),
      start: vi.fn().mockResolvedValue({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
    };
    const app = await routeApp(service);
    const headers = { cookie: ownerCookie() };

    const started = await app.inject({
      headers,
      method: "POST",
      url: "/api/google-calendar/connect",
    });
    const state = await app.inject({
      headers,
      method: "GET",
      url: "/api/google-calendar/connection",
    });

    expect(started.json()).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    });
    expect(state.json()).toEqual({
      action: "connect",
      state: "disconnected",
    });
    expect(started.headers["cache-control"]).toBe("no-store");
    expect(state.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("consumes callback values server-side and redirects to a clean dashboard URL", async () => {
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      },
    });
    const complete = vi.fn().mockResolvedValue(undefined);
    const service: GoogleCalendarService = {
      complete,
      readState: vi.fn(),
      start: vi.fn(),
    };
    const app = await routeApp(service, { level: "info", stream });
    const privateCode = "private-authorization-code";
    const privateState = "private-oauth-state";

    const response = await app.inject({
      headers: { cookie: ownerCookie() },
      method: "GET",
      url: `/api/google-calendar/callback?code=${privateCode}&state=${privateState}`,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("http://localhost:3000/");
    expect(response.headers.location).not.toContain("?");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(complete).toHaveBeenCalledWith(
      expect.any(String),
      {
        code: privateCode,
        error: undefined,
        state: privateState,
      },
    );
    expect(logs).not.toContain(privateCode);
    expect(logs).not.toContain(privateState);
    await app.close();
  });

  it("keeps health available when the Calendar state is unavailable", async () => {
    const service: GoogleCalendarService = {
      complete: vi.fn(),
      readState: vi.fn().mockRejectedValue(new Error("private provider detail")),
      start: vi.fn(),
    };
    const app = await routeApp(service);

    const state = await app.inject({
      headers: { cookie: ownerCookie() },
      method: "GET",
      url: "/api/google-calendar/connection",
    });
    const health = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(state.json()).toEqual({
      action: "reconnect",
      state: "unavailable",
    });
    expect(health.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
