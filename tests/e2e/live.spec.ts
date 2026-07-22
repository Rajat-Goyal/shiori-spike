import { expect, test } from "@playwright/test";

test("serves the page and APIs from one working origin", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ping" }).click();
  await expect(page.getByRole("status")).toContainText("Pong");

  const healthResponse = await page.request.get("/api/health");
  expect(healthResponse.status()).toBe(200);
  await expect(healthResponse.json()).resolves.toEqual({ status: "ok" });
});
