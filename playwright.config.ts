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
        command: "npm start",
        env: {
          ...process.env,
          DASHBOARD_PASSWORD_HASH: testPasswordHash(),
          DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64"),
          NODE_ENV: "test",
          OWNER_TIME_ZONE: "Asia/Singapore",
          PORT: "4173",
          PUBLIC_APP_BASE_URL: "http://127.0.0.1:4173",
        },
        url: "http://127.0.0.1:4173/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
