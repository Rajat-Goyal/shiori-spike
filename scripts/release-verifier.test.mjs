import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRedactedEvidence,
  BOUNDARY_IDS,
  canonicalJson,
  JOURNEY_IDS,
  parseEnvFile,
  parseMigrationList,
  redactText,
  RELEASE_TARGET,
  validateMigrationLedger,
  validateRailwayStatus,
  validateReleaseEnvironment,
  validateRollbackBaseline,
  validateScenarioArtifact,
  validateSignoff,
  verifyIntegrity,
  withIntegrity,
  writeImmutableJson,
  unexpectedGitChanges,
} from "./release-verifier-lib.mjs";

const deploymentId = "11111111-1111-4111-8111-111111111111";
const imageDigest = `sha256:${"a".repeat(64)}`;
const releaseManifestHash = "b".repeat(64);
const migrationVersions = ["20260725010000", "20260725020000"];

function migrationManifest() {
  return migrationVersions.map((version) => ({
    file: `${version}_migration.sql`,
    sha256: "d".repeat(64),
    version,
  }));
}

function migrationJson(rows) {
  return JSON.stringify({
    migrations: rows,
    message: "Migrations listed",
  });
}

function railwayFixture({
  domain = RELEASE_TARGET.domain,
  projectId = RELEASE_TARGET.projectId,
  replicas = 1,
  serviceId = RELEASE_TARGET.serviceId,
} = {}) {
  return {
    environments: {
      edges: [
        {
          node: {
            id: RELEASE_TARGET.environmentId,
            serviceInstances: {
              edges: [
                {
                  node: {
                    domains: {
                      serviceDomains: [{ domain }],
                    },
                    environmentId: RELEASE_TARGET.environmentId,
                    latestDeployment: {
                      id: deploymentId,
                      meta: {
                        imageDigest,
                        serviceManifest: {
                          deploy: { numReplicas: replicas },
                        },
                      },
                      status: "SUCCESS",
                    },
                    serviceId,
                  },
                },
              ],
            },
          },
        },
      ],
    },
    id: projectId,
  };
}

function releaseEnvironment(overrides = {}) {
  return {
    DASHBOARD_PASSWORD_HASH: "$argon2id$v=19$safe",
    DASHBOARD_SESSION_SECRET: "safe-session-secret",
    GOOGLE_OAUTH_CLIENT_ID: "safe-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "safe-client-secret",
    GOOGLE_OWNER_EMAIL: "owner@example.invalid",
    GOOGLE_TOKEN_ENCRYPTION_KEY: "safe-encryption-key",
    GOOGLE_TOKEN_KEY_VERSION: "1",
    OPENAI_API_KEY: "safe-openai-key",
    OPENAI_MODEL: "gpt-test",
    OPENAI_PROMPT_VERSION: "prompt-v1",
    OWNER_TIME_ZONE: "Asia/Singapore",
    PUBLIC_APP_BASE_URL: RELEASE_TARGET.publicOrigin,
    RAILWAY_ENVIRONMENT_ID: RELEASE_TARGET.environmentId,
    RAILWAY_PROJECT_ID: RELEASE_TARGET.projectId,
    RAILWAY_SERVICE_ID: RELEASE_TARGET.serviceId,
    SUPABASE_DATABASE_POOLER_URL:
      "postgresql://postgres.abcdefghijklmnopqrst:pass@aws-0.pooler.supabase.com:6543/postgres",
    SUPABASE_SECRET_KEY: "safe-supabase-secret",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    TELEGRAM_BOT_TOKEN: "123456:safe-bot-token",
    TELEGRAM_OWNER_USER_ID: "123456789",
    TELEGRAM_WEBHOOK_SECRET: "safe-webhook",
    ...overrides,
  };
}

function scenarioArtifact(ids, status = "pass") {
  return withIntegrity({
    releaseManifestHash,
    scenarios: ids.map((id) => ({
      checks: [
        {
          evidenceHash: "c".repeat(64),
          name: `${id} bounded oracle`,
          status,
        },
      ],
      executionMode:
        id === "S19" || id === "S27" ? "controlled" : "deployed",
      id,
      status,
    })),
    schemaVersion: 1,
  });
}

test("canonical integrity detects any retained-artifact drift", () => {
  const artifact = withIntegrity({ a: 1, nested: { b: true } });
  assert.deepEqual(verifyIntegrity(artifact), {
    a: 1,
    nested: { b: true },
  });
  artifact.nested.b = false;
  assert.throws(
    () => verifyIntegrity(artifact),
    (error) => error.code === "integrity_drift",
  );
  assert.equal(
    canonicalJson({ b: 2, a: 1 }),
    canonicalJson({ a: 1, b: 2 }),
  );
});

test("immutable artifacts are created once and never overwritten", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-verifier-"));
  const file = path.join(directory, "artifact.json");
  writeImmutableJson(file, { schemaVersion: 1 });
  assert.equal(
    verifyIntegrity(JSON.parse(readFileSync(file, "utf8"))).schemaVersion,
    1,
  );
  assert.throws(
    () => writeImmutableJson(file, { schemaVersion: 2 }),
    (error) => error.code === "artifact_exists",
  );
});

test("environment validation pins the dedicated target and refuses legacy", () => {
  const result = validateReleaseEnvironment(releaseEnvironment());
  assert.match(result.supabaseTargetHash, /^[0-9a-f]{64}$/);
  assert.throws(
    () =>
      validateReleaseEnvironment(
        releaseEnvironment({
          RAILWAY_SERVICE_ID: RELEASE_TARGET.legacyServiceId,
        }),
      ),
    (error) => error.code === "legacy_service_refused",
  );
  assert.throws(
    () =>
      validateReleaseEnvironment(
        releaseEnvironment({
          PUBLIC_APP_BASE_URL: "https://wrong.example.invalid",
        }),
      ),
    (error) => error.code === "target_identity_mismatch",
  );
});

test("Railway identity accepts only the exact domain and one replica", () => {
  assert.deepEqual(validateRailwayStatus(railwayFixture()), {
    deploymentId,
    domain: RELEASE_TARGET.domain,
    environmentId: RELEASE_TARGET.environmentId,
    imageDigest,
    projectId: RELEASE_TARGET.projectId,
    replicas: 1,
    serviceId: RELEASE_TARGET.serviceId,
    status: "SUCCESS",
  });
  assert.throws(
    () =>
      validateRailwayStatus(
        railwayFixture({ serviceId: RELEASE_TARGET.legacyServiceId }),
      ),
    (error) => error.code === "legacy_service_refused",
  );
  assert.throws(
    () => validateRailwayStatus(railwayFixture({ replicas: 2 })),
    (error) => error.code === "railway_replica_mismatch",
  );
  assert.throws(
    () =>
      validateRailwayStatus(
        railwayFixture({ domain: "wrong.up.railway.app" }),
      ),
    (error) => error.code === "railway_domain_mismatch",
  );
});

test("migration parser accepts the pinned CLI JSON exact ledger", () => {
  const parsed = parseMigrationList(
    migrationJson(
      migrationVersions.map((version) => ({
        local: version,
        remote: version,
        time: version,
      })),
    ),
  );
  assert.deepEqual(parsed, {
    local: migrationVersions,
    remote: migrationVersions,
  });
  assert.deepEqual(validateMigrationLedger(migrationManifest(), parsed), {
    applied: migrationVersions,
    pending: [],
  });
});

test("migration parser preserves a pending remote prefix", () => {
  const parsed = parseMigrationList(
    migrationJson([
      {
        local: migrationVersions[0],
        remote: migrationVersions[0],
        time: "2026-07-25 01:00:00",
      },
      {
        local: migrationVersions[1],
        remote: "",
        time: "2026-07-25 02:00:00",
      },
    ]),
  );
  assert.deepEqual(validateMigrationLedger(migrationManifest(), parsed), {
    applied: [migrationVersions[0]],
    pending: [migrationVersions[1]],
  });
});

test("migration parser retains the legacy ASCII pipe table", () => {
  const parsed = parseMigrationList(`
      LOCAL          | REMOTE         | TIME
      ----------------|----------------|----------
      20260725010000 | 20260725010000 | 2026-07-25
      20260725020000 |                | 2026-07-25
  `);
  assert.deepEqual(validateMigrationLedger(migrationManifest(), parsed), {
    applied: ["20260725010000"],
    pending: ["20260725020000"],
  });
});

test("migration parser rejects malformed or mixed JSON", () => {
  for (const output of [
    '{"migrations":[',
    `${migrationJson([])}\nLOCAL | REMOTE | TIME`,
  ]) {
    assert.throws(
      () => parseMigrationList(output),
      (error) => error.code === "invalid_migration_output",
    );
  }
});

test("migration parser rejects rows with missing or malformed fields", () => {
  for (const row of [
    {
      local: migrationVersions[0],
      remote: migrationVersions[0],
    },
    {
      local: "2026072501000",
      remote: migrationVersions[0],
      time: "2026-07-25",
    },
    {
      local: migrationVersions[0],
      remote: migrationVersions[1],
      time: "2026-07-25",
    },
    {
      local: migrationVersions[0],
      remote: migrationVersions[0],
      time: "2026-07-25",
      unexpected: true,
    },
  ]) {
    assert.throws(
      () => parseMigrationList(migrationJson([row])),
      (error) => error.code === "invalid_migration_output",
    );
  }
});

test("migration parser rejects duplicate and out-of-order rows", () => {
  const row = (version) => ({
    local: version,
    remote: version,
    time: version,
  });
  for (const rows of [
    [row(migrationVersions[0]), row(migrationVersions[0])],
    [row(migrationVersions[1]), row(migrationVersions[0])],
  ]) {
    assert.throws(
      () => parseMigrationList(migrationJson(rows)),
      (error) => error.code === "invalid_migration_output",
    );
  }
});

test("migration parser rejects unrelated JSON and ledger drift", () => {
  for (const output of [
    JSON.stringify({ status: "ok" }),
    JSON.stringify([]),
    JSON.stringify({
      migrations: [],
      message: "Migrations listed",
      status: "ok",
    }),
  ]) {
    assert.throws(
      () => parseMigrationList(output),
      (error) => error.code === "invalid_migration_output",
    );
  }
  assert.throws(
    () =>
      validateMigrationLedger(migrationManifest(), {
        local: migrationVersions,
        remote: ["20260725020000"],
      }),
    (error) => error.code === "migration_ledger_drift",
  );
  assert.throws(
    () =>
      validateMigrationLedger(migrationManifest(), {
        local: ["20260725010000"],
        remote: ["20260725010000"],
      }),
    (error) => error.code === "migration_cli_drift",
  );
});

test("redaction rejects configured values, generic credentials, identities, and raw fields", () => {
  assert.throws(
    () =>
      assertRedactedEvidence(
        { safe: "configured-sensitive-value" },
        ["configured-sensitive-value"],
      ),
    (error) => error.code === "sensitive_value",
  );
  assert.throws(
    () => assertRedactedEvidence({ ownerEmail: "redacted" }),
    (error) => error.code === "forbidden_evidence_field",
  );
  assert.throws(
    () => assertRedactedEvidence({ safe: "person@example.com" }),
    (error) => error.code === "sensitive_pattern",
  );
  assert.throws(
    () => assertRedactedEvidence({ safe: "/Users/local-owner/project" }),
    (error) => error.code === "sensitive_pattern",
  );
  assert.throws(
    () => assertRedactedEvidence({ responseBody: { status: "ok" } }),
    (error) => error.code === "forbidden_evidence_field",
  );
  assert.equal(
    redactText(
      "failure for person@example.com using sb_secret_abcdefgh at /Users/local-owner/project",
    ),
    "failure for [REDACTED] using [REDACTED] at /[REDACTED]/project",
  );
});

test("scenario artifacts require exact S1-S18 and S19-S28 indices", () => {
  assert.equal(
    validateScenarioArtifact(
      scenarioArtifact(JOURNEY_IDS),
      JOURNEY_IDS,
      releaseManifestHash,
    ).scenarios.length,
    18,
  );
  assert.equal(
    validateScenarioArtifact(
      scenarioArtifact(BOUNDARY_IDS),
      BOUNDARY_IDS,
      releaseManifestHash,
    ).scenarios.length,
    10,
  );
  assert.throws(
    () =>
      validateScenarioArtifact(
        scenarioArtifact(JOURNEY_IDS.slice(0, -1)),
        JOURNEY_IDS,
        releaseManifestHash,
      ),
    (error) => error.code === "scenario_index_mismatch",
  );
  const conflicting = scenarioArtifact(JOURNEY_IDS);
  conflicting.scenarios[0].checks[0].status = "fail";
  const { integrity: _integrity, ...conflictingPayload } = conflicting;
  const resignedConflict = withIntegrity(conflictingPayload);
  assert.throws(
    () =>
      validateScenarioArtifact(
        resignedConflict,
        JOURNEY_IDS,
        releaseManifestHash,
      ),
  );
});

test("rollback and independent signoff stay bound to one release hash", () => {
  const rollback = withIntegrity({
    deploymentId,
    environmentId: RELEASE_TARGET.environmentId,
    imageDigest,
    releaseManifestHash,
    schemaVersion: 1,
    serviceId: RELEASE_TARGET.serviceId,
  });
  assert.equal(
    validateRollbackBaseline(rollback, releaseManifestHash).deploymentId,
    deploymentId,
  );
  const signoff = withIntegrity({
    pm: { decision: "approve", reviewerRole: "pm" },
    qa: {
      decision: "approve",
      independent: true,
      reviewerRole: "independent_qa",
    },
    releaseManifestHash,
    schemaVersion: 1,
    sliceStatus: "shipped",
  });
  assert.equal(
    validateSignoff(signoff, releaseManifestHash, true).sliceStatus,
    "shipped",
  );
  assert.throws(
    () => validateSignoff(signoff, releaseManifestHash, false),
    (error) => error.code === "invalid_signoff",
  );
});

test("environment parser never interpolates or executes values", () => {
  assert.deepEqual(
    parseEnvFile(
      "SAFE=value\nQUOTED='literal $HOME value'\n# comment\n",
    ),
    {
      QUOTED: "literal $HOME value",
      SAFE: "value",
    },
  );
});

test("post-deploy evidence may be untracked without masking source drift", () => {
  const status = [
    "?? evidence/S01-12/release-manifest.json",
    "?? evidence/S01-12/scenarios-s01-s18.json",
  ].join("\0");
  assert.deepEqual(
    unexpectedGitChanges(status, "evidence/S01-12"),
    [],
  );
  assert.deepEqual(
    unexpectedGitChanges(
      `${status}\0 M server/src/app.ts\0`,
      "evidence/S01-12",
    ),
    [" M server/src/app.ts"],
  );
  assert.deepEqual(
    unexpectedGitChanges(
      " M evidence/S01-12/release-manifest.json\0",
      "evidence/S01-12",
    ),
    [" M evidence/S01-12/release-manifest.json"],
  );
});

test("CLI failure output never contains configured values", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-env-"));
  const envFile = path.join(directory, ".env.release");
  const configuredSecret = "do-not-print-this-secret";
  const configuredIdentity = "private-owner@example.com";
  const environment = releaseEnvironment({
    GOOGLE_OWNER_EMAIL: configuredIdentity,
    RAILWAY_SERVICE_ID: RELEASE_TARGET.legacyServiceId,
    SUPABASE_SECRET_KEY: configuredSecret,
  });
  writeFileSync(
    envFile,
    `${Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );

  const result = spawnSync(
    process.execPath,
    [
      "scripts/verify-release.mjs",
      `--env-file=${envFile}`,
      "--phase=deploy",
      "--execution-mode=verify",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, new RegExp(configuredSecret));
  assert.doesNotMatch(result.stderr, new RegExp(configuredIdentity));
  assert.match(result.stderr, /legacy_service_refused/);
});
