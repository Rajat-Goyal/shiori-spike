import { expect, test, type Page } from "@playwright/test";

const populatedSummary = {
  commitments: [
    {
      calendar: {
        attemptedAt: null,
        checkedAt: null,
        kind: "not_needed",
        label: "Calendar check not needed",
      },
      definitionOfDone: "Send the signed proposal to the client",
      deliveries: [
        {
          dueAt: "2026-07-26T01:30:00.000Z",
          kind: "simple_reminder",
          label: "Scheduled",
          state: "pending",
        },
      ],
      expectedDurationMinutes: null,
      id: "10000000-0000-4000-8000-000000000001",
      next: {
        at: "2026-07-26T01:30:00.000Z",
        kind: "simple_reminder",
        label: "Simple reminder",
      },
      status: "active",
      targetAt: "2026-07-26T02:00:00.000Z",
    },
    {
      calendar: {
        attemptedAt: "2026-07-25T02:00:00.000Z",
        checkedAt: null,
        kind: "unverified",
        label: "Saved without a Calendar check",
      },
      definitionOfDone: "Finish the launch retrospective",
      deliveries: [],
      expectedDurationMinutes: 60,
      id: "10000000-0000-4000-8000-000000000002",
      next: {
        at: "2026-07-26T03:00:00.000Z",
        kind: "work_session",
        label: "Work session starts",
      },
      status: "active",
      targetAt: "2026-07-27T10:00:00.000Z",
    },
  ],
  counts: {
    active: 2,
    dueToday: 1,
    overdue: 0,
  },
  events: [
    {
      actor: "owner",
      commitmentId: "10000000-0000-4000-8000-000000000001",
      definitionOfDone: "Send the signed proposal to the client",
      eventType: "commitment.created",
      id: "30000000-0000-4000-8000-000000000001",
      label: "Promise created",
      occurredAt: "2026-07-25T01:15:00.000Z",
    },
    {
      actor: "system",
      commitmentId: "10000000-0000-4000-8000-000000000003",
      definitionOfDone: "Publish the weekly update",
      eventType: "commitment.done",
      id: "30000000-0000-4000-8000-000000000002",
      label: "Promise completed",
      occurredAt: "2026-07-24T12:20:00.000Z",
    },
  ],
  sessionHistory: [
    {
      commitmentId: "10000000-0000-4000-8000-000000000002",
      definitionOfDone: "Finish the launch retrospective",
      sessions: [
        {
          durationMinutes: 30,
          endAt: "2026-07-25T03:30:00.000Z",
          id: "50000000-0000-4000-8000-000000000002",
          isRecovery: true,
          label: "More work needed",
          outcomeAt: "2026-07-25T03:31:00.000Z",
          sequenceNumber: 2,
          startAt: "2026-07-25T03:00:00.000Z",
          status: "more_work_needed",
        },
      ],
      truncated: true,
    },
  ],
  terminalCommitments: [
    {
      definitionOfDone: "Publish the weekly update",
      id: "10000000-0000-4000-8000-000000000003",
      label: "Completed",
      status: "done",
      targetAt: "2026-07-24T12:00:00.000Z",
      terminalAt: "2026-07-24T12:20:00.000Z",
    },
    {
      definitionOfDone: "Book the old venue",
      id: "10000000-0000-4000-8000-000000000004",
      label: "Cancelled",
      status: "cancelled",
      targetAt: "2026-07-23T08:00:00.000Z",
      terminalAt: "2026-07-22T06:00:00.000Z",
    },
  ],
  updatedAt: "2026-07-25T04:00:00.000Z",
};

async function openPopulatedDashboard(page: Page) {
  await page.route("**/api/owner/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/dashboard/summary", (route) =>
    route.fulfill({ json: populatedSummary }),
  );
  await page.route("**/api/google-calendar/connection", (route) =>
    route.fulfill({
      json: {
        action: "connect",
        state: "disconnected",
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Active promises" }),
  ).toBeVisible();
}

test("renders the complete populated dashboard responsively", async ({
  page,
}) => {
  await openPopulatedDashboard(page);

  await expect(page.locator(".count-card strong")).toHaveText(["2", "1", "0"]);
  await expect(
    page.getByRole("heading", {
      name: "Send the signed proposal to the client",
    }),
  ).toBeVisible();
  await expect(page.getByText("60 minutes", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Simple reminder", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Calendar check not needed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved without a Calendar check", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No reminder deliveries.")).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Session history" }),
  ).toBeVisible();
  await expect(page.getByText("Session 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Recovery", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Earlier sessions are not shown in this summary."),
  ).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Promise history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Publish the weekly update" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Book the old venue" }),
  ).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Recent activity" }),
  ).toBeVisible();
  await expect(page.getByText("Promise created", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Promise completed", { exact: true }),
  ).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const observations = page.locator(".observation-grid > section");
  const firstObservation = await observations.nth(0).boundingBox();
  const secondObservation = await observations.nth(1).boundingBox();
  expect(firstObservation).not.toBeNull();
  expect(secondObservation).not.toBeNull();
  if (viewport!.width <= 680) {
    expect(Math.abs(firstObservation!.x - secondObservation!.x)).toBeLessThan(2);
    expect(secondObservation!.y).toBeGreaterThan(
      firstObservation!.y + firstObservation!.height,
    );
  } else {
    expect(Math.abs(firstObservation!.y - secondObservation!.y)).toBeLessThan(2);
    expect(secondObservation!.x).toBeGreaterThan(
      firstObservation!.x + firstObservation!.width,
    );
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("keeps dashboard browser traffic and controls read-only", async ({
  page,
}) => {
  const requests: { method: string; url: string }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") || url.hostname.includes("supabase")) {
      requests.push({ method: request.method(), url: request.url() });
    }
  });

  await openPopulatedDashboard(page);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();

  expect(
    requests.filter(({ url }) => new URL(url).hostname.includes("supabase")),
  ).toEqual([]);
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  expect(
    requests.every(({ url }) =>
      [
        "/api/dashboard/summary",
        "/api/google-calendar/connection",
        "/api/owner/session",
      ].includes(new URL(url).pathname),
    ),
  ).toBe(true);
  await expect(page.getByRole("button")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Google Calendar", exact: true }),
  ).toBeVisible();
});
