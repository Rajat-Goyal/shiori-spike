import { expect, test, type Page } from "@playwright/test";

const firstSummary = {
  commitments: [],
  counts: {
    active: 0,
    dueToday: 0,
    overdue: 0,
  },
  updatedAt: "2026-07-24T10:34:56.000Z",
};

const refreshedSummary = {
  ...firstSummary,
  updatedAt: "2026-07-24T10:35:07.000Z",
};

async function beginAtLogin(page: Page) {
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ json: { error: "unauthenticated" }, status: 401 }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Open your dashboard" }),
  ).toBeVisible();
}

async function openEmptyDashboard(page: Page) {
  await beginAtLogin(page);
  await page.route("**/api/owner/login", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/dashboard/summary", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({ json: firstSummary });
  });

  await page.getByLabel("Password").fill("owner password");
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Loading live dashboard…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your promises" }),
  ).toBeVisible();
}

test("opens the live empty dashboard after owner login", async ({ page }) => {
  await beginAtLogin(page);
  let loginAttempts = 0;
  await page.route("**/api/owner/login", async (route) => {
    loginAttempts += 1;
    if (loginAttempts === 1) {
      await route.fulfill({ json: { error: "invalid_password" }, status: 401 });
    } else {
      await route.fulfill({ json: { authenticated: true } });
    }
  });
  await page.route("**/api/dashboard/summary", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({ json: firstSummary });
  });

  await expect(page.getByText("Shiori · Private dashboard")).toBeVisible();
  await expect(
    page.getByText("Enter the owner password to continue."),
  ).toBeVisible();
  await page.getByLabel("Password").fill("wrong");
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(
    page.getByText("That password wasn’t accepted. Try again."),
  ).toBeVisible();

  await page.getByLabel("Password").fill("right");
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Loading live dashboard…" }),
  ).toBeVisible();
  await expect(page.getByText("Reading the latest saved state.")).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Your promises" }),
  ).toBeVisible();
  await expect(page.getByText("Shiori · Owner dashboard")).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Due today", { exact: true })).toBeVisible();
  await expect(page.getByText("Overdue", { exact: true })).toBeVisible();
  await expect(page.locator(".count-card strong")).toHaveText(["0", "0", "0"]);
  await expect(
    page.getByRole("heading", { name: "No active promises" }),
  ).toBeVisible();
  await expect(
    page.getByText("Confirmed promises will appear here."),
  ).toBeVisible();

  const updatedAt = page.locator("time");
  await expect(updatedAt).toHaveAttribute("datetime", firstSummary.updatedAt);
  await expect(updatedAt).toContainText(/18:34:56/);
});

test("shows rate-limit and sign-in failure guidance", async ({ page }) => {
  await beginAtLogin(page);
  let responseStatus = 429;
  await page.route("**/api/owner/login", (route) =>
    route.fulfill({
      json:
        responseStatus === 429
          ? { error: "too_many_attempts" }
          : { error: "unavailable" },
      status: responseStatus,
    }),
  );

  await page.getByLabel("Password").fill("password");
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(
    page.getByText("Too many attempts. Wait a moment, then try again."),
  ).toBeVisible();

  responseStatus = 503;
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(
    page.getByText("We couldn’t sign you in. Try again."),
  ).toBeVisible();
});

test("shows a useful initial error when the live summary is unavailable", async ({
  page,
}) => {
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/dashboard/summary", (route) =>
    route.fulfill({ json: { error: "dashboard_unavailable" }, status: 503 }),
  );

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dashboard unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByText("We couldn’t load the live dashboard. Try again."),
  ).toBeVisible();
});

test("refreshes the API timestamp and preserves the last success on failure", async ({
  page,
}) => {
  await beginAtLogin(page);
  await page.route("**/api/owner/login", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  let reads = 0;
  await page.route("**/api/dashboard/summary", async (route) => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));

    if (reads === 1) {
      await route.fulfill({ json: firstSummary });
    } else if (reads === 2) {
      await route.fulfill({ json: refreshedSummary });
    } else {
      await route.fulfill({
        json: { error: "dashboard_unavailable" },
        status: 503,
      });
    }
  });

  await page.getByLabel("Password").fill("password");
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(page.locator("time")).toHaveAttribute(
    "datetime",
    firstSummary.updatedAt,
  );

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refreshing", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("time")).toHaveAttribute(
    "datetime",
    refreshedSummary.updatedAt,
  );
  await expect(page.locator("time")).toContainText(/18:35:07/);

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Couldn’t refresh. Showing the last successful update."),
  ).toBeVisible();
  await expect(page.locator("time")).toHaveAttribute(
    "datetime",
    refreshedSummary.updatedAt,
  );
});

test("returns to login with a notice when the owner session expires", async ({
  page,
}) => {
  await beginAtLogin(page);
  await page.route("**/api/owner/login", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  let reads = 0;
  await page.route("**/api/dashboard/summary", (route) => {
    reads += 1;
    return reads === 1
      ? route.fulfill({ json: firstSummary })
      : route.fulfill({ json: { error: "session_expired" }, status: 401 });
  });

  await page.getByLabel("Password").fill("password");
  await page.getByRole("button", { name: "Open dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Your promises" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Open your dashboard" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your session expired. Enter the owner password to continue."),
  ).toBeVisible();
});

test("uses three desktop count columns and stacked mobile count cards", async ({
  page,
}) => {
  await openEmptyDashboard(page);
  const cards = page.locator(".count-card");
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  const viewport = page.viewportSize();

  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(viewport).not.toBeNull();

  if (viewport!.width <= 680) {
    expect(Math.abs(first!.x - second!.x)).toBeLessThan(2);
    expect(second!.y).toBeGreaterThan(first!.y + first!.height);
  } else {
    expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
    expect(second!.x).toBeGreaterThan(first!.x + first!.width);
  }
});
