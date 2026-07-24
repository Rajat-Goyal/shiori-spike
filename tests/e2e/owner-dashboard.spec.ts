import { expect, test } from "@playwright/test";
import { loadEnvFile } from "node:process";

const ownerPassword = "playwright-owner-password";

test.beforeAll(() => {
  try {
    loadEnvFile(".env.local");
  } catch {
    throw new Error(
      "Live owner-dashboard E2E requires an ignored .env.local and Docker-local Supabase",
    );
  }

  const configuredUrl = process.env.SUPABASE_URL;
  if (!configuredUrl) {
    throw new Error(
      "Live owner-dashboard E2E requires the Docker-local Supabase API URL",
    );
  }

  const url = new URL(configuredUrl);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "54321"
  ) {
    throw new Error(
      "Live owner-dashboard E2E is restricted to Docker-local Supabase on port 54321",
    );
  }
});

test("real owner walking skeleton uses Fastify session and live local Supabase @live", async ({
  context,
  page,
}) => {
  const browserFetches: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "fetch") {
      browserFetches.push(request.url());
    }
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Open your dashboard" }),
  ).toBeVisible();

  const refused = await page.request.get("/api/dashboard/summary");
  expect(refused.status()).toBe(401);

  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Open dashboard" }).click();

  await expect(
    page.getByRole("heading", { name: "Your promises" }),
  ).toBeVisible();
  await expect(page.locator(".count-card strong")).toHaveText(["0", "0", "0"]);
  await expect(
    page.getByRole("heading", { name: "No active promises" }),
  ).toBeVisible();

  const cookies = await context.cookies();
  const ownerCookie = cookies.find(
    (cookie) => cookie.name === "shiori_owner_session",
  );
  expect(ownerCookie).toEqual(
    expect.objectContaining({
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
    }),
  );
  expect(ownerCookie!.expires).toBeGreaterThan(Date.now() / 1_000);
  expect(ownerCookie!.expires).toBeLessThan(Date.now() / 1_000 + 14_500);

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/owner/session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const body: unknown = await response.json();
    return {
      authenticated:
        Boolean(body) &&
        typeof body === "object" &&
        (body as Record<string, unknown>).authenticated === true,
      status: response.status,
    };
  });
  expect(session).toEqual({ authenticated: true, status: 200 });

  const timestamp = page.locator("time");
  const initialUpdatedAt = await timestamp.getAttribute("datetime");
  expect(initialUpdatedAt).toBeTruthy();
  await page.waitForTimeout(1_100);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(timestamp).not.toHaveAttribute("datetime", initialUpdatedAt!);

  const appOrigin = new URL(page.url()).origin;
  expect(browserFetches.length).toBeGreaterThanOrEqual(4);
  for (const requestUrl of browserFetches) {
    expect(new URL(requestUrl).origin).toBe(appOrigin);
    expect(requestUrl.toLowerCase()).not.toContain("supabase");
  }
});
