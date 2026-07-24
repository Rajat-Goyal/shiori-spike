import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./crypto.js";
import {
  googleOAuthScopes,
  type GoogleCalendarCredential,
  type GoogleCalendarCredentialRepository,
} from "./repository.js";
import { GoogleRefreshTokenProvider } from "./token-provider.js";

const KEY = Buffer.alloc(32, 7);
const KEY_BASE64 = KEY.toString("base64");
const OWNER_EMAIL = "owner@example.com";
const REFRESH_TOKEN = "private-refresh-token";

function encryptedCredential(
  overrides: Partial<GoogleCalendarCredential> = {},
): GoogleCalendarCredential {
  return {
    calendarId: "primary",
    encryptedRefreshToken: encryptSecret({
      email: OWNER_EMAIL,
      key: KEY,
      keyVersion: 1,
      ownerReference: "owner",
      plaintext: REFRESH_TOKEN,
      purpose: "refresh_token",
      randomBytes: () => Buffer.alloc(12, 5),
    }),
    scopes: googleOAuthScopes,
    status: "connected",
    verifiedEmail: OWNER_EMAIL,
    ...overrides,
  };
}

function controlled(
  options: Readonly<{
    credential?: GoogleCalendarCredential;
    fetch?: typeof fetch;
    readFailure?: boolean;
  }> = {},
) {
  const markAuthorizationExpired = vi.fn(async () => undefined);
  const readCredential = vi.fn(async () => {
    if (options.readFailure) {
      throw new Error("private database detail");
    }
    return options.credential;
  });
  const repository: GoogleCalendarCredentialRepository = {
    markAuthorizationExpired,
    readCredential,
  };
  const provider = new GoogleRefreshTokenProvider({
    clientId: "google-client-id",
    clientSecret: "google-client-secret",
    encryptionKey: KEY_BASE64,
    fetch: options.fetch,
    keyVersion: 1,
    ownerEmail: OWNER_EMAIL,
    repository,
  });
  return {
    markAuthorizationExpired,
    provider,
    readCredential,
  };
}

describe("GoogleRefreshTokenProvider", () => {
  it("decrypts only inside the provider and returns only the bounded access token", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("google-client-id");
      expect(body.get("client_secret")).toBe("google-client-secret");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
      return Response.json({
        access_token: "short-lived-access-token",
        expires_in: 3_600,
        token_type: "Bearer",
      });
    });
    const credential = encryptedCredential();
    const test = controlled({ credential, fetch: providerFetch });

    await expect(test.provider.getToken()).resolves.toEqual({
      accessToken: "short-lived-access-token",
      status: "ok",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(test.markAuthorizationExpired).not.toHaveBeenCalled();
    expect(JSON.stringify(credential)).not.toContain(REFRESH_TOKEN);
  });

  it("returns unavailable without provider access for a missing or unreadable connection", async () => {
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      controlled({ fetch: providerFetch }).provider.getToken(),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      controlled({
        fetch: providerFetch,
        readFailure: true,
      }).provider.getToken(),
    ).resolves.toEqual({ status: "unavailable" });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("returns authorization_expired without decrypting a connection already marked expired", async () => {
    const providerFetch = vi.fn<typeof fetch>();
    const test = controlled({
      credential: encryptedCredential({ status: "authorization_expired" }),
      fetch: providerFetch,
    });

    await expect(test.provider.getToken()).resolves.toEqual({
      status: "authorization_expired",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("marks invalid_grant once and returns authorization_expired without exposing provider detail", async () => {
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "sensitive provider explanation",
        },
        { status: 400 },
      )
    );
    const test = controlled({
      credential: encryptedCredential(),
      fetch: providerFetch,
    });

    await expect(test.provider.getToken()).resolves.toEqual({
      status: "authorization_expired",
    });
    expect(test.markAuthorizationExpired).toHaveBeenCalledOnce();
  });

  it("classifies transient and malformed token responses as provider_failure", async () => {
    const transient = controlled({
      credential: encryptedCredential(),
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error("private provider detail");
      }),
    });
    await expect(transient.provider.getToken()).resolves.toEqual({
      status: "provider_failure",
    });

    const malformed = controlled({
      credential: encryptedCredential(),
      fetch: vi.fn<typeof fetch>(async () =>
        Response.json({
          access_token: REFRESH_TOKEN,
          expires_in: 3_600,
          token_type: "not-bearer",
        })
      ),
    });
    await expect(malformed.provider.getToken()).resolves.toEqual({
      status: "provider_failure",
    });
  });

  it("rejects a mismatched owner or encryption context before provider access", async () => {
    const providerFetch = vi.fn<typeof fetch>();
    const wrongOwner = controlled({
      credential: encryptedCredential({
        verifiedEmail: "another@example.com",
      }),
      fetch: providerFetch,
    });
    await expect(wrongOwner.provider.getToken()).resolves.toEqual({
      status: "unavailable",
    });

    const wrongKeyVersion = controlled({
      credential: encryptedCredential({
        encryptedRefreshToken: {
          ...encryptedCredential().encryptedRefreshToken,
          keyVersion: 2,
        },
      }),
      fetch: providerFetch,
    });
    await expect(wrongKeyVersion.provider.getToken()).resolves.toEqual({
      status: "unavailable",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
