#!/usr/bin/env node
/**
 * Seeds Shiori's agent prompts into Langfuse.
 *
 * Run once when setting up the application against a fresh Langfuse project:
 *
 *   node --env-file=.env.local scripts/seed-langfuse-prompts.mjs
 *   node --env-file=.env.local scripts/seed-langfuse-prompts.mjs --check
 *
 * Idempotent. Langfuse prompts are append-only versions, so this creates a new
 * version only when the text actually differs from the current labelled one.
 * Re-running with unchanged source is a no-op and does not inflate the version
 * history.
 *
 * The in-code templates in server/src/agent/instructions.ts are the seed and the
 * runtime fallback. Once seeded, Langfuse is the source of truth: edit there and
 * promote the label rather than editing code.
 */
import { LangfuseClient } from "@langfuse/client";
import {
  AGENT_PROMPT_NAMES,
  FALLBACK_INSTRUCTION_TEMPLATES,
  REQUIRED_PROMPT_VARIABLES,
} from "../server/src/agent/instructions.ts";

const LABEL = process.env.LANGFUSE_PROMPT_LABEL ?? "production";
const CHECK_ONLY = process.argv.includes("--check");

function requireEnv(key) {
  const value = process.env[key]?.trim();
  if (!value || /^<.*>$/.test(value)) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return value;
}

requireEnv("LANGFUSE_PUBLIC_KEY");
requireEnv("LANGFUSE_SECRET_KEY");

const client = new LangfuseClient();
const names = Object.values(AGENT_PROMPT_NAMES);
let created = 0;
let unchanged = 0;
let drifted = 0;

for (const name of names) {
  const template = FALLBACK_INSTRUCTION_TEMPLATES[name];

  // Guard the seed itself: a template that lost a placeholder would be published
  // and then rejected at boot by the prompt store, which is a confusing failure.
  const absent = REQUIRED_PROMPT_VARIABLES[name].filter(
    (variable) => !template.includes(`{{${variable}}}`),
  );
  if (absent.length > 0) {
    console.error(
      `${name}: source template is missing required variables: ${absent.join(", ")}`,
    );
    process.exit(1);
  }

  let current;
  try {
    current = await client.prompt.get(name, {
      cacheTtlSeconds: 0,
      label: LABEL,
    });
  } catch {
    current = undefined;
  }

  if (current?.prompt === template) {
    unchanged += 1;
    console.log(`${name}: unchanged (v${current.version}, label ${LABEL})`);
    continue;
  }

  if (CHECK_ONLY) {
    drifted += 1;
    console.log(
      current === undefined
        ? `${name}: MISSING in Langfuse`
        : `${name}: DIFFERS from Langfuse v${current.version}`,
    );
    continue;
  }

  const published = await client.prompt.create({
    labels: [LABEL],
    name,
    prompt: template,
    type: "text",
  });
  created += 1;
  console.log(
    `${name}: published v${published.version} with label ${LABEL}`,
  );
}

console.log(
  CHECK_ONLY
    ? `\nchecked ${names.length}: ${unchanged} unchanged, ${drifted} needing seed`
    : `\nseeded ${names.length}: ${created} published, ${unchanged} unchanged`,
);

if (CHECK_ONLY && drifted > 0) {
  process.exit(1);
}
