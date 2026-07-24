import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readServerConfig } from "../src/config.js";
import { supabaseHeaders } from "../src/supabase.js";
import { SupabaseTelegramRepository } from "../src/telegram/repository.js";

describe("local Supabase Telegram ingress", () => {
  it("claims replay once, captures owner chat atomically, and persists no payload fields", async () => {
    const config = readServerConfig();
    const url = new URL(config.supabaseUrl);
    if (
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.port !== "54321"
    ) {
      throw new Error(
        "test:db is restricted to the Docker-generated local Supabase API on port 54321",
      );
    }

    const repository = new SupabaseTelegramRepository({
      supabaseSecretKey: config.supabaseSecretKey,
      supabaseUrl: config.supabaseUrl,
    });
    const updateId = 8_000_000_000 + randomInt(1_000_000_000);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.claimUpdate(updateId, config.telegramOwnerUserId),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    await repository.completeUpdate(updateId, "status_empty");
    await expect(
      repository.claimUpdate(updateId, config.telegramOwnerUserId),
    ).resolves.toBe(false);

    const [updatesResponse, ownerResponse] = await Promise.all([
      fetch(
        `${config.supabaseUrl}/rest/v1/telegram_updates?select=*&update_id=eq.${updateId}`,
        { headers: supabaseHeaders(config.supabaseSecretKey) },
      ),
      fetch(
        `${config.supabaseUrl}/rest/v1/telegram_owner_delivery?select=*&singleton=eq.true`,
        { headers: supabaseHeaders(config.supabaseSecretKey) },
      ),
    ]);
    expect(updatesResponse.ok).toBe(true);
    expect(ownerResponse.ok).toBe(true);

    const updates: unknown = await updatesResponse.json();
    const ownerState: unknown = await ownerResponse.json();
    expect(Array.isArray(updates)).toBe(true);
    expect(Array.isArray(ownerState)).toBe(true);
    const updateRecord = (updates as Array<Record<string, unknown>>)[0];
    const ownerRecord = (ownerState as Array<Record<string, unknown>>)[0];

    expect(Object.keys(updateRecord).sort()).toEqual([
      "is_owner_private",
      "processed_at",
      "processing_result",
      "processing_status",
      "received_at",
      "update_id",
    ]);
    expect(updateRecord.processing_status).toBe("processed");
    expect(updateRecord.processing_result).toBe("status_empty");
    expect(Object.keys(ownerRecord).sort()).toEqual([
      "captured_at",
      "private_chat_id",
      "singleton",
    ]);
    expect(ownerRecord.private_chat_id === config.telegramOwnerUserId).toBe(
      true,
    );
  });
});
