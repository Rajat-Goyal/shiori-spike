import { buildApp } from "./app.js";
import { readServerConfig } from "./config.js";
import { startLangfuseTracing } from "./observability/langfuse.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`PORT must be an integer between 1 and 65535; received ${process.env.PORT}.`);
}

const config = readServerConfig();

// Started before buildApp so the global agent trace provider already carries the
// Langfuse processor when the first agent run happens.
const tracing =
  config.langfuse === undefined
    ? undefined
    : startLangfuseTracing({
        environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? "development",
        publicKey: config.langfuse.publicKey,
        secretKey: config.langfuse.secretKey,
        userId: String(config.telegramOwnerUserId),
        ...(config.langfuse.baseUrl
          ? { baseUrl: config.langfuse.baseUrl }
          : {}),
        ...(process.env.RAILWAY_GIT_COMMIT_SHA
          ? { release: process.env.RAILWAY_GIT_COMMIT_SHA }
          : {}),
      });

const app = await buildApp({
  config,
  logger: true,
  tracingEnabled: tracing !== undefined,
});

if (tracing !== undefined) {
  app.log.info(
    { event: "langfuse_tracing_started" },
    "Langfuse tracing enabled",
  );
}

const shutdown = async (signal: NodeJS.Signals) => {
  app.log.info({ signal }, "shutdown requested");
  await app.close();
  // Flush after close so the final turn's spans are exported rather than lost.
  await tracing?.shutdown();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error, "server failed to start");
  process.exit(1);
}
