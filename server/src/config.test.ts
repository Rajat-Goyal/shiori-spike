import { describe, expect, it } from "vitest";
import { readServerConfig } from "./config.js";

const validEnvironment = {
  DASHBOARD_PASSWORD_HASH:
    "$argon2id$v=19$m=65536,t=3,p=1$c2hpb3JpLXRlc3Qtc2FsdA$YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ",
  DASHBOARD_SESSION_SECRET: Buffer.alloc(32, 11).toString("base64"),
  OWNER_TIME_ZONE: "Asia/Singapore",
  PUBLIC_APP_BASE_URL: "http://localhost:3000",
  SUPABASE_SECRET_KEY: "sb_secret_test-only",
  SUPABASE_URL: "http://127.0.0.1:54321",
};

describe("readServerConfig", () => {
  it("allows HTTP only for a loopback Supabase URL", () => {
    expect(readServerConfig(validEnvironment).supabaseUrl).toBe(
      "http://127.0.0.1:54321",
    );
    expect(() =>
      readServerConfig({
        ...validEnvironment,
        SUPABASE_URL: "http://database.example.com",
      }),
    ).toThrow("SUPABASE_URL must use HTTPS outside loopback");
    expect(
      readServerConfig({
        ...validEnvironment,
        SUPABASE_URL: "https://database.example.com",
      }).supabaseUrl,
    ).toBe("https://database.example.com");
  });

  it("requires a canonical base64 session secret containing at least 32 bytes", () => {
    for (const invalidSecret of [
      "not-base64",
      Buffer.alloc(31, 1).toString("base64"),
      `${Buffer.alloc(32, 1).toString("base64")}=`,
    ]) {
      expect(() =>
        readServerConfig({
          ...validEnvironment,
          DASHBOARD_SESSION_SECRET: invalidSecret,
        }),
      ).toThrow(/DASHBOARD_SESSION_SECRET/);
    }

    expect(readServerConfig(validEnvironment).dashboardSessionSecret).toBe(
      validEnvironment.DASHBOARD_SESSION_SECRET,
    );
  });
});
