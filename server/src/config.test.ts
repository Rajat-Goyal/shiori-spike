import { describe, expect, it } from "vitest";
import { readServerConfig } from "./config.js";

const validEnvironment = {
  DASHBOARD_PASSWORD_HASH:
    "$argon2id$v=19$m=65536,t=3,p=1$c2hpb3JpLXRlc3Qtc2FsdA$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ",
  DASHBOARD_SESSION_SECRET: Buffer.alloc(32, 11).toString("base64"),
  GOOGLE_OAUTH_CLIENT_ID: "google-test-client.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "unit-test-google-client-secret",
  GOOGLE_OWNER_EMAIL: "owner@example.com",
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
  GOOGLE_TOKEN_KEY_VERSION: "1",
  OPENAI_API_KEY: "unit-test-openai-key",
  OPENAI_MODEL: "gpt-test-model",
  OPENAI_PROMPT_VERSION: "shiori-test-v1",
  OWNER_TIME_ZONE: "Asia/Singapore",
  PUBLIC_APP_BASE_URL: "http://localhost:3000",
  SUPABASE_SECRET_KEY: "sb_secret_test-only",
  SUPABASE_URL: "http://127.0.0.1:54321",
  TELEGRAM_BOT_TOKEN: "unit-test-bot-token",
  TELEGRAM_OWNER_USER_ID: "123456789",
  TELEGRAM_WEBHOOK_SECRET: "unit-test-webhook-secret",
};

describe("readServerConfig", () => {
  it("allows HTTP only for a loopback Supabase URL", () => {
    expect(readServerConfig(validEnvironment).supabaseUrl).toBe(
      "http://127.0.0.1:54321",
    );
    expect(() =>
      readServerConfig({
        ...validEnvironment,
        SUPABASE_URL: "http://database.example.com",
      }),
    ).toThrow("SUPABASE_URL must use HTTPS outside loopback");
    expect(
      readServerConfig({
        ...validEnvironment,
        SUPABASE_URL: "https://database.example.com",
      }).supabaseUrl,
    ).toBe("https://database.example.com");
  });

  it("requires an HTTPS-off-loopback origin for the public app", () => {
    expect(readServerConfig(validEnvironment).publicAppBaseUrl).toBe(
      "http://localhost:3000",
    );

    for (const publicAppBaseUrl of [
      "http://app.example.com",
      "https://app.example.com/path",
      "https://app.example.com/?query=value",
      "https://app.example.com/#fragment",
    ]) {
      expect(() =>
        readServerConfig({
          ...validEnvironment,
          PUBLIC_APP_BASE_URL: publicAppBaseUrl,
        }),
      ).toThrow(/PUBLIC_APP_BASE_URL/);
    }

    expect(
      readServerConfig({
        ...validEnvironment,
        PUBLIC_APP_BASE_URL: "https://app.example.com",
      }).publicAppBaseUrl,
    ).toBe("https://app.example.com");
  });

  it("requires a canonical base64 session secret containing at least 32 bytes", () => {
    for (const invalidSecret of [
      "not-base64",
      Buffer.alloc(31, 1).toString("base64"),
      `${Buffer.alloc(32, 1).toString("base64")}=`,
    ]) {
      expect(() =>
        readServerConfig({
          ...validEnvironment,
          DASHBOARD_SESSION_SECRET: invalidSecret,
        }),
      ).toThrow(/DASHBOARD_SESSION_SECRET/);
    }

    expect(readServerConfig(validEnvironment).dashboardSessionSecret).toBe(
      validEnvironment.DASHBOARD_SESSION_SECRET,
    );
  });

  it("validates Telegram owner and webhook boundary configuration", () => {
    expect(readServerConfig(validEnvironment)).toMatchObject({
      telegramBotToken: "unit-test-bot-token",
      telegramOwnerUserId: 123456789,
      telegramWebhookSecret: "unit-test-webhook-secret",
    });

    for (const environment of [
      { ...validEnvironment, TELEGRAM_OWNER_USER_ID: "not-numeric" },
      { ...validEnvironment, TELEGRAM_OWNER_USER_ID: "0" },
      { ...validEnvironment, TELEGRAM_WEBHOOK_SECRET: "has spaces" },
      { ...validEnvironment, TELEGRAM_WEBHOOK_SECRET: "x".repeat(257) },
    ]) {
      expect(() => readServerConfig(environment)).toThrow(
        /TELEGRAM_(OWNER_USER_ID|WEBHOOK_SECRET)/,
      );
    }
  });

  it("requires opaque OpenAI credentials and bounded identifiers", () => {
    expect(readServerConfig(validEnvironment)).toMatchObject({
      openaiApiKey: "unit-test-openai-key",
      openaiModel: "gpt-test-model",
      openaiPromptVersion: "shiori-test-v1",
    });

    for (const environment of [
      { ...validEnvironment, OPENAI_API_KEY: "<openai-api-key>" },
      { ...validEnvironment, OPENAI_MODEL: "has spaces" },
      { ...validEnvironment, OPENAI_PROMPT_VERSION: "x".repeat(129) },
    ]) {
      expect(() => readServerConfig(environment)).toThrow(/OPENAI_/);
    }
  });

  it("validates Google OAuth identity and token encryption configuration", () => {
    expect(readServerConfig(validEnvironment)).toMatchObject({
      googleOAuthClientId: "google-test-client.apps.googleusercontent.com",
      googleOAuthClientSecret: "unit-test-google-client-secret",
      googleOwnerEmail: "owner@example.com",
      googleTokenEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
      googleTokenKeyVersion: 1,
    });

    for (const environment of [
      { ...validEnvironment, GOOGLE_OAUTH_CLIENT_ID: "has spaces" },
      { ...validEnvironment, GOOGLE_OWNER_EMAIL: "not-an-email" },
      {
        ...validEnvironment,
        GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(31, 17).toString("base64"),
      },
      { ...validEnvironment, GOOGLE_TOKEN_ENCRYPTION_KEY: "not-base64" },
      { ...validEnvironment, GOOGLE_TOKEN_KEY_VERSION: "0" },
      { ...validEnvironment, GOOGLE_TOKEN_KEY_VERSION: "1.5" },
    ]) {
      expect(() => readServerConfig(environment)).toThrow(/GOOGLE_/);
    }
  });
});
