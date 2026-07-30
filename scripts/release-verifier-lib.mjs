import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RELEASE_TARGET = Object.freeze({
  domain: "shiori-slice-01-production.up.railway.app",
  environmentId: "0a533591-3fce-4904-8fb3-84d0f52346e7",
  legacyServiceId: "15ab9853-c3ea-4387-8486-254e60204693",
  projectId: "d8806797-6bb9-495b-8e10-b13122a6eff6",
  publicOrigin:
    "https://shiori-slice-01-production.up.railway.app",
  replicas: 1,
  serviceId: "85bc7677-b070-43ce-8ae1-e2c65241a721",
});

export const JOURNEY_IDS = Object.freeze(
  Array.from({ length: 18 }, (_, index) => `S${index + 1}`),
);
export const BOUNDARY_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `S${index + 19}`),
);

export const APPLICATION_RUNTIME_KEYS = Object.freeze([
  "DASHBOARD_PASSWORD_HASH",
  "DASHBOARD_SESSION_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OWNER_EMAIL",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
  "GOOGLE_TOKEN_KEY_VERSION",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_PROMPT_VERSION",
  "OWNER_TIME_ZONE",
  "PUBLIC_APP_BASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_USER_ID",
  "TELEGRAM_WEBHOOK_SECRET",
]);

/**
 * Runtime keys the application reads but does not require.
 *
 * `APPLICATION_RUNTIME_KEYS` mirrors the `required()` calls in config.ts and is
 * matched exactly, so without this allowance an optional key could not be set on
 * Railway at all. Optional keys are deliberately excluded from
 * `runtimeConfigHash`: they must not change the pinned release identity.
 */
export const OPTIONAL_RUNTIME_KEYS = Object.freeze([
  "AGENT_SESSION_RETENTION_SECONDS",
  "CONVERSATION_FAILURE_CODES",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PROMPT_LABEL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OPENAI_REASONING_EFFORT",
]);

const RELEASE_ONLY_KEYS = Object.freeze([
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_SERVICE_ID",
  "SUPABASE_DATABASE_POOLER_URL",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_EVIDENCE_KEY =
  /(?:^|_)(?:access_token|authorization|body|calendar_event|calendar_title|client_secret|conversation|cookie|email|message_text|oauth_code|owner_id|owner_identity|owner_user_id|password|payload|private_event|raw|refresh_token|secret|telegram_update|token|transcript|webhook)(?:$|_)/i;
const GENERIC_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
  /\bsb_secret_[A-Za-z0-9_-]{8,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/,
  /\$argon2id\$v=19\$[^\s"]+/i,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/,
  /[?&](?:code|token|state)=[^&\s"]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\/(?:Users|home)\/[^/\s"'\\]+/,
];

export class ReleaseVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseVerificationError";
    this.code = code;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function withIntegrity(payload) {
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      digest: sha256(canonicalJson(payload)),
    },
  };
}

export function verifyIntegrity(value, label = "artifact") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.integrity?.algorithm !== "sha256" ||
    !SHA256_PATTERN.test(String(value.integrity?.digest))
  ) {
    throw new ReleaseVerificationError(
      "invalid_integrity",
      `${label} has no valid integrity envelope`,
    );
  }
  const { integrity, ...payload } = value;
  const expected = sha256(canonicalJson(payload));
  if (integrity.digest !== expected) {
    throw new ReleaseVerificationError(
      "integrity_drift",
      `${label} integrity does not match its content`,
    );
  }
  return payload;
}

export function writeImmutableJson(filePath, payload) {
  const artifact = withIntegrity(payload);
  try {
    writeFileSync(
      filePath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ReleaseVerificationError(
        "artifact_exists",
        `${path.basename(filePath)} already exists; immutable evidence is never overwritten`,
      );
    }
    throw error;
  }
  return artifact;
}

export function readIntegrityJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new ReleaseVerificationError(
      "invalid_artifact",
      `${label} is missing or invalid JSON`,
    );
  }
  verifyIntegrity(parsed, label);
  return parsed;
}

export function parseEnvFile(text) {
  const environment = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      throw new ReleaseVerificationError(
        "invalid_env",
        "Environment file contains an invalid assignment",
      );
    }
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    environment[match[1]] = value;
  }
  return environment;
}

export function unexpectedGitChanges(status, allowedEvidencePrefix = null) {
  const normalizedPrefix = allowedEvidencePrefix
    ? `${allowedEvidencePrefix.replaceAll("\\", "/").replace(/\/+$/, "")}/`
    : null;
  return String(status)
    .split("\0")
    .filter(Boolean)
    .filter((record) => {
      const state = record.slice(0, 2);
      const file = record.slice(3).replaceAll("\\", "/");
      return !(
        state === "??" &&
        normalizedPrefix &&
        file.startsWith(normalizedPrefix)
      );
    });
}

export function sensitiveValues(environment) {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        value.length >= 4 &&
        /(?:API_KEY|CLIENT_SECRET|EMAIL|ENCRYPTION_KEY|OWNER_ID|OWNER_USER_ID|PASSWORD|PUBLISHABLE_KEY|SECRET|TOKEN|WEBHOOK)/.test(
          key,
        ),
    )
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

export function redactText(value, secrets = []) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bsb_secret_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(/\$argon2id\$v=19\$[^\s"]+/gi, "[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(
      /([?&](?:code|token|state)=)[^&\s"]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[REDACTED]",
    )
    .replace(/\/(?:Users|home)\/[^/\s"'\\]+/g, "/[REDACTED]");
  return redacted;
}

export function assertRedactedEvidence(value, secrets = [], label = "evidence") {
  function visit(item, location) {
    if (typeof item === "string") {
      for (const secret of secrets) {
        if (secret && item.includes(secret)) {
          throw new ReleaseVerificationError(
            "sensitive_value",
            `${label} contains a configured sensitive value at ${location}`,
          );
        }
      }
      if (GENERIC_SECRET_PATTERNS.some((pattern) => pattern.test(item))) {
        throw new ReleaseVerificationError(
          "sensitive_pattern",
          `${label} contains prohibited sensitive material at ${location}`,
        );
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        const normalizedKey = key
          .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
          .toLowerCase();
        if (FORBIDDEN_EVIDENCE_KEY.test(normalizedKey)) {
          throw new ReleaseVerificationError(
            "forbidden_evidence_field",
            `${label} contains prohibited field ${key}`,
          );
        }
        visit(entry, `${location}.${key}`);
      }
    }
  }
  visit(value, "$");
  return true;
}

export function validateReleaseEnvironment(environment) {
  const required = [...APPLICATION_RUNTIME_KEYS, ...RELEASE_ONLY_KEYS];
  const missing = required.filter(
    (key) =>
      !environment[key]?.trim() ||
      /^<.*>$/.test(environment[key].trim()),
  );
  if (missing.length > 0) {
    throw new ReleaseVerificationError(
      "missing_config",
      `Missing required release configuration keys: ${missing.join(", ")}`,
    );
  }
  const fixed = [
    ["RAILWAY_PROJECT_ID", RELEASE_TARGET.projectId],
    ["RAILWAY_ENVIRONMENT_ID", RELEASE_TARGET.environmentId],
    ["RAILWAY_SERVICE_ID", RELEASE_TARGET.serviceId],
    ["PUBLIC_APP_BASE_URL", RELEASE_TARGET.publicOrigin],
  ];
  if (
    environment.RAILWAY_SERVICE_ID === RELEASE_TARGET.legacyServiceId
  ) {
    throw new ReleaseVerificationError(
      "legacy_service_refused",
      "The legacy Railway service is permanently refused",
    );
  }
  for (const [key, expected] of fixed) {
    if (environment[key] !== expected) {
      throw new ReleaseVerificationError(
        "target_identity_mismatch",
        `${key} does not match the approved release target`,
      );
    }
  }
  if (environment.OWNER_TIME_ZONE !== "Asia/Singapore") {
    throw new ReleaseVerificationError(
      "config_mismatch",
      "OWNER_TIME_ZONE must be Asia/Singapore",
    );
  }
  let supabaseUrl;
  let poolerUrl;
  try {
    supabaseUrl = new URL(environment.SUPABASE_URL);
    poolerUrl = new URL(environment.SUPABASE_DATABASE_POOLER_URL);
  } catch {
    throw new ReleaseVerificationError(
      "invalid_supabase_target",
      "Supabase release URLs are invalid",
    );
  }
  if (
    supabaseUrl.protocol !== "https:" ||
    !supabaseUrl.hostname.endsWith(".supabase.co") ||
    supabaseUrl.pathname !== "/" ||
    !["postgres:", "postgresql:"].includes(poolerUrl.protocol) ||
    !poolerUrl.hostname.endsWith(".supabase.com")
  ) {
    throw new ReleaseVerificationError(
      "invalid_supabase_target",
      "Supabase release targets must be hosted HTTPS and pooler endpoints",
    );
  }
  const projectReference = supabaseUrl.hostname.split(".")[0];
  if (
    !/^[a-z0-9]{20}$/.test(projectReference) ||
    decodeURIComponent(poolerUrl.username) !==
      `postgres.${projectReference}`
  ) {
    throw new ReleaseVerificationError(
      "supabase_identity_mismatch",
      "Supabase API and pooler do not identify the same hosted project",
    );
  }
  return {
    configuredKeys: required.sort(),
    supabaseTargetHash: sha256(
      `${projectReference}|${supabaseUrl.origin}|${poolerUrl.hostname}:${poolerUrl.port}`,
    ),
  };
}

export function parseRailwayVariableInventory(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch {
    throw new ReleaseVerificationError(
      "invalid_railway_variables",
      "Railway variable inventory returned invalid structured output",
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0 ||
    Object.entries(parsed).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string",
    )
  ) {
    throw new ReleaseVerificationError(
      "invalid_railway_variables",
      "Railway variable inventory has an invalid schema",
    );
  }
  return parsed;
}

export function validateRailwayVariableInventory(
  variables,
  releaseEnvironment,
) {
  if (
    variables === null ||
    typeof variables !== "object" ||
    Array.isArray(variables) ||
    Object.keys(variables).length === 0 ||
    Object.entries(variables).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string",
    )
  ) {
    throw new ReleaseVerificationError(
      "invalid_railway_variables",
      "Railway variable inventory has an invalid schema",
    );
  }
  if (
    variables.RAILWAY_SERVICE_ID === RELEASE_TARGET.legacyServiceId ||
    releaseEnvironment.RAILWAY_SERVICE_ID === RELEASE_TARGET.legacyServiceId
  ) {
    throw new ReleaseVerificationError(
      "legacy_service_refused",
      "The legacy Railway service is permanently refused",
    );
  }
  const targetVariables = [
    ["RAILWAY_PROJECT_ID", RELEASE_TARGET.projectId, "project"],
    ["RAILWAY_ENVIRONMENT_ID", RELEASE_TARGET.environmentId, "environment"],
    ["RAILWAY_SERVICE_ID", RELEASE_TARGET.serviceId, "service"],
  ];
  for (const [key, expected, label] of targetVariables) {
    if (variables[key] !== expected) {
      throw new ReleaseVerificationError(
        `railway_variable_${label}_mismatch`,
        `Railway variable inventory belongs to the wrong ${label}`,
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(
      variables,
      "SUPABASE_DATABASE_POOLER_URL",
    )
  ) {
    throw new ReleaseVerificationError(
      "railway_pooler_forbidden",
      "The release-only Supabase pooler URL must not be deployed",
    );
  }
  const deployedApplicationKeys = Object.keys(variables)
    .filter((key) => !key.startsWith("RAILWAY_"))
    .sort();
  const deployedOptionalKeys = deployedApplicationKeys.filter((key) =>
    OPTIONAL_RUNTIME_KEYS.includes(key),
  );
  if (
    canonicalJson(
      deployedApplicationKeys.filter(
        (key) => !OPTIONAL_RUNTIME_KEYS.includes(key),
      ),
    ) !== canonicalJson([...APPLICATION_RUNTIME_KEYS].sort())
  ) {
    throw new ReleaseVerificationError(
      "railway_runtime_inventory_mismatch",
      "Railway application runtime keys are missing or unexpected",
    );
  }
  let deployedSupabaseUrl;
  let expectedSupabaseUrl;
  try {
    deployedSupabaseUrl = new URL(variables.SUPABASE_URL);
    expectedSupabaseUrl = new URL(releaseEnvironment.SUPABASE_URL);
  } catch {
    throw new ReleaseVerificationError(
      "railway_supabase_target_invalid",
      "Railway Supabase runtime target is invalid",
    );
  }
  if (
    deployedSupabaseUrl.protocol !== "https:" ||
    !deployedSupabaseUrl.hostname.endsWith(".supabase.co") ||
    deployedSupabaseUrl.pathname !== "/" ||
    deployedSupabaseUrl.search ||
    deployedSupabaseUrl.hash ||
    deployedSupabaseUrl.hostname.split(".")[0] !==
      expectedSupabaseUrl.hostname.split(".")[0]
  ) {
    throw new ReleaseVerificationError(
      "railway_supabase_target_invalid",
      "Railway Supabase runtime target is not the approved hosted project",
    );
  }
  for (const key of APPLICATION_RUNTIME_KEYS) {
    if (
      typeof releaseEnvironment[key] !== "string" ||
      variables[key] !== releaseEnvironment[key]
    ) {
      throw new ReleaseVerificationError(
        "railway_runtime_value_mismatch",
        "Railway application runtime values differ from the release target",
      );
    }
  }
  const runtimeConfiguration = Object.fromEntries(
    APPLICATION_RUNTIME_KEYS.map((key) => [key, variables[key]]),
  );
  return {
    hostedSupabase: true,
    legacyServiceExcluded: true,
    optionalKeys: deployedOptionalKeys,
    poolerExcluded: true,
    runtimeConfigHash: sha256(canonicalJson(runtimeConfiguration)),
    runtimeKeysExact: true,
    targetEnvironmentExact: true,
    targetProjectExact: true,
    targetServiceExact: true,
  };
}

function edges(value) {
  return Array.isArray(value?.edges)
    ? value.edges.map((edge) => edge?.node).filter(Boolean)
    : [];
}

export function validateRailwayStatus(status) {
  if (status?.id !== RELEASE_TARGET.projectId) {
    throw new ReleaseVerificationError(
      "railway_project_mismatch",
      "Railway project identity does not match",
    );
  }
  const environment = edges(status.environments).find(
    (item) => item.id === RELEASE_TARGET.environmentId,
  );
  if (!environment) {
    throw new ReleaseVerificationError(
      "railway_environment_mismatch",
      "Railway production environment was not found",
    );
  }
  const instances = edges(environment.serviceInstances);
  const dedicated = instances.find(
    (item) => item.serviceId === RELEASE_TARGET.serviceId,
  );
  if (!dedicated) {
    if (
      instances.some(
        (item) => item.serviceId === RELEASE_TARGET.legacyServiceId,
      )
    ) {
      throw new ReleaseVerificationError(
        "legacy_service_refused",
        "The legacy Railway service is permanently refused",
      );
    }
    throw new ReleaseVerificationError(
      "railway_service_mismatch",
      "Dedicated Railway service was not found",
    );
  }
  if (dedicated.serviceId === RELEASE_TARGET.legacyServiceId) {
    throw new ReleaseVerificationError(
      "legacy_service_refused",
      "The legacy Railway service is permanently refused",
    );
  }
  const domains = dedicated.domains?.serviceDomains ?? [];
  if (
    domains.length !== 1 ||
    domains[0]?.domain !== RELEASE_TARGET.domain
  ) {
    throw new ReleaseVerificationError(
      "railway_domain_mismatch",
      "Dedicated Railway domain does not match exactly",
    );
  }
  const deployConfig =
    dedicated.latestDeployment?.meta?.serviceManifest?.deploy;
  const replicas =
    deployConfig?.numReplicas ??
    Object.values(deployConfig?.multiRegionConfig ?? {}).reduce(
      (total, region) => total + Number(region?.numReplicas ?? 0),
      0,
    );
  if (replicas !== RELEASE_TARGET.replicas) {
    throw new ReleaseVerificationError(
      "railway_replica_mismatch",
      "Dedicated Railway service must have exactly one replica",
    );
  }
  const deployment = dedicated.latestDeployment;
  return {
    deploymentId:
      typeof deployment?.id === "string" && UUID_PATTERN.test(deployment.id)
        ? deployment.id
        : null,
    domain: RELEASE_TARGET.domain,
    environmentId: RELEASE_TARGET.environmentId,
    imageDigest:
      typeof deployment?.meta?.imageDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(deployment.meta.imageDigest)
        ? deployment.meta.imageDigest
        : null,
    projectId: RELEASE_TARGET.projectId,
    replicas,
    serviceId: RELEASE_TARGET.serviceId,
    status: deployment?.status ?? null,
  };
}

function isStrictlyIncreasing(values) {
  return values.every(
    (value, index) => index === 0 || values[index - 1] < value,
  );
}

function invalidMigrationOutput() {
  throw new ReleaseVerificationError(
    "invalid_migration_output",
    "Supabase CLI migration output is malformed or unrecognized",
  );
}

function migrationLedgerFromRows(rows) {
  if (!Array.isArray(rows)) {
    invalidMigrationOutput();
  }
  const local = [];
  const remote = [];
  let priorRowVersion = null;
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      canonicalJson(Object.keys(row).sort()) !==
        canonicalJson(["local", "remote", "time"])
    ) {
      invalidMigrationOutput();
    }
    const { local: localVersion, remote: remoteVersion, time } = row;
    if (
      typeof localVersion !== "string" ||
      typeof remoteVersion !== "string" ||
      typeof time !== "string" ||
      !/^(?:\d{14})?$/.test(localVersion) ||
      !/^(?:\d{14})?$/.test(remoteVersion) ||
      !/^(?:\d{14}|\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?)$/.test(
        time,
      ) ||
      (!localVersion && !remoteVersion) ||
      (localVersion && remoteVersion && localVersion !== remoteVersion)
    ) {
      invalidMigrationOutput();
    }
    const rowVersion = localVersion || remoteVersion;
    if (priorRowVersion !== null && priorRowVersion >= rowVersion) {
      invalidMigrationOutput();
    }
    priorRowVersion = rowVersion;
    if (localVersion) {
      local.push(localVersion);
    }
    if (remoteVersion) {
      remote.push(remoteVersion);
    }
  }
  if (!isStrictlyIncreasing(local) || !isStrictlyIncreasing(remote)) {
    invalidMigrationOutput();
  }
  return { local, remote };
}

function parseLegacyMigrationTable(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const cells = (line) => {
    const normalized = line.replace(/^\|/, "").replace(/\|$/, "");
    return normalized.split("|").map((cell) => cell.trim());
  };
  if (lines.length < 1) {
    invalidMigrationOutput();
  }
  const header = cells(lines[0]);
  if (
    header.length !== 3 ||
    header[0].toLowerCase() !== "local" ||
    header[1].toLowerCase() !== "remote" ||
    !/^time(?: \(utc\))?$/i.test(header[2])
  ) {
    invalidMigrationOutput();
  }
  let index = 1;
  if (
    lines[index] &&
    cells(lines[index]).length === 3 &&
    cells(lines[index]).every((cell) => /^-+$/.test(cell))
  ) {
    index += 1;
  }
  const rows = lines.slice(index).map((line) => {
    const row = cells(line);
    if (row.length !== 3) {
      invalidMigrationOutput();
    }
    return { local: row[0], remote: row[1], time: row[2] };
  });
  return migrationLedgerFromRows(rows);
}

export function parseMigrationList(output) {
  const normalized = String(output).trim();
  if (!normalized) {
    invalidMigrationOutput();
  }
  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(normalized);
    } catch {
      invalidMigrationOutput();
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      canonicalJson(Object.keys(parsed).sort()) !==
        canonicalJson(["message", "migrations"]) ||
      parsed.message !== "Migrations listed"
    ) {
      invalidMigrationOutput();
    }
    return migrationLedgerFromRows(parsed.migrations);
  }
  return parseLegacyMigrationTable(normalized);
}

export function validateMigrationLedger(manifest, ledger) {
  const local = Array.isArray(manifest)
    ? manifest.map((migration) => migration?.version)
    : [];
  if (
    local.length === 0 ||
    new Set(local).size !== local.length ||
    !local.every(
      (version) =>
        typeof version === "string" && /^\d{14}$/.test(version),
    ) ||
    !isStrictlyIncreasing(local)
  ) {
    throw new ReleaseVerificationError(
      "invalid_migration_manifest",
      "Local migration manifest is invalid",
    );
  }
  if (
    ledger === null ||
    typeof ledger !== "object" ||
    !Array.isArray(ledger.local) ||
    !Array.isArray(ledger.remote) ||
    ![ledger.local, ledger.remote].every(
      (versions) =>
        new Set(versions).size === versions.length &&
        versions.every(
          (version) =>
            typeof version === "string" && /^\d{14}$/.test(version),
        ) &&
        isStrictlyIncreasing(versions),
    )
  ) {
    throw new ReleaseVerificationError(
      "invalid_migration_output",
      "Supabase CLI migration output is malformed or unrecognized",
    );
  }
  if (
    canonicalJson(ledger.local) !== canonicalJson(local)
  ) {
    throw new ReleaseVerificationError(
      "migration_cli_drift",
      "Supabase CLI local migration list differs from the source manifest",
    );
  }
  const remote = ledger.remote;
  for (let index = 0; index < remote.length; index += 1) {
    if (remote[index] !== local[index]) {
      throw new ReleaseVerificationError(
        "migration_ledger_drift",
        "Hosted migration ledger is not an exact source prefix",
      );
    }
  }
  return {
    applied: remote,
    pending: local.slice(remote.length),
  };
}

export function validateScenarioArtifact(
  artifact,
  expectedIds,
  releaseManifestHash,
) {
  const payload = verifyIntegrity(artifact, "scenario artifact");
  if (
    payload.schemaVersion !== 1 ||
    payload.releaseManifestHash !== releaseManifestHash ||
    !Array.isArray(payload.scenarios)
  ) {
    throw new ReleaseVerificationError(
      "invalid_scenario_artifact",
      "Scenario artifact identity is invalid",
    );
  }
  const ids = payload.scenarios.map((scenario) => scenario?.id);
  if (canonicalJson(ids) !== canonicalJson(expectedIds)) {
    throw new ReleaseVerificationError(
      "scenario_index_mismatch",
      "Scenario artifact does not contain the exact ordered scenario index",
    );
  }
  for (const scenario of payload.scenarios) {
    if (
      !["pass", "fail", "blocked"].includes(scenario.status) ||
      !["controlled", "deployed", "disposable"].includes(
        scenario.executionMode,
      ) ||
      !Array.isArray(scenario.checks) ||
      scenario.checks.length === 0 ||
      scenario.checks.some(
        (check) =>
          !check ||
          typeof check.name !== "string" ||
          !["pass", "fail", "blocked"].includes(check.status) ||
          (
            check.evidenceHash !== undefined &&
            !SHA256_PATTERN.test(check.evidenceHash)
          ),
      )
    ) {
      throw new ReleaseVerificationError(
        "invalid_scenario_result",
        `Scenario ${scenario.id} is not a bounded result`,
      );
    }
    if (
      scenario.status === "pass" &&
      scenario.checks.some((check) => check.status !== "pass")
    ) {
      throw new ReleaseVerificationError(
        "scenario_result_conflict",
        `Scenario ${scenario.id} cannot pass with a non-passing check`,
      );
    }
  }
  return payload;
}

export function validateRollbackBaseline(
  artifact,
  releaseManifestHash,
) {
  const payload = verifyIntegrity(artifact, "rollback baseline");
  if (
    payload.schemaVersion !== 1 ||
    payload.releaseManifestHash !== releaseManifestHash ||
    !UUID_PATTERN.test(String(payload.deploymentId)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(payload.imageDigest)) ||
    payload.serviceId !== RELEASE_TARGET.serviceId ||
    payload.environmentId !== RELEASE_TARGET.environmentId
  ) {
    throw new ReleaseVerificationError(
      "invalid_rollback_baseline",
      "Rollback baseline is incomplete or belongs to another release target",
    );
  }
  return payload;
}

export function validateSignoff(
  artifact,
  releaseManifestHash,
  allScenariosPass,
) {
  const payload = verifyIntegrity(artifact, "final signoff");
  const approved =
    payload.pm?.decision === "approve" &&
    payload.pm?.reviewerRole === "pm" &&
    payload.qa?.decision === "approve" &&
    payload.qa?.reviewerRole === "independent_qa" &&
    payload.qa?.independent === true;
  if (
    payload.schemaVersion !== 1 ||
    payload.releaseManifestHash !== releaseManifestHash ||
    !["shipped", "not_shipped"].includes(payload.sliceStatus) ||
    (
      payload.sliceStatus === "shipped" &&
      (!allScenariosPass || !approved)
    )
  ) {
    throw new ReleaseVerificationError(
      "invalid_signoff",
      "Final signoff is inconsistent with scenario results or independent review",
    );
  }
  return payload;
}
