export type ServerConfig = Readonly<{
  dashboardPasswordHash: string;
  dashboardSessionSecret: string;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOwnerEmail: string;
  googleTokenEncryptionKey: string;
  googleTokenKeyVersion: number;
  openaiApiKey: string;
  openaiModel: string;
  openaiPromptVersion: string;
  ownerTimeZone: "Asia/Singapore";
  publicAppBaseUrl: string;
  supabaseSecretKey: string;
  supabaseUrl: string;
  telegramBotToken: string;
  telegramOwnerUserId: number;
  telegramWebhookSecret: string;
}>;

const PLACEHOLDER = /^<.*>$/;

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();

  if (!value || PLACEHOLDER.test(value)) {
    throw new Error(`Missing required server configuration: ${key}`);
  }

  return value;
}

function httpUrl(
  value: string,
  key: string,
  options: {
    originOnly?: boolean;
    requireHttpsOffLoopback?: boolean;
  } = {},
): string {
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

  const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
  if (
    options.requireHttpsOffLoopback &&
    url.protocol !== "https:" &&
    !loopbackHosts.has(url.hostname)
  ) {
    throw new Error(
      `Invalid server configuration: ${key} must use HTTPS outside loopback`,
    );
  }
  if (
    options.originOnly &&
    (url.pathname !== "/" || url.search || url.hash)
  ) {
    throw new Error(
      `Invalid server configuration: ${key} must be an origin without a path, query, or fragment`,
    );
  }

  return url.toString().replace(/\/$/, "");
}

function sessionSecret(value: string): string {
  const strictBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (!strictBase64.test(value) || value.length % 4 !== 0) {
    throw new Error(
      "Invalid server configuration: DASHBOARD_SESSION_SECRET must be strict base64",
    );
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 32 || decoded.toString("base64") !== value) {
    throw new Error(
      "Invalid server configuration: DASHBOARD_SESSION_SECRET must decode to at least 32 bytes",
    );
  }

  return value;
}

function boundedIdentifier(value: string, key: string): string {
  if (
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(
      `Invalid server configuration: ${key} must be a 1-128 character identifier`,
    );
  }

  return value;
}

function googleEncryptionKey(value: string): string {
  const strictBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (
    !strictBase64.test(value) ||
    value.length % 4 !== 0 ||
    Buffer.from(value, "base64").length !== 32 ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error(
      "Invalid server configuration: GOOGLE_TOKEN_ENCRYPTION_KEY must be strict base64 encoding exactly 32 bytes",
    );
  }
  return value;
}

function googleOwnerEmail(value: string): string {
  if (
    value.length > 254 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
  ) {
    throw new Error(
      "Invalid server configuration: GOOGLE_OWNER_EMAIL must be an email address",
    );
  }
  return value;
}

export function readServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const dashboardPasswordHash = required(environment, "DASHBOARD_PASSWORD_HASH");
  const dashboardSessionSecret = required(environment, "DASHBOARD_SESSION_SECRET");
  const googleOAuthClientId = required(environment, "GOOGLE_OAUTH_CLIENT_ID");
  const googleOAuthClientSecret = required(
    environment,
    "GOOGLE_OAUTH_CLIENT_SECRET",
  );
  const googleOwnerEmailValue = required(environment, "GOOGLE_OWNER_EMAIL");
  const googleTokenEncryptionKeyValue = required(
    environment,
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
  );
  const googleTokenKeyVersionValue = required(
    environment,
    "GOOGLE_TOKEN_KEY_VERSION",
  );
  const openaiApiKey = required(environment, "OPENAI_API_KEY");
  const openaiModel = required(environment, "OPENAI_MODEL");
  const openaiPromptVersion = required(environment, "OPENAI_PROMPT_VERSION");
  const ownerTimeZone = required(environment, "OWNER_TIME_ZONE");
  const telegramBotToken = required(environment, "TELEGRAM_BOT_TOKEN");
  const telegramOwnerUserIdValue = required(
    environment,
    "TELEGRAM_OWNER_USER_ID",
  );
  const telegramWebhookSecret = required(
    environment,
    "TELEGRAM_WEBHOOK_SECRET",
  );
  const googleTokenKeyVersion = Number(googleTokenKeyVersionValue);

  if (!dashboardPasswordHash.startsWith("$argon2id$v=19$")) {
    throw new Error(
      "Invalid server configuration: DASHBOARD_PASSWORD_HASH must be an Argon2id PHC string",
    );
  }

  if (ownerTimeZone !== "Asia/Singapore") {
    throw new Error(
      "Invalid server configuration: OWNER_TIME_ZONE must be Asia/Singapore for this slice",
    );
  }

  if (
    !/^\d+$/.test(telegramOwnerUserIdValue) ||
    !Number.isSafeInteger(Number(telegramOwnerUserIdValue)) ||
    Number(telegramOwnerUserIdValue) <= 0
  ) {
    throw new Error(
      "Invalid server configuration: TELEGRAM_OWNER_USER_ID must be a positive safe integer",
    );
  }

  if (
    telegramWebhookSecret.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(telegramWebhookSecret)
  ) {
    throw new Error(
      "Invalid server configuration: TELEGRAM_WEBHOOK_SECRET must contain 1-256 Telegram-safe characters",
    );
  }

  if (
    !/^\d+$/.test(googleTokenKeyVersionValue) ||
    !Number.isSafeInteger(googleTokenKeyVersion) ||
    googleTokenKeyVersion < 1
  ) {
    throw new Error(
      "Invalid server configuration: GOOGLE_TOKEN_KEY_VERSION must be a positive safe integer",
    );
  }

  return {
    dashboardPasswordHash,
    dashboardSessionSecret: sessionSecret(dashboardSessionSecret),
    googleOAuthClientId: boundedIdentifier(
      googleOAuthClientId,
      "GOOGLE_OAUTH_CLIENT_ID",
    ),
    googleOAuthClientSecret,
    googleOwnerEmail: googleOwnerEmail(googleOwnerEmailValue),
    googleTokenEncryptionKey: googleEncryptionKey(
      googleTokenEncryptionKeyValue,
    ),
    googleTokenKeyVersion,
    openaiApiKey,
    openaiModel: boundedIdentifier(openaiModel, "OPENAI_MODEL"),
    openaiPromptVersion: boundedIdentifier(
      openaiPromptVersion,
      "OPENAI_PROMPT_VERSION",
    ),
    ownerTimeZone,
    publicAppBaseUrl: httpUrl(
      required(environment, "PUBLIC_APP_BASE_URL"),
      "PUBLIC_APP_BASE_URL",
      { originOnly: true, requireHttpsOffLoopback: true },
    ),
    supabaseSecretKey: required(environment, "SUPABASE_SECRET_KEY"),
    supabaseUrl: httpUrl(
      required(environment, "SUPABASE_URL"),
      "SUPABASE_URL",
      { requireHttpsOffLoopback: true },
    ),
    telegramBotToken,
    telegramOwnerUserId: Number(telegramOwnerUserIdValue),
    telegramWebhookSecret,
  };
}
