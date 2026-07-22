import { defineConfig, devices } from "@playwright/test";

const externalBaseUrl = process.env.BASE_URL;

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
          NODE_ENV: "test",
          PORT: "4173",
        },
        url: "http://127.0.0.1:4173/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
