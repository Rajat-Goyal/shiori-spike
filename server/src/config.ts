import {
  AGENT_SESSION_DEFAULT_RETENTION_SECONDS,
  AGENT_SESSION_MIN_RETENTION_SECONDS,
} from "./agent/session.js";

export type ServerConfig = Readonly<{
  agentSessionRetentionSeconds: number;
  conversationFailureCodes: boolean;
  dashboardPasswordHash: string;
  /**
   * Present only when both Langfuse keys are configured. Tracing is optional:
   * the bot must run identically with observability switched off.
   */
  langfuse?: Readonly<{
    baseUrl?: string;
    publicKey: string;
    secretKey: string;
  }>;
  dashboardSessionSecret: string;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  googleOwnerEmail: string;
  googleTokenEncryptionKey: string;
  googleTokenKeyVersion: number;
  openaiApiKey: string;
  openaiModel: string;
  /**
   * Reasoning effort for the conversation agent. Shiori's work is date
   * arithmetic in a fixed timezone, three-way classification, and deciding which
   * fields changed, all of which benefit from deliberation.
   */
  openaiReasoningEffort: "high" | "low" | "medium" | "minimal" | "none";
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

function optionalBoundedInteger(
  environment: NodeJS.ProcessEnv,
  key: string,
  options: {
    defaultValue: number;
    maximum: number;
    minimum: number;
  },
): number {
  const value = environment[key]?.trim();
  if (!value) {
    return options.defaultValue;
  }

  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < options.minimum ||
    parsed > options.maximum
  ) {
    throw new Error(
      `Invalid server configuration: ${key} must be an integer between ${options.minimum} and ${options.maximum}`,
    );
  }

  return parsed;
}

/**
 * Owner-facing diagnostic switch, default off.
 *
 * When on, a failure reply carries its reason code so a Telegram screenshot
 * identifies the failing path without correlating timestamps against
 * `conversation_turn_failures`. Temporary: it exists only until failure replies
 * are replaced by continuing the conversation.
 */
function optionalFlag(
  environment: NodeJS.ProcessEnv,
  key: string,
): boolean {
  const value = environment[key]?.trim().toLowerCase();
  if (!value || PLACEHOLDER.test(value)) {
    return false;
  }
  if (!["false", "true"].includes(value)) {
    throw new Error(
      `Invalid server configuration: ${key} must be true or false`,
    );
  }
  return value === "true";
}

function optionalValue(
  environment: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = environment[key]?.trim();
  return !value || PLACEHOLDER.test(value) ? undefined : value;
}

/**
 * Resolves optional Langfuse credentials.
 *
 * Both keys are required together: one alone is a misconfiguration that would
 * otherwise fail silently at export time, long after startup.
 */
function optionalLangfuse(
  environment: NodeJS.ProcessEnv,
): ServerConfig["langfuse"] {
  const publicKey = optionalValue(environment, "LANGFUSE_PUBLIC_KEY");
  const secretKey = optionalValue(environment, "LANGFUSE_SECRET_KEY");
  const baseUrl = optionalValue(environment, "LANGFUSE_BASE_URL");
  if (publicKey === undefined && secretKey === undefined) {
    return undefined;
  }
  if (publicKey === undefined || secretKey === undefined) {
    throw new Error(
      "Invalid server configuration: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set together",
    );
  }
  if (baseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(
        "Invalid server configuration: LANGFUSE_BASE_URL must be an absolute URL",
      );
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        "Invalid server configuration: LANGFUSE_BASE_URL must use HTTPS",
      );
    }
  }
  return {
    publicKey,
    secretKey,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

const REASONING_EFFORTS = [
  "high",
  "low",
  "medium",
  "minimal",
  "none",
] as const;

function optionalReasoningEffort(
  environment: NodeJS.ProcessEnv,
): ServerConfig["openaiReasoningEffort"] {
  const value = optionalValue(environment, "OPENAI_REASONING_EFFORT");
  if (value === undefined) {
    return "medium";
  }
  const normalized = value.toLowerCase();
  if (
    !(REASONING_EFFORTS as readonly string[]).includes(normalized)
  ) {
    throw new Error(
      `Invalid server configuration: OPENAI_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  return normalized as ServerConfig["openaiReasoningEffort"];
}

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
  const agentSessionRetentionSeconds = optionalBoundedInteger(
    environment,
    "AGENT_SESSION_RETENTION_SECONDS",
    {
      defaultValue: AGENT_SESSION_DEFAULT_RETENTION_SECONDS,
      maximum: AGENT_SESSION_DEFAULT_RETENTION_SECONDS,
      minimum: AGENT_SESSION_MIN_RETENTION_SECONDS,
    },
  );
  const langfuse = optionalLangfuse(environment);
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
    agentSessionRetentionSeconds,
    conversationFailureCodes: optionalFlag(
      environment,
      "CONVERSATION_FAILURE_CODES",
    ),
    dashboardPasswordHash,
    openaiReasoningEffort: optionalReasoningEffort(environment),
    ...(langfuse === undefined ? {} : { langfuse }),
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
