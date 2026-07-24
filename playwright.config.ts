import { defineConfig, devices } from "@playwright/test";
import { argon2Sync, randomBytes } from "node:crypto";

const externalBaseUrl = process.env.BASE_URL;
const testPassword = "playwright-owner-password";

function base64(value: Buffer): string {
  return value.toString("base64").replace(/=+$/, "");
}

function testPasswordHash(): string {
  const salt = randomBytes(16);
  const hash = argon2Sync("argon2id", {
    memory: 1_024,
    message: testPassword,
    nonce: salt,
    parallelism: 1,
    passes: 2,
    tagLength: 32,
  });
  return `$argon2id$v=19$m=1024,t=2,p=1$${base64(salt)}$${base64(hash)}`;
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "npm run build && npm start",
        env: {
          ...process.env,
          DASHBOARD_PASSWORD_HASH: testPasswordHash(),
          DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64"),
          GOOGLE_OAUTH_CLIENT_ID: "playwright-google-client",
          GOOGLE_OAUTH_CLIENT_SECRET: "playwright-google-secret",
          GOOGLE_OWNER_EMAIL: "owner@example.com",
          GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
          GOOGLE_TOKEN_KEY_VERSION: "1",
          NODE_ENV: "test",
          OPENAI_API_KEY: "playwright-openai-key",
          OPENAI_MODEL: "playwright-model",
          OPENAI_PROMPT_VERSION: "playwright-prompt-v1",
          OWNER_TIME_ZONE: "Asia/Singapore",
          PORT: "4173",
          PUBLIC_APP_BASE_URL: "http://127.0.0.1:4173",
          SUPABASE_SECRET_KEY: "playwright-supabase-key",
          SUPABASE_URL: "http://127.0.0.1:54321",
          TELEGRAM_BOT_TOKEN: "playwright-telegram-token",
          TELEGRAM_OWNER_USER_ID: "123456789",
          TELEGRAM_WEBHOOK_SECRET: "playwright_webhook_secret",
        },
        url: "http://127.0.0.1:4173/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
