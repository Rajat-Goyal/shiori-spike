import { argon2Sync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type {
  AgentSdkSession,
  AgentSessionRepository,
} from "./agent/session.js";
import type { ServerConfig } from "./config.js";
import type { DashboardRepository, DashboardSummary } from "./dashboard.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
const testNow = new Date("2026-07-24T11:22:33.000Z");

function base64(value: Buffer): string {
  return value.toString("base64").replace(/=+$/, "");
}

function passwordHash(password: string): string {
  const salt = Buffer.from("shiori-test-salt");
  const hash = argon2Sync("argon2id", {
    memory: 1_024,
    message: password,
    nonce: salt,
    parallelism: 1,
    passes: 2,
    tagLength: 32,
  });
  return `$argon2id$v=19$m=1024,t=2,p=1$${base64(salt)}$${base64(hash)}`;
}

const testConfig: ServerConfig = {
  agentSessionRetentionSeconds: 2_592_000,
  dashboardPasswordHash: passwordHash("owner-password"),
  dashboardSessionSecret: Buffer.alloc(32, 7).toString("base64"),
  googleOAuthClientId: "google-test-client.apps.googleusercontent.com",
  googleOAuthClientSecret: "unit-test-google-client-secret",
  googleOwnerEmail: "owner@example.com",
  googleTokenEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
  googleTokenKeyVersion: 1,
  openaiApiKey: "unit-test-openai-key",
  openaiModel: "gpt-test-model",
  openaiPromptVersion: "shiori-test-v1",
  ownerTimeZone: "Asia/Singapore",
  publicAppBaseUrl: "http://localhost:3000",
  supabaseSecretKey: "unit-test-supabase-key",
  supabaseUrl: "http://127.0.0.1:54321",
  telegramBotToken: "unit-test-bot-token",
  telegramOwnerUserId: 123456789,
  telegramWebhookSecret: "unit-test-webhook-secret",
};

function repositoryReturning(summary: DashboardSummary): DashboardRepository {
  return {
    readSummary: vi.fn().mockResolvedValue(summary),
  };
}

const emptyDashboardSummary: DashboardSummary = {
  commitments: [],
  counts: { active: 0, dueToday: 0, overdue: 0 },
  events: [],
  sessionHistory: [],
  terminalCommitments: [],
  updatedAt: testNow.toISOString(),
};

async function appWith(
  dashboardRepository: DashboardRepository = repositoryReturning(
    emptyDashboardSummary,
  ),
) {
  const app = await buildApp({
    config: testConfig,
    dashboardRepository,
    now: () => testNow,
    serveStatic: false,
  });
  openApps.push(app);
  return app;
}

async function login(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    payload: { password: "owner-password" },
    url: "/api/owner/login",
  });
  const cookie = response.headers["set-cookie"];

  if (!cookie) {
    throw new Error("Owner login did not set a session cookie");
  }

  return cookie.split(";")[0];
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("API contracts", () => {
  it("returns pong from GET /api/ping", async () => {
    const app = await appWith();

    const response = await app.inject({ method: "GET", url: "/api/ping" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ message: "pong" });
  });

  it("returns ok from GET /api/health", async () => {
    const app = await appWith();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("refuses owner state without a valid session", async () => {
    const dashboardRepository = repositoryReturning(
      emptyDashboardSummary,
    );
    const app = await appWith(dashboardRepository);

    const [sessionResponse, summaryResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/api/owner/session" }),
      app.inject({ method: "GET", url: "/api/dashboard/summary" }),
    ]);

    expect(sessionResponse.statusCode).toBe(401);
    expect(sessionResponse.json()).toEqual({ error: "unauthenticated" });
    expect(summaryResponse.statusCode).toBe(401);
    expect(summaryResponse.json()).toEqual({ error: "unauthenticated" });
    expect(dashboardRepository.readSummary).not.toHaveBeenCalled();
  });

  it("allows only the authenticated owner to reset or forget conversation history", async () => {
    const reset = vi.fn<AgentSdkSession["reset"]>(async () => undefined);
    const session: AgentSdkSession = {
      addItems: vi.fn(async () => undefined),
      chatId: testConfig.telegramOwnerUserId,
      clearSession: vi.fn(async () => undefined),
      currentSnapshot: () => ({
        activeDraftId: null,
        chatId: testConfig.telegramOwnerUserId,
        compactionCheckpoint: null,
        expiresAt: new Date(0).toISOString(),
        firstWorkingSequence: null,
        id: "11111111-1111-4111-8111-111111111111",
        interaction: { callbackChoice: null, pendingQuestion: null },
        itemCount: 0,
        items: [],
        version: 0,
      }),
      getItems: vi.fn(async () => []),
      getSessionId: vi.fn(async () =>
        "11111111-1111-4111-8111-111111111111"
      ),
      popItem: vi.fn(async () => undefined),
      readHistory: vi.fn(async () => ({ items: [], nextCursor: null })),
      recordApplicationReply: vi.fn(async () => ({ kind: "stale" })),
      recordCallbackChoice: vi.fn(async () => ({ kind: "stale" })),
      reset,
      runCompaction: vi.fn(async () => null),
      sessionId: "11111111-1111-4111-8111-111111111111",
    };
    const agentSessions: AgentSessionRepository = {
      clear: vi.fn(async () => ({ kind: "none" })),
      open: vi.fn(async () => session),
      read: vi.fn(async () => ({ kind: "none" })),
    };
    const app = await buildApp({
      agentSessions,
      config: testConfig,
      now: () => testNow,
      serveStatic: false,
    });
    openApps.push(app);

    const unauthenticated = await app.inject({
      method: "POST",
      payload: { mode: "forget" },
      url: "/api/owner/conversation/reset",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(agentSessions.open).not.toHaveBeenCalled();

    const cookie = await login(app);
    const invalid = await app.inject({
      headers: { cookie },
      method: "POST",
      payload: { mode: "everything" },
      url: "/api/owner/conversation/reset",
    });
    expect(invalid.statusCode).toBe(400);

    const forgotten = await app.inject({
      headers: { cookie },
      method: "POST",
      payload: { mode: "forget" },
      url: "/api/owner/conversation/reset",
    });
    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.json()).toEqual({ reset: true });
    expect(reset).toHaveBeenCalledWith("forget");
  });

  it("admits only the configured Argon2id password with a bounded secure cookie", async () => {
    const app = await appWith();
    const invalidResponse = await app.inject({
      method: "POST",
      payload: { password: "wrong-password" },
      url: "/api/owner/login",
    });

    expect(invalidResponse.statusCode).toBe(401);
    expect(invalidResponse.json()).toEqual({ error: "invalid_password" });
    expect(invalidResponse.headers["set-cookie"]).toBeUndefined();

    const validResponse = await app.inject({
      method: "POST",
      payload: { password: "owner-password" },
      url: "/api/owner/login",
    });

    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.json()).toEqual({ authenticated: true });
    expect(validResponse.headers["set-cookie"]).toMatch(
      /^shiori_owner_session=.+; Path=\/; Max-Age=14400; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  it("rate-limits repeated invalid owner logins", async () => {
    const app = await appWith();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        headers: { "x-forwarded-for": `198.51.100.${attempt + 1}` },
        method: "POST",
        payload: { password: "wrong-password" },
        remoteAddress: `10.0.0.${attempt + 1}`,
        url: "/api/owner/login",
      });
      expect(response.statusCode).toBe(401);
    }

    const blockedResponse = await app.inject({
      headers: { "x-forwarded-for": "203.0.113.200" },
      method: "POST",
      payload: { password: "wrong-password" },
      remoteAddress: "10.0.1.200",
      url: "/api/owner/login",
    });

    expect(blockedResponse.statusCode).toBe(429);
    expect(blockedResponse.headers["retry-after"]).toBe("60");
    expect(blockedResponse.json()).toEqual({ error: "too_many_attempts" });

    const validWhileBlockedResponse = await app.inject({
      method: "POST",
      payload: { password: "owner-password" },
      remoteAddress: "10.0.2.201",
      url: "/api/owner/login",
    });

    expect(validWhileBlockedResponse.statusCode).toBe(429);
    expect(validWhileBlockedResponse.headers["set-cookie"]).toBeUndefined();
  });

  it("returns the live dashboard repository result only to an authenticated owner", async () => {
    const summary = emptyDashboardSummary;
    const dashboardRepository = repositoryReturning(summary);
    const app = await appWith(dashboardRepository);
    const cookie = await login(app);

    const sessionResponse = await app.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/owner/session",
    });
    const summaryResponse = await app.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/dashboard/summary",
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toEqual({ authenticated: true });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.json()).toEqual(summary);
    expect(dashboardRepository.readSummary).toHaveBeenCalledWith();
  });

  it("expires invalid owner sessions without reading the dashboard", async () => {
    const dashboardRepository = repositoryReturning(
      emptyDashboardSummary,
    );
    const app = await appWith(dashboardRepository);

    const response = await app.inject({
      headers: { cookie: "shiori_owner_session=invalid-session" },
      method: "GET",
      url: "/api/dashboard/summary",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "session_expired" });
    expect(dashboardRepository.readSummary).not.toHaveBeenCalled();
  });

  it("returns a redacted unavailable response when the live read fails", async () => {
    const dashboardRepository: DashboardRepository = {
      readSummary: vi.fn().mockRejectedValue(new Error("database detail")),
    };
    const app = await appWith(dashboardRepository);
    const cookie = await login(app);

    const response = await app.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/dashboard/summary",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "dashboard_unavailable" });
    expect(response.payload).not.toContain("database detail");
  });
});
