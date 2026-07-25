#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertRedactedEvidence,
  BOUNDARY_IDS,
  canonicalJson,
  JOURNEY_IDS,
  parseEnvFile,
  parseMigrationList,
  readIntegrityJson,
  redactText,
  RELEASE_TARGET,
  ReleaseVerificationError,
  sensitiveValues,
  sha256,
  unexpectedGitChanges,
  validateMigrationLedger,
  validateRailwayStatus,
  validateReleaseEnvironment,
  validateRollbackBaseline,
  validateScenarioArtifact,
  validateSignoff,
  verifyIntegrity,
  withIntegrity,
  writeImmutableJson,
} from "./release-verifier-lib.mjs";

const ROOT = process.cwd();
const SUPABASE_CLI_VERSION = "2.109.1";
const TERMINAL_FAILURES = new Set([
  "CRASHED",
  "FAILED",
  "NEEDS_APPROVAL",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
]);
const REQUIRED_ASSESSMENT_HEADINGS = [
  "## Final assessment",
  "## Known limitations",
  "## Deviations",
  "## Rollback baseline",
];

function parseArgs(argv) {
  const options = {
    envFile: ".env.local",
    evidenceDir: "evidence/S01-12",
    executionMode: "production",
    phase: null,
    releaseManifest: null,
  };
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) {
      throw new ReleaseVerificationError(
        "invalid_argument",
        "Every verifier argument must use --name=value",
      );
    }
    switch (match[1]) {
      case "env-file":
        options.envFile = match[2];
        break;
      case "evidence-dir":
        options.evidenceDir = match[2];
        break;
      case "execution-mode":
        options.executionMode = match[2];
        break;
      case "phase":
        options.phase = match[2];
        break;
      case "release-manifest":
        options.releaseManifest = match[2];
        break;
      default:
        throw new ReleaseVerificationError(
          "invalid_argument",
          `Unknown verifier argument --${match[1]}`,
        );
    }
  }
  if (!["assess", "boundaries", "deploy", "journeys"].includes(options.phase)) {
    throw new ReleaseVerificationError(
      "invalid_phase",
      "Phase must be deploy, journeys, boundaries, or assess",
    );
  }
  if (!["production", "verify"].includes(options.executionMode)) {
    throw new ReleaseVerificationError(
      "invalid_execution_mode",
      "Execution mode must be production or verify",
    );
  }
  if (options.phase !== "deploy" && !options.releaseManifest) {
    throw new ReleaseVerificationError(
      "missing_release_manifest",
      "Post-deploy phases require --release-manifest",
    );
  }
  const canonicalEvidenceDirectory = path.resolve(
    ROOT,
    "evidence/S01-12",
  );
  if (
    path.resolve(ROOT, options.evidenceDir) !==
    canonicalEvidenceDirectory
  ) {
    throw new ReleaseVerificationError(
      "invalid_evidence_path",
      "Evidence directory must be evidence/S01-12",
    );
  }
  if (
    options.releaseManifest &&
    path.resolve(ROOT, options.releaseManifest) !==
      path.join(canonicalEvidenceDirectory, "release-manifest.json")
  ) {
    throw new ReleaseVerificationError(
      "invalid_manifest_path",
      "Release manifest must be evidence/S01-12/release-manifest.json",
    );
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: options.binary ? null : "utf8",
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new ReleaseVerificationError(
      "command_failed",
      `${options.label ?? command} failed without retaining command output`,
    );
  }
  return result.stdout;
}

function runJson(command, args, options = {}) {
  const output = run(command, args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new ReleaseVerificationError(
      "invalid_command_response",
      `${options.label ?? command} returned invalid structured output`,
    );
  }
}

function releaseEnvironment(environment) {
  return {
    ...process.env,
    ...environment,
    RAILWAY_AGENT_SESSION: "railway-skill-s01-12-release-verifier",
    RAILWAY_CALLER: "skill:use-railway@1.3.6",
  };
}

function requireCleanSource(allowedEvidenceDirectory = null) {
  const status = run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { label: "source cleanliness check" },
  );
  const allowedPrefix = allowedEvidenceDirectory
    ? `${path
        .relative(ROOT, path.resolve(allowedEvidenceDirectory))
        .replaceAll("\\", "/")}/`
    : null;
  const changes = unexpectedGitChanges(status, allowedPrefix);
  if (changes.length > 0) {
    throw new ReleaseVerificationError(
      "dirty_source",
      "Release source contains tracked or untracked changes",
    );
  }
  const commit = run("git", ["rev-parse", "HEAD"], {
    label: "source commit check",
  }).trim();
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], {
    label: "source tree check",
  }).trim();
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    !/^[0-9a-f]{40}$/.test(tree)
  ) {
    throw new ReleaseVerificationError(
      "invalid_source_identity",
      "Git source identity is invalid",
    );
  }
  const archive = run("git", ["archive", "--format=tar", "HEAD"], {
    binary: true,
    label: "release archive generation",
  });
  return {
    archiveSha256: sha256(archive),
    commit,
    dockerfileSha256: sha256(readFileSync("Dockerfile")),
    lockfileSha256: sha256(readFileSync("package-lock.json")),
    tree,
  };
}

function verifyRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const npmVersion = run("npm", ["--version"], {
    label: "npm version check",
  }).trim();
  const npmMajor = Number(npmVersion.split(".")[0]);
  const railwayVersion = run("railway", ["--version"], {
    label: "Railway CLI version check",
  }).trim();
  const supabaseVersion = run(
    "npx",
    ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, "--version"],
    { label: "Supabase CLI version check" },
  ).trim();
  if (nodeMajor !== 24 || !Number.isSafeInteger(npmMajor) || npmMajor < 11) {
    throw new ReleaseVerificationError(
      "runtime_mismatch",
      "Release verification requires Node 24 and npm 11 or newer",
    );
  }
  if (
    !/^railway \d+\.\d+\.\d+$/.test(railwayVersion) ||
    supabaseVersion !== SUPABASE_CLI_VERSION
  ) {
    throw new ReleaseVerificationError(
      "release_cli_mismatch",
      "Release CLI versions are invalid or unpinned",
    );
  }
  return {
    node: process.versions.node,
    npm: npmVersion,
    railway: railwayVersion.replace(/^railway /, ""),
    supabase: supabaseVersion,
  };
}

function migrationManifest() {
  const directory = path.join(ROOT, "supabase/migrations");
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (
    files.length === 0 ||
    files.some(
      (file) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(file),
    )
  ) {
    throw new ReleaseVerificationError(
      "invalid_migration_manifest",
      "Migration filenames are not an exact ordered manifest",
    );
  }
  return files.map((file) => ({
    file,
    sha256: sha256(readFileSync(path.join(directory, file))),
    version: file.slice(0, 14),
  }));
}

function railwayStatus(environment) {
  const status = runJson(
    "railway",
    [
      "status",
      "--project",
      RELEASE_TARGET.projectId,
      "--environment",
      RELEASE_TARGET.environmentId,
      "--json",
    ],
    {
      env: releaseEnvironment(environment),
      label: "Railway identity check",
    },
  );
  return validateRailwayStatus(status);
}

function migrationLedger(environment, manifest) {
  const output = run(
    "npx",
    [
      "--yes",
      `supabase@${SUPABASE_CLI_VERSION}`,
      "migration",
      "list",
      "--db-url",
      environment.SUPABASE_DATABASE_POOLER_URL,
    ],
    {
      env: releaseEnvironment(environment),
      label: "Supabase migration ledger check",
    },
  );
  return validateMigrationLedger(manifest, parseMigrationList(output));
}

function runRepositoryGates(environment) {
  const childEnvironment = releaseEnvironment(environment);
  run("npm", ["ci"], {
    env: childEnvironment,
    label: "clean dependency installation",
  });
  run(
    "npx",
    [
      "--yes",
      `supabase@${SUPABASE_CLI_VERSION}`,
      "db",
      "reset",
      "--local",
      "--no-seed",
    ],
    {
      env: childEnvironment,
      label: "disposable database migration check",
    },
  );
  const localStatus = runJson(
    "npx",
    [
      "--yes",
      `supabase@${SUPABASE_CLI_VERSION}`,
      "status",
      "--output",
      "json",
    ],
    {
      env: childEnvironment,
      label: "disposable database identity check",
    },
  );
  const localUrl = localStatus.API_URL;
  const localSecret =
    localStatus.SERVICE_ROLE_KEY ?? localStatus.SECRET_KEY;
  let parsedLocalUrl;
  try {
    parsedLocalUrl = new URL(localUrl);
  } catch {
    parsedLocalUrl = null;
  }
  if (
    !parsedLocalUrl ||
    !["127.0.0.1", "localhost"].includes(parsedLocalUrl.hostname) ||
    parsedLocalUrl.port !== "54321" ||
    typeof localSecret !== "string" ||
    localSecret.length < 16
  ) {
    throw new ReleaseVerificationError(
      "disposable_database_mismatch",
      "Disposable database did not resolve to the guarded local target",
    );
  }
  const localTestEnvironment = {
    ...childEnvironment,
    SHIORI_TEST_SUPABASE_PORT: "54321",
    SUPABASE_SECRET_KEY: localSecret,
    SUPABASE_URL: localUrl,
  };
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        "const url = process.env.SUPABASE_URL;",
        "const key = process.env.SUPABASE_SECRET_KEY;",
        "let ok = false;",
        "for (let attempt = 0; attempt < 20; attempt += 1) {",
        "  try {",
        "    const response = await fetch(`${url}/rest/v1/telegram_updates?select=update_id&limit=0`, {",
        "      headers: { apikey: key, authorization: `Bearer ${key}` },",
        "      signal: AbortSignal.timeout(1000),",
        "    });",
        "    if (response.ok) { ok = true; break; }",
        "  } catch {}",
        "  await new Promise((resolve) => setTimeout(resolve, 500));",
        "}",
        "if (!ok) process.exit(1);",
      ].join("\n"),
    ],
    {
      env: localTestEnvironment,
      label: "disposable database readiness check",
    },
  );
  run("npm", ["run", "test:db"], {
    env: localTestEnvironment,
    label: "database integration gate",
  });
  run("npm", ["run", "check"], {
    env: childEnvironment,
    label: "repository gate",
  });
}

function applyPendingMigrations(environment) {
  run(
    "npx",
    [
      "--yes",
      `supabase@${SUPABASE_CLI_VERSION}`,
      "db",
      "push",
      "--db-url",
      environment.SUPABASE_DATABASE_POOLER_URL,
      "--include-all",
      "--yes",
    ],
    {
      env: releaseEnvironment(environment),
      label: "approved Supabase migration application",
    },
  );
}

function latestDeployments(environment) {
  const value = runJson(
    "railway",
    [
      "deployment",
      "list",
      "--project",
      RELEASE_TARGET.projectId,
      "--environment",
      RELEASE_TARGET.environmentId,
      "--service",
      RELEASE_TARGET.serviceId,
      "--limit",
      "5",
      "--json",
    ],
    {
      env: releaseEnvironment(environment),
      label: "Railway deployment status check",
    },
  );
  return Array.isArray(value)
    ? value
    : Array.isArray(value?.deployments)
      ? value.deployments
      : [];
}

function deployRailway(environment, source, priorDeploymentId) {
  run(
    "railway",
    [
      "up",
      "--detach",
      "--json",
      "--project",
      RELEASE_TARGET.projectId,
      "--environment",
      RELEASE_TARGET.environmentId,
      "--service",
      RELEASE_TARGET.serviceId,
      "--message",
      `Release ${source.commit}`,
    ],
    {
      env: releaseEnvironment(environment),
      label: "Railway deployment",
    },
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = latestDeployments(environment).find(
      (deployment) => deployment?.id !== priorDeploymentId,
    );
    if (current?.status === "SUCCESS") {
      return current;
    }
    if (TERMINAL_FAILURES.has(current?.status)) {
      throw new ReleaseVerificationError(
        "deployment_failed",
        `Railway deployment reached terminal state ${current.status}`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
  }
  throw new ReleaseVerificationError(
    "deployment_timeout",
    "Railway deployment did not reach terminal success in time",
  );
}

async function healthCheck() {
  let response;
  try {
    response = await fetch(`${RELEASE_TARGET.publicOrigin}/api/health`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ReleaseVerificationError(
      "health_unavailable",
      "Public health check failed without retaining a response body",
    );
  }
  let validSchema = false;
  if (response.ok) {
    try {
      const body = await response.json();
      validSchema =
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        Object.keys(body).length === 1 &&
        body.status === "ok";
    } catch {
      validSchema = false;
    }
  }
  if (response.status !== 200 || !validSchema) {
    throw new ReleaseVerificationError(
      "health_invalid",
      "Public health check was not HTTP 200 with the bounded health schema",
    );
  }
  return { schemaValid: true, status: 200 };
}

function releaseManifestHash(manifest) {
  verifyIntegrity(manifest, "release manifest");
  return sha256(canonicalJson(manifest));
}

function verifyManifestIdentity(
  manifest,
  source,
  railway,
  ledger,
  config,
  runtime,
) {
  const payload = verifyIntegrity(manifest, "release manifest");
  const current = {
    configTargetHash: config.supabaseTargetHash,
    migrations: ledger.applied,
    railway,
    runtime,
    source,
  };
  const expected = {
    configTargetHash: payload.supabase.targetHash,
    migrations: payload.supabase.ledger,
    railway: payload.railway,
    runtime: payload.runtime,
    source: payload.source,
  };
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new ReleaseVerificationError(
      "release_identity_drift",
      "Current source, deployment, target, or migration identity drifted from the immutable release",
    );
  }
}

async function currentIdentity(environment, allowedEvidenceDirectory) {
  const config = validateReleaseEnvironment(environment);
  const runtime = verifyRuntime();
  const source = requireCleanSource(allowedEvidenceDirectory);
  const migrations = migrationManifest();
  const railway = railwayStatus(environment);
  const ledger = migrationLedger(environment, migrations);
  const health = await healthCheck();
  return { config, health, ledger, migrations, railway, runtime, source };
}

async function deployPhase(options, environment, secrets) {
  const config = validateReleaseEnvironment(environment);
  const runtime = verifyRuntime();
  const sourceBefore = requireCleanSource();
  const migrations = migrationManifest();
  const railwayBefore = railwayStatus(environment);
  const ledgerBefore = migrationLedger(environment, migrations);

  if (options.executionMode === "verify") {
    return {
      mode: "verify",
      pendingMigrations: ledgerBefore.pending.length,
      ready: true,
      sourceCommit: sourceBefore.commit,
    };
  }

  runRepositoryGates(environment);
  const sourceAfterGates = requireCleanSource();
  if (canonicalJson(sourceAfterGates) !== canonicalJson(sourceBefore)) {
    throw new ReleaseVerificationError(
      "source_drift",
      "Source identity changed during repository gates",
    );
  }
  if (ledgerBefore.pending.length > 0) {
    applyPendingMigrations(environment);
  }
  const ledgerAfter = migrationLedger(environment, migrations);
  if (ledgerAfter.pending.length > 0) {
    throw new ReleaseVerificationError(
      "migration_incomplete",
      "Hosted migration ledger is not exact after approved migration application",
    );
  }
  if (!railwayBefore.deploymentId || !railwayBefore.imageDigest) {
    throw new ReleaseVerificationError(
      "rollback_unavailable",
      "Existing dedicated deployment lacks an immutable rollback baseline",
    );
  }

  const deployed = deployRailway(
    environment,
    sourceBefore,
    railwayBefore.deploymentId,
  );
  const railwayAfter = railwayStatus(environment);
  if (
    railwayAfter.status !== "SUCCESS" ||
    railwayAfter.deploymentId !== deployed.id ||
    !railwayAfter.imageDigest
  ) {
    throw new ReleaseVerificationError(
      "deployment_identity_mismatch",
      "Terminal deployment does not match the dedicated Railway service",
    );
  }
  const health = await healthCheck();
  const sourceFinal = requireCleanSource();
  if (canonicalJson(sourceFinal) !== canonicalJson(sourceBefore)) {
    throw new ReleaseVerificationError(
      "source_drift",
      "Source identity changed during deployment",
    );
  }

  mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(
    options.evidenceDir,
    "release-manifest.json",
  );
  const manifest = writeImmutableJson(manifestPath, {
    createdAt: new Date().toISOString(),
    health,
    immutable: true,
    railway: railwayAfter,
    runtime,
    schemaVersion: 1,
    source: sourceBefore,
    supabase: {
      ledger: ledgerAfter.applied,
      manifest: migrations,
      targetHash: config.supabaseTargetHash,
    },
  });
  assertRedactedEvidence(manifest, secrets, "release manifest");
  const manifestHash = releaseManifestHash(manifest);
  writeImmutableJson(
    path.join(options.evidenceDir, "rollback-baseline.json"),
    {
      deploymentId: railwayBefore.deploymentId,
      environmentId: RELEASE_TARGET.environmentId,
      imageDigest: railwayBefore.imageDigest,
      releaseManifestHash: manifestHash,
      schemaVersion: 1,
      serviceId: RELEASE_TARGET.serviceId,
    },
  );
  return {
    deploymentId: railwayAfter.deploymentId,
    manifestHash,
    mode: "production",
    ready: true,
  };
}

function scanEvidenceDirectory(directory, secrets) {
  const scanned = [];
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const filePath = path.join(current, name);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        walk(filePath);
        continue;
      }
      const relative = path.relative(ROOT, filePath);
      if (
        !/\.(json|md|txt)$/i.test(name) ||
        name === "privacy-redaction-scan.json"
      ) {
        continue;
      }
      const content = readFileSync(filePath);
      const text = content.toString("utf8");
      assertRedactedEvidence(text, secrets, relative);
      if (name.endsWith(".json")) {
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          throw new ReleaseVerificationError(
            "invalid_evidence_json",
            `${relative} is invalid JSON`,
          );
        }
        assertRedactedEvidence(value, secrets, relative);
      }
      scanned.push({ path: relative, sha256: sha256(content) });
    }
  }
  walk(directory);
  return scanned;
}

async function postDeployPhase(options, environment, secrets) {
  const manifest = readIntegrityJson(
    options.releaseManifest,
    "release manifest",
  );
  assertRedactedEvidence(manifest, secrets, "release manifest");
  const hash = releaseManifestHash(manifest);
  const evidenceDirectory = path.dirname(options.releaseManifest);
  const identity = await currentIdentity(environment, evidenceDirectory);
  verifyManifestIdentity(
    manifest,
    identity.source,
    identity.railway,
    identity.ledger,
    identity.config,
    identity.runtime,
  );
  if (options.phase === "journeys") {
    const artifact = readIntegrityJson(
      path.join(evidenceDirectory, "scenarios-s01-s18.json"),
      "journey scenarios",
    );
    assertRedactedEvidence(artifact, secrets, "journey scenarios");
    const scenarios = validateScenarioArtifact(
      artifact,
      JOURNEY_IDS,
      hash,
    );
    if (scenarios.scenarios.some((scenario) => scenario.status !== "pass")) {
      throw new ReleaseVerificationError(
        "journey_failed",
        "One or more S1-S18 journeys did not pass",
      );
    }
    return { identityStable: true, scenarios: JOURNEY_IDS.length };
  }
  if (options.phase === "boundaries") {
    const artifact = readIntegrityJson(
      path.join(evidenceDirectory, "scenarios-s19-s28.json"),
      "boundary scenarios",
    );
    assertRedactedEvidence(artifact, secrets, "boundary scenarios");
    const scenarios = validateScenarioArtifact(
      artifact,
      BOUNDARY_IDS,
      hash,
    );
    if (scenarios.scenarios.some((scenario) => scenario.status !== "pass")) {
      throw new ReleaseVerificationError(
        "boundary_failed",
        "One or more S19-S28 boundaries did not pass",
      );
    }
    validateRollbackBaseline(
      readIntegrityJson(
        path.join(evidenceDirectory, "rollback-baseline.json"),
        "rollback baseline",
      ),
      hash,
    );
    return { identityStable: true, scenarios: BOUNDARY_IDS.length };
  }

  const journeys = validateScenarioArtifact(
    readIntegrityJson(
      path.join(evidenceDirectory, "scenarios-s01-s18.json"),
      "journey scenarios",
    ),
    JOURNEY_IDS,
    hash,
  );
  const boundaries = validateScenarioArtifact(
    readIntegrityJson(
      path.join(evidenceDirectory, "scenarios-s19-s28.json"),
      "boundary scenarios",
    ),
    BOUNDARY_IDS,
    hash,
  );
  validateRollbackBaseline(
    readIntegrityJson(
      path.join(evidenceDirectory, "rollback-baseline.json"),
      "rollback baseline",
    ),
    hash,
  );
  const assessmentPath = path.join(
    evidenceDirectory,
    "final-assessment.md",
  );
  const assessment = readFileSync(assessmentPath, "utf8");
  assertRedactedEvidence(assessment, secrets, "final assessment");
  if (
    REQUIRED_ASSESSMENT_HEADINGS.some(
      (heading) => !assessment.includes(heading),
    ) ||
    !/Slice status:\s*(?:shipped|not shipped)/i.test(assessment)
  ) {
    throw new ReleaseVerificationError(
      "invalid_assessment",
      "Final assessment is missing a required bounded section or status",
    );
  }
  const allScenariosPass = [...journeys.scenarios, ...boundaries.scenarios]
    .every((scenario) => scenario.status === "pass");
  const signoff = readIntegrityJson(
    path.join(evidenceDirectory, "final-signoff.json"),
    "final signoff",
  );
  assertRedactedEvidence(signoff, secrets, "final signoff");
  validateSignoff(signoff, hash, allScenariosPass);
  const scanned = scanEvidenceDirectory(evidenceDirectory, secrets);
  writeImmutableJson(
    path.join(evidenceDirectory, "privacy-redaction-scan.json"),
    {
      files: scanned,
      releaseManifestHash: hash,
      result: "pass",
      schemaVersion: 1,
    },
  );
  return {
    identityStable: true,
    redactionFiles: scanned.length,
    scenarios: JOURNEY_IDS.length + BOUNDARY_IDS.length,
    sliceStatus: signoff.sliceStatus,
  };
}

let failureSecrets = [];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let environment;
  try {
    environment = parseEnvFile(readFileSync(options.envFile, "utf8"));
  } catch (error) {
    if (error instanceof ReleaseVerificationError) {
      throw error;
    }
    throw new ReleaseVerificationError(
      "env_unavailable",
      "Release environment file could not be read",
    );
  }
  const secrets = sensitiveValues(environment);
  failureSecrets = secrets;
  const result =
    options.phase === "deploy"
      ? await deployPhase(options, environment, secrets)
      : await postDeployPhase(options, environment, secrets);
  assertRedactedEvidence(result, secrets, "verifier result");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      phase: options.phase,
      result,
    })}\n`,
  );
}

main().catch((error) => {
  const code =
    error instanceof ReleaseVerificationError
      ? error.code
      : "verification_failed";
  const message = redactText(
    error instanceof Error ? error.message : "Release verification failed",
    failureSecrets,
  );
  process.stderr.write(
    `${JSON.stringify({ error: code, message, ok: false })}\n`,
  );
  process.exitCode = 1;
});
