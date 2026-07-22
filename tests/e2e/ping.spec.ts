import { expect, test } from "@playwright/test";

test("sends a ping and displays the server's pong response", async ({ page }) => {
  await page.route("**/api/ping", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({ json: { message: "pong" } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Send a tiny signal." })).toBeVisible();

  await page.getByRole("button", { name: "Ping" }).click();
  await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Pong");
});

test("shows a useful error when the ping request fails", async ({ page }) => {
  await page.route("**/api/ping", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Ping" }).click();

  await expect(page.getByRole("status")).toContainText("Ping failed. Please try again.");
});
