import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  LogController,
} from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  type DashboardRepository,
  SupabaseDashboardRepository,
} from "./dashboard.js";
import { OpenAIDecisionEngine } from "./decision/engine.js";
import {
  ConfirmationService,
  SupabaseConfirmationRepository,
} from "./confirmation.js";
import {
  SimpleCommitmentActionService,
  SupabaseSimpleCommitmentActionRepository,
} from "./commitments/simple-action.js";
import { SupabaseConversationRepository } from "./conversation/repository.js";
import { ConversationService } from "./conversation/service.js";
import {
  type GoogleCalendarService,
  GoogleOAuthService,
} from "./google/oauth.js";
import { GoogleCalendarAdapter } from "./google/calendar.js";
import { SupabaseGoogleOAuthRepository } from "./google/repository.js";
import { GoogleRefreshTokenProvider } from "./google/token-provider.js";
import {
  createPasswordVerifier,
  LoginRateLimiter,
  ownerSession,
  readCookie,
} from "./owner-auth.js";
import {
  SimpleReminderScheduler,
  SupabaseSimpleReminderRepository,
} from "./scheduler/scheduler.js";
import { TelegramBotClient } from "./telegram/client.js";
import { SupabaseTelegramRepository } from "./telegram/repository.js";
import { TelegramService } from "./telegram/service.js";
import {
  StatusService,
  SupabaseStatusRepository,
} from "./telegram/status-cancel.js";
import {
  SupabaseWorkSessionMessageRepository,
  WorkSessionNotificationScheduler,
} from "./work-sessions/notifications.js";
import {
  SupabaseWorkSessionOutcomeRepository,
  WorkSessionOutcomeService,
} from "./work-sessions/outcomes.js";
import {
  checkCalendarAvailability,
} from "./work-sessions/availability-integration.js";
import { SupabaseWorkSessionCommitter } from "./work-sessions/confirm.js";
import { SupabaseWorkSessionContinuationRepository, WorkSessionContinuationService } from "./work-sessions/continuation.js";
import { WorkSessionFlow } from "./work-sessions/flow.js";
import { SupabaseWorkSessionFlowRepository } from "./work-sessions/flow-repository.js";
import {
  registerTelegramWebhook,
  type TelegramUpdateHandler,
} from "./telegram/webhook.js";

export type AppOptions = {
  config: ServerConfig;
  dashboardRepository?: DashboardRepository;
  googleCalendarService?: GoogleCalendarService;
  logger?: FastifyServerOptions["logger"];
  now?: () => Date;
  serveStatic?: boolean;
  simpleReminderScheduler?: {
    start(): void;
    stop(): Promise<void>;
  };
  workSessionNotificationScheduler?: {
    start(): void;
    stop(): Promise<void>;
  };
  telegramService?: TelegramUpdateHandler;
  webRoot?: string;
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = path.resolve(currentDirectory, "../../web/dist");

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? false,
  });
  const now = options.now ?? (() => new Date());
  const verifyPassword = createPasswordVerifier(options.config.dashboardPasswordHash);
  const rateLimiter = new LoginRateLimiter();
  const dashboardRepository =
    options.dashboardRepository ??
    new SupabaseDashboardRepository({
      now,
      ownerTimeZone: options.config.ownerTimeZone,
      supabaseSecretKey: options.config.supabaseSecretKey,
      supabaseUrl: options.config.supabaseUrl,
    });
  const googleRepository = new SupabaseGoogleOAuthRepository({
    supabaseSecretKey: options.config.supabaseSecretKey,
    supabaseUrl: options.config.supabaseUrl,
  });
  const googleCalendarService =
    options.googleCalendarService ??
    new GoogleOAuthService({
      clientId: options.config.googleOAuthClientId,
      clientSecret: options.config.googleOAuthClientSecret,
      encryptionKey: options.config.googleTokenEncryptionKey,
      keyVersion: options.config.googleTokenKeyVersion,
      now,
      ownerEmail: options.config.googleOwnerEmail,
      publicAppBaseUrl: options.config.publicAppBaseUrl,
      repository: googleRepository,
    });
  const calendar = new GoogleCalendarAdapter({
    now,
    tokenProvider: new GoogleRefreshTokenProvider({
      clientId: options.config.googleOAuthClientId,
      clientSecret: options.config.googleOAuthClientSecret,
      encryptionKey: options.config.googleTokenEncryptionKey,
      keyVersion: options.config.googleTokenKeyVersion,
      ownerEmail: options.config.googleOwnerEmail,
      repository: googleRepository,
    }),
  });
  const workSessionAvailability = (
    request: Parameters<typeof checkCalendarAvailability>[0],
  ) => checkCalendarAvailability(request, calendar);
  const telegramClient = new TelegramBotClient({
    botToken: options.config.telegramBotToken,
  });
  const workSessionFlow = new WorkSessionFlow({
    availability: workSessionAvailability,
    committer: new SupabaseWorkSessionCommitter({
      ownerId: options.config.telegramOwnerUserId,
      supabaseSecretKey: options.config.supabaseSecretKey,
      supabaseUrl: options.config.supabaseUrl,
    }),
    now,
    repository: new SupabaseWorkSessionFlowRepository({
      ownerId: options.config.telegramOwnerUserId,
      supabaseSecretKey: options.config.supabaseSecretKey,
      supabaseUrl: options.config.supabaseUrl,
    }),
  });
  const workSessionOutcomeService = new WorkSessionOutcomeService({
    repository: new SupabaseWorkSessionOutcomeRepository({
      ownerId: options.config.telegramOwnerUserId,
      supabaseSecretKey: options.config.supabaseSecretKey,
      supabaseUrl: options.config.supabaseUrl,
    }),
  });
  const workSessionContinuationService =
    new WorkSessionContinuationService({
      availability: workSessionAvailability,
      now,
      repository: new SupabaseWorkSessionContinuationRepository({
        ownerId: options.config.telegramOwnerUserId,
        supabaseSecretKey: options.config.supabaseSecretKey,
        supabaseUrl: options.config.supabaseUrl,
      }),
    });
  const telegramService =
    options.telegramService ??
    new TelegramService({
      client: telegramClient,
      confirmationService: new ConfirmationService({
        repository: new SupabaseConfirmationRepository({
          ownerId: options.config.telegramOwnerUserId,
          supabaseSecretKey: options.config.supabaseSecretKey,
          supabaseUrl: options.config.supabaseUrl,
        }),
      }),
      conversationService: new ConversationService({
        decisionEngine: new OpenAIDecisionEngine({
          apiKey: options.config.openaiApiKey,
          model: options.config.openaiModel,
          now,
          promptVersion: options.config.openaiPromptVersion,
        }),
        modelId: options.config.openaiModel,
        promptVersion: options.config.openaiPromptVersion,
        repository: new SupabaseConversationRepository({
          supabaseSecretKey: options.config.supabaseSecretKey,
          supabaseUrl: options.config.supabaseUrl,
        }),
      }),
      ownerUserId: options.config.telegramOwnerUserId,
      repository: new SupabaseTelegramRepository({
        supabaseSecretKey: options.config.supabaseSecretKey,
        supabaseUrl: options.config.supabaseUrl,
      }),
      simpleCommitmentActionService: new SimpleCommitmentActionService({
        repository: new SupabaseSimpleCommitmentActionRepository({
          ownerId: options.config.telegramOwnerUserId,
          supabaseSecretKey: options.config.supabaseSecretKey,
          supabaseUrl: options.config.supabaseUrl,
        }),
      }),
      statusService: new StatusService({
        now,
        repository: new SupabaseStatusRepository({
          ownerId: options.config.telegramOwnerUserId,
          supabaseSecretKey: options.config.supabaseSecretKey,
          supabaseUrl: options.config.supabaseUrl,
        }),
      }),
      workSessionActionService: {
        handle(updateId, chatId, callbackData) {
          const prefix =
            typeof callbackData === "string"
              ? callbackData.slice(0, 2)
              : "";
          if (prefix === "s:") {
            return workSessionOutcomeService.handle(
              updateId,
              chatId,
              callbackData,
            );
          }
          if (prefix === "c:") {
            return workSessionContinuationService.handle(
              updateId,
              chatId,
              callbackData,
            );
          }
          return workSessionFlow.handle(
            updateId,
            chatId,
            callbackData,
          );
        },
      },
    });
  const simpleReminderScheduler =
    options.simpleReminderScheduler ??
    new SimpleReminderScheduler({
      client: telegramClient,
      now,
      repository: new SupabaseSimpleReminderRepository({
        supabaseSecretKey: options.config.supabaseSecretKey,
        supabaseUrl: options.config.supabaseUrl,
      }),
    });
  const workSessionNotificationScheduler =
    options.workSessionNotificationScheduler ??
    new WorkSessionNotificationScheduler({
      client: telegramClient,
      now,
      repository: new SupabaseWorkSessionMessageRepository({
        supabaseSecretKey: options.config.supabaseSecretKey,
        supabaseUrl: options.config.supabaseUrl,
      }),
    });

  function sessionToken(cookieHeader: string | undefined): string | undefined {
    return readCookie(cookieHeader, ownerSession.cookieName);
  }

  function isAuthenticated(cookieHeader: string | undefined): boolean {
    return ownerSession.verify(
      sessionToken(cookieHeader),
      options.config.dashboardSessionSecret,
      now(),
    );
  }

  function unauthorizedError(cookieHeader: string | undefined): {
    error: "session_expired" | "unauthenticated";
  } {
    return {
      error: sessionToken(cookieHeader) ? "session_expired" : "unauthenticated",
    };
  }

  app.get("/api/ping", async () => ({ message: "pong" }));
  app.get("/api/health", async () => ({ status: "ok" }));
  registerTelegramWebhook(app, {
    service: telegramService,
    webhookSecret: options.config.telegramWebhookSecret,
  });
  app.addHook("onReady", async () => {
    simpleReminderScheduler.start();
    workSessionNotificationScheduler.start();
  });
  app.addHook("onClose", async () => {
    await Promise.all([
      simpleReminderScheduler.stop(),
      workSessionNotificationScheduler.stop(),
    ]);
  });

  app.post<{ Body: { password?: unknown } }>("/api/owner/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (rateLimiter.isBlocked(request.ip, now())) {
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({ error: "too_many_attempts" });
    }

    const password = request.body?.password;
    if (
      typeof password !== "string" ||
      password.length === 0 ||
      password.length > 1_024 ||
      !verifyPassword(password)
    ) {
      rateLimiter.recordFailure(request.ip, now());
      return reply.code(401).send({ error: "invalid_password" });
    }

    rateLimiter.clear(request.ip);
    const token = ownerSession.issue(options.config.dashboardSessionSecret, now());

    return reply
      .header(
        "Set-Cookie",
        `${ownerSession.cookieName}=${token}; Path=/; Max-Age=${ownerSession.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`,
      )
      .send({ authenticated: true });
  });

  app.get("/api/owner/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (!isAuthenticated(request.headers.cookie)) {
      return reply.code(401).send(unauthorizedError(request.headers.cookie));
    }

    return { authenticated: true };
  });

  app.post("/api/owner/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (!isAuthenticated(request.headers.cookie)) {
      return reply.code(401).send(unauthorizedError(request.headers.cookie));
    }

    return reply
      .header(
        "Set-Cookie",
        `${ownerSession.cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      )
      .send({ authenticated: false });
  });

  app.post("/api/google-calendar/connect", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = sessionToken(request.headers.cookie);
    if (
      !token ||
      !ownerSession.verify(
        token,
        options.config.dashboardSessionSecret,
        now(),
      )
    ) {
      return reply.code(401).send(unauthorizedError(request.headers.cookie));
    }

    try {
      return await googleCalendarService.start(token);
    } catch (error) {
      request.log.error(
        {
          failureClass:
            error instanceof Error
              ? error.constructor.name
              : "UnknownGoogleOAuthFailure",
        },
        "Google OAuth start failed",
      );
      return reply.code(503).send({ error: "google_oauth_unavailable" });
    }
  });

  app.get<{
    Querystring: {
      code?: string;
      error?: string;
      state?: string;
    };
  }>("/api/google-calendar/callback", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    const cleanDashboardUrl = `${options.config.publicAppBaseUrl}/`;
    const token = sessionToken(request.headers.cookie);
    if (
      !token ||
      !ownerSession.verify(
        token,
        options.config.dashboardSessionSecret,
        now(),
      )
    ) {
      return reply.code(303).redirect(cleanDashboardUrl);
    }

    await googleCalendarService
      .complete(token, {
        code: request.query.code,
        error: request.query.error,
        state: request.query.state,
      })
      .catch(() => undefined);
    return reply.code(303).redirect(cleanDashboardUrl);
  });

  app.get("/api/google-calendar/connection", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const token = sessionToken(request.headers.cookie);
    if (
      !token ||
      !ownerSession.verify(
        token,
        options.config.dashboardSessionSecret,
        now(),
      )
    ) {
      return reply.code(401).send(unauthorizedError(request.headers.cookie));
    }

    try {
      return await googleCalendarService.readState(token);
    } catch {
      return {
        action: "reconnect",
        state: "unavailable",
      };
    }
  });

  app.get("/api/dashboard/summary", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (!isAuthenticated(request.headers.cookie)) {
      return reply.code(401).send(unauthorizedError(request.headers.cookie));
    }

    try {
      return await dashboardRepository.readSummary();
    } catch (error) {
      request.log.error(
        {
          failureClass:
            error instanceof Error ? error.constructor.name : "UnknownDashboardFailure",
        },
        "dashboard summary read failed",
      );
      return reply.code(503).send({ error: "dashboard_unavailable" });
    }
  });

  if (options.serveStatic ?? true) {
    const webRoot = options.webRoot ?? defaultWebRoot;

    try {
      await access(path.join(webRoot, "index.html"));
    } catch {
      throw new Error(
        `The web build was not found at ${webRoot}. Run \"npm run build\" before starting the production server.`,
      );
    }

    await app.register(fastifyStatic, {
      root: webRoot,
      index: ["index.html"],
    });
  }

  return app;
}
