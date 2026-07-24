import { expect, test } from "@playwright/test";

test("serves the public login shell and protected APIs from one working origin", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Open your dashboard" }),
  ).toBeVisible();

  const healthResponse = await page.request.get("/api/health");
  expect(healthResponse.status()).toBe(200);
  await expect(healthResponse.json()).resolves.toEqual({ status: "ok" });

  const protectedResponse = await page.request.get("/api/dashboard/summary");
  expect(protectedResponse.status()).toBe(401);
  await expect(protectedResponse.json()).resolves.toEqual({
    error: "unauthenticated",
  });
});
