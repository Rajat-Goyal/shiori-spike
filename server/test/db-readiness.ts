import { setTimeout as delay } from "node:timers/promises";

const MAX_ATTEMPTS = 120;
const RETRY_DELAY_MILLISECONDS = 500;

export default async function waitForLocalSupabase(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const expectedPort =
    process.env.SHIORI_TEST_SUPABASE_PORT ?? "54321";

  if (!supabaseUrl || !secretKey) {
    throw new Error("Local Supabase readiness configuration is missing");
  }

  const url = new URL(supabaseUrl);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== expectedPort
  ) {
    throw new Error(
      `Database readiness is restricted to local Supabase on port ${expectedPort}`,
    );
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(
        `${url.origin}/rest/v1/telegram_updates?select=update_id&limit=0`,
        {
          headers: {
            apikey: secretKey,
            authorization: `Bearer ${secretKey}`,
          },
          signal: AbortSignal.timeout(1_000),
        },
      );
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      // The local PostgREST process may still be reconnecting after db reset.
    }

    if (attempt < MAX_ATTEMPTS) {
      await delay(RETRY_DELAY_MILLISECONDS);
    }
  }

  throw new Error(
    "Docker-local Supabase REST API did not become ready within 60 seconds",
  );
}
