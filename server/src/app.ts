import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  type DashboardRepository,
  SupabaseDashboardRepository,
} from "./dashboard.js";
import {
  createPasswordVerifier,
  LoginRateLimiter,
  ownerSession,
  readCookie,
} from "./owner-auth.js";

export type AppOptions = {
  config: ServerConfig;
  dashboardRepository?: DashboardRepository;
  logger?: boolean;
  now?: () => Date;
  serveStatic?: boolean;
  webRoot?: string;
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = path.resolve(currentDirectory, "../../web/dist");

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
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
