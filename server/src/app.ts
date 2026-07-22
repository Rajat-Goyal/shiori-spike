import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AppOptions = {
  logger?: boolean;
  serveStatic?: boolean;
  webRoot?: string;
};

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWebRoot = path.resolve(currentDirectory, "../../web/dist");

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/api/ping", async () => ({ message: "pong" }));
  app.get("/api/health", async () => ({ status: "ok" }));

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
