import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";

export interface TelegramUpdateHandler {
  handle(value: unknown): Promise<void>;
}

type TelegramWebhookOptions = {
  service: TelegramUpdateHandler;
  webhookSecret: string;
};

function matchesSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") {
    return false;
  }

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function registerTelegramWebhook(
  app: FastifyInstance,
  options: TelegramWebhookOptions,
): void {
  app.route<{ Body: unknown }>({
    handler: async (request, reply) => {
      try {
        await options.service.handle(request.body);
        return { ok: true };
      } catch (error) {
        request.log.error(
          {
            failureClass:
              error instanceof Error
                ? error.constructor.name
                : "UnknownTelegramFailure",
          },
          "Telegram update processing failed",
        );
        return reply.code(503).send({ ok: false });
      }
    },
    method: "POST",
    onRequest: async (request, reply) => {
      if (
        !matchesSecret(
          request.headers["x-telegram-bot-api-secret-token"],
          options.webhookSecret,
        )
      ) {
        return reply.code(401).send({ ok: false });
      }
    },
    url: "/api/telegram/webhook",
  });
}
