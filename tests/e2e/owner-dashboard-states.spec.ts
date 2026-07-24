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

const retriedSummary = {
  ...firstSummary,
  updatedAt: "2026-07-24T10:35:18.000Z",
};

function contrastRatio(foreground: string, background: string): number {
  const rgb = (value: string) => {
    const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) {
      throw new Error(`Expected an RGB color, received ${value}`);
    }
    return channels;
  };
  const luminance = (channels: number[]) =>
    channels
      .map((channel) => channel / 255)
      .map((channel) =>
        channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      )
      .reduce(
        (total, channel, index) =>
          total + channel * [0.2126, 0.7152, 0.0722][index],
        0,
      );
  const values = [luminance(rgb(foreground)), luminance(rgb(background))];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

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

test("shows the private session check before loading owner data", async ({
  page,
}) => {
  await page.route("**/api/owner/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ json: { error: "unauthenticated" }, status: 401 });
  });

  await page.goto("/");
  await expect(page.getByText("Shiori · Private dashboard")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Opening your dashboard…" }),
  ).toBeVisible();
  await expect(page.getByText("Checking your private session.")).toBeVisible();
  await expect(page.locator(".count-card")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Open your dashboard" }),
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
    } else if (reads === 3) {
      await route.fulfill({
        json: { error: "dashboard_unavailable" },
        status: 503,
      });
    } else {
      await route.fulfill({ json: retriedSummary });
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
    page.getByRole("button", { name: "Refreshing…", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Refreshing live data…")).toBeVisible();
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
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("time")).toHaveAttribute(
    "datetime",
    retriedSummary.updatedAt,
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
    page.getByText("Your session ended. Enter your password to continue."),
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

test("keeps the approved card geometry, Manrope typography, and AA text contrast", async ({
  page,
}) => {
  await beginAtLogin(page);
  const viewport = page.viewportSize()!;
  const loginCard = await page.locator(".login-card").boundingBox();
  expect(loginCard).not.toBeNull();

  if (viewport.width <= 680) {
    expect(loginCard!.x).toBeCloseTo(14, 0);
    expect(loginCard!.width).toBeCloseTo(viewport.width - 28, 0);
  } else {
    expect(loginCard!.width).toBeGreaterThanOrEqual(720);
    expect(loginCard!.width).toBeLessThanOrEqual(800);
  }

  const typography = await page.locator("body").evaluate((element) => {
    return getComputedStyle(element).fontFamily;
  });
  expect(typography).toContain("Manrope");

  const buttonColors = await page
    .getByRole("button", { name: "Open dashboard" })
    .evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        background: styles.backgroundColor,
        foreground: styles.color,
      };
    });
  expect(
    contrastRatio(buttonColors.foreground, buttonColors.background),
  ).toBeGreaterThanOrEqual(4.5);

  await page.route("**/api/owner/login", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/dashboard/summary", (route) =>
    route.fulfill({ json: firstSummary }),
  );
  await page.getByLabel("Password").fill("password");
  await page.getByRole("button", { name: "Open dashboard" }).click();

  const timestampColors = await page.locator(".last-updated").evaluate((element) => {
    const styles = getComputedStyle(element);
    const frame = element.closest(".dashboard-frame");
    return {
      background: frame ? getComputedStyle(frame).backgroundColor : "",
      foreground: styles.color,
    };
  });
  expect(
    contrastRatio(timestampColors.foreground, timestampColors.background),
  ).toBeGreaterThanOrEqual(4.5);
});
