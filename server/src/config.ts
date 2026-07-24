export type ServerConfig = Readonly<{
  dashboardPasswordHash: string;
  dashboardSessionSecret: string;
  ownerTimeZone: "Asia/Singapore";
  publicAppBaseUrl: string;
  supabaseSecretKey: string;
  supabaseUrl: string;
}>;

const PLACEHOLDER = /^<.*>$/;

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();

  if (!value || PLACEHOLDER.test(value)) {
    throw new Error(`Missing required server configuration: ${key}`);
  }

  return value;
}

function httpUrl(value: string, key: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid server configuration: ${key} must be an HTTP URL`);
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(
      `Invalid server configuration: ${key} must be an HTTP URL without credentials`,
    );
  }

  return url.toString().replace(/\/$/, "");
}

export function readServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const dashboardPasswordHash = required(environment, "DASHBOARD_PASSWORD_HASH");
  const dashboardSessionSecret = required(environment, "DASHBOARD_SESSION_SECRET");
  const ownerTimeZone = required(environment, "OWNER_TIME_ZONE");

  if (!dashboardPasswordHash.startsWith("$argon2id$v=19$")) {
    throw new Error(
      "Invalid server configuration: DASHBOARD_PASSWORD_HASH must be an Argon2id PHC string",
    );
  }

  if (dashboardSessionSecret.length < 32) {
    throw new Error(
      "Invalid server configuration: DASHBOARD_SESSION_SECRET must contain at least 32 characters",
    );
  }

  if (ownerTimeZone !== "Asia/Singapore") {
    throw new Error(
      "Invalid server configuration: OWNER_TIME_ZONE must be Asia/Singapore for this slice",
    );
  }

  return {
    dashboardPasswordHash,
    dashboardSessionSecret,
    ownerTimeZone,
    publicAppBaseUrl: httpUrl(
      required(environment, "PUBLIC_APP_BASE_URL"),
      "PUBLIC_APP_BASE_URL",
    ),
    supabaseSecretKey: required(environment, "SUPABASE_SECRET_KEY"),
    supabaseUrl: httpUrl(required(environment, "SUPABASE_URL"), "SUPABASE_URL"),
  };
}
