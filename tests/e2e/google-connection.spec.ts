import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

const summary = {
  commitments: [],
  counts: {
    active: 0,
    dueToday: 0,
    overdue: 0,
  },
  updatedAt: "2026-07-24T10:34:56.000Z",
};

type ConnectionFixture =
  | {
      action: "connect";
      outcome?: string;
      state: "disconnected";
    }
  | {
      action: "reconnect";
      lastSuccessfulCheckAt: string | null;
      outcome?: string;
      state: "authorization-expired" | "connected";
      verifiedEmail: string;
    }
  | {
      action: "reconnect";
      lastSuccessfulCheckAt?: string | null;
      outcome?: string;
      state: "unavailable";
      verifiedEmail?: string;
    };

const providerRequests = new WeakMap<Page, string[]>();

async function openDashboard(page: Page, connection: ConnectionFixture) {
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/dashboard/summary", (route) =>
    route.fulfill({ json: summary }),
  );
  await page.route("**/api/google-calendar/connection", (route) =>
    route.fulfill({ json: connection }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Google Calendar" }),
  ).toBeVisible();
}

async function captureState(
  page: Page,
  testInfo: TestInfo,
  state: string,
) {
  if (process.env.CAPTURE_GOOGLE_CONNECTION_STATES === "1") {
    await page
      .locator(".calendar-panel")
      .screenshot({ path: testInfo.outputPath(`calendar-${state}.png`) });
  }
}

test.beforeEach(async ({ page }) => {
  const attemptedProviderRequests: string[] = [];
  providerRequests.set(page, attemptedProviderRequests);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.hostname === "accounts.google.com" ||
      url.hostname === "oauth2.googleapis.com" ||
      url.hostname === "www.googleapis.com"
    ) {
      attemptedProviderRequests.push(request.url());
    }
  });
  await page.route(
    /https:\/\/(?:accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com)\/.*/,
    (route) => route.abort("blockedbyclient"),
  );
});

test.afterEach(async ({ page }) => {
  expect(providerRequests.get(page)).toEqual([]);
});

test("renders the disconnected Calendar panel in the required dashboard position", async ({
  page,
}, testInfo) => {
  await openDashboard(page, {
    action: "connect",
    state: "disconnected",
  });

  const panel = page.locator(".calendar-panel");
  await expect(panel.getByText("Not connected", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(
      "Connect your primary calendar so Shiori can check when you’re free.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(panel.getByText("Read-only access", { exact: true })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Connect Google Calendar" }),
  ).toBeVisible();
  await expect(
    page.locator(".count-grid + .calendar-panel + .promise-panel"),
  ).toHaveCount(1);
  await captureState(page, testInfo, "disconnected");
});

test("renders the connected Calendar identity and semantic SGT check time", async ({
  page,
}, testInfo) => {
  await openDashboard(page, {
    action: "reconnect",
    lastSuccessfulCheckAt: "2026-07-24T10:11:12.000Z",
    state: "connected",
    verifiedEmail: "owner@example.com",
  });

  const panel = page.locator(".calendar-panel");
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Connected as owner@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Primary calendar · Read-only", { exact: true }),
  ).toBeVisible();
  const checkedAt = panel.locator("time");
  await expect(checkedAt).toHaveAttribute(
    "datetime",
    "2026-07-24T10:11:12.000Z",
  );
  await expect(checkedAt).toContainText(/18:11:12/);
  await expect(
    panel.getByRole("button", { name: "Reconnect Google Calendar" }),
  ).toBeVisible();
  await captureState(page, testInfo, "connected");
});

test("renders authorization-expired state while preserving known metadata", async ({
  page,
}, testInfo) => {
  await openDashboard(page, {
    action: "reconnect",
    lastSuccessfulCheckAt: null,
    state: "authorization-expired",
    verifiedEmail: "owner@example.com",
  });

  const panel = page.locator(".calendar-panel");
  await expect(
    panel.getByText("Authorization expired", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "Google Calendar needs to be reconnected. Your promises and reminders still work.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel.getByText("Connected as owner@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("Calendar not checked yet", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Reconnect Google Calendar" }),
  ).toBeVisible();
  await captureState(page, testInfo, "authorization-expired");
});

test("renders unavailable state without hiding known Calendar metadata", async ({
  page,
}, testInfo) => {
  await openDashboard(page, {
    action: "reconnect",
    lastSuccessfulCheckAt: "2026-07-24T09:01:02.000Z",
    state: "unavailable",
    verifiedEmail: "owner@example.com",
  });

  const panel = page.locator(".calendar-panel");
  await expect(
    panel.getByText("Temporarily unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText(
      "Google Calendar can’t be reached right now. Your promises and reminders still work.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel.getByText("Connected as owner@example.com", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator("time")).toContainText(/17:01:02/);
  await expect(
    panel.getByRole("button", { name: "Reconnect Google Calendar" }),
  ).toBeVisible();
  await captureState(page, testInfo, "unavailable");
});

test("announces the initiating state before any Google navigation", async ({
  page,
}) => {
  await openDashboard(page, {
    action: "connect",
    state: "disconnected",
  });
  let connectRoute: Route | undefined;
  let releaseConnect: (() => void) | undefined;
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  await page.route("**/api/google-calendar/connect", async (route) => {
    connectRoute = route;
    await connectGate;
    await route.fulfill({
      json: { error: "controlled_test_completion" },
      status: 503,
    });
  });

  await page
    .getByRole("button", { name: "Connect Google Calendar" })
    .click();
  const panel = page.locator(".calendar-panel");
  await expect(panel).toHaveAttribute("aria-busy", "true");
  await expect(panel.getByText("Connecting", { exact: true })).toBeVisible();
  await expect(
    panel.getByText(
      "Redirecting to Google… You’ll return here when you’re done.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Opening Google…" }),
  ).toBeDisabled();

  expect(connectRoute).toBeDefined();
  releaseConnect?.();
});

test("shows a focused local start failure and preserves the prior connection", async ({
  page,
}) => {
  await openDashboard(page, {
    action: "reconnect",
    lastSuccessfulCheckAt: null,
    state: "connected",
    verifiedEmail: "owner@example.com",
  });
  await page.route("**/api/google-calendar/connect", (route) =>
    route.fulfill({ json: { error: "unavailable" }, status: 503 }),
  );

  await page
    .getByRole("button", { name: "Reconnect Google Calendar" })
    .click();
  const notice = page.getByRole("alert");
  await expect(notice).toHaveText(
    "We couldn’t start the Google Calendar connection. Try again.",
  );
  await expect(notice).toBeFocused();
  await expect(
    page.getByText("Connected as owner@example.com", { exact: true }),
  ).toBeVisible();
});

for (const [outcome, copy] of [
  ["connected", "Google Calendar connected."],
  ["reconnected", "Google Calendar reconnected."],
  [
    "invalid_state",
    "We couldn’t verify that Google connection attempt. Start again from this dashboard.",
  ],
  [
    "identity_mismatch",
    "That Google account doesn’t match the configured owner. Choose the configured account and try again.",
  ],
  [
    "denied",
    "Google Calendar wasn’t connected. Try again when you’re ready.",
  ],
  [
    "failed",
    "Google Calendar wasn’t connected. Try again when you’re ready.",
  ],
] as const) {
  test(`announces the one-time ${outcome} callback outcome`, async ({
    page,
  }) => {
    await openDashboard(page, {
      action: "connect",
      outcome,
      state: "disconnected",
    });
    const notice = page.getByRole("alert");
    await expect(notice).toHaveText(copy);
    await expect(notice).toBeFocused();
    await expect(page).toHaveURL("/");
  });
}

test("stacks the Calendar action on mobile and keeps it at least 44px tall", async ({
  page,
}) => {
  await openDashboard(page, {
    action: "connect",
    state: "disconnected",
  });
  const content = await page
    .locator(".calendar-panel__content")
    .boundingBox();
  const copy = await page.locator(".calendar-panel__copy").boundingBox();
  const action = await page.locator(".calendar-action").boundingBox();

  expect(content).not.toBeNull();
  expect(copy).not.toBeNull();
  expect(action).not.toBeNull();
  expect(action!.height).toBeGreaterThanOrEqual(44);
  if (page.viewportSize()!.width <= 680) {
    expect(action!.y).toBeGreaterThan(copy!.y + copy!.height);
    expect(action!.x).toBeCloseTo(content!.x, 0);
    expect(action!.width).toBeCloseTo(content!.width, 0);
  }
});
