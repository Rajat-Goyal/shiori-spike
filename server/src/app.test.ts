import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("API contracts", () => {
  it("returns pong from GET /api/ping", async () => {
    const app = await buildApp({ serveStatic: false });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/ping" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ message: "pong" });
  });

  it("returns ok from GET /api/health", async () => {
    const app = await buildApp({ serveStatic: false });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "ok" });
  });
});
