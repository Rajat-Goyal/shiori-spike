import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

const ENVELOPE_SCHEMA = "shiori.agent.ephemeral.v1";
const MAX_PLAINTEXT_BYTES = 128_000;

export type AgentStateBinding =
  | Readonly<{
      chatId: number;
      sessionId: string;
      type: "session_turn";
      updateId: number;
    }>
  | Readonly<{
      chatId: number;
      draftId: string;
      draftVersion: number;
      sessionId: string;
      toolName: "execute_commitment";
      type: "pending_approval";
    }>;

type SealedEnvelope = Readonly<{
  ciphertext: string;
  nonce: string;
  schema: typeof ENVELOPE_SCHEMA;
  tag: string;
}>;

export type AgentSessionCipher = Readonly<{
  open(sealed: string, binding: AgentStateBinding): string;
  seal(plaintext: string, binding: AgentStateBinding): string;
}>;

function canonicalRootSecret(value: string): Buffer {
  const strict =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!strict.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid agent session root secret");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length < 32 ||
    decoded.toString("base64") !== value
  ) {
    throw new Error("Invalid agent session root secret");
  }
  return decoded;
}

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string") {
    throw new Error(`Invalid sealed agent ${label}`);
  }
  const strict =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!strict.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid sealed agent ${label}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`Invalid sealed agent ${label}`);
  }
  return decoded;
}

function additionalData(binding: AgentStateBinding): Buffer {
  return Buffer.from(
    JSON.stringify({
      ...binding,
      schema: ENVELOPE_SCHEMA,
    }),
  );
}

function parseEnvelope(value: string): SealedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid sealed agent envelope");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("Invalid sealed agent envelope");
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(",") !==
      "ciphertext,nonce,schema,tag" ||
    envelope.schema !== ENVELOPE_SCHEMA
  ) {
    throw new Error("Invalid sealed agent envelope");
  }
  return envelope as SealedEnvelope;
}

export function createAgentSessionCipher(
  dashboardSessionSecret: string,
  randomBytes: (size: number) => Buffer = nodeRandomBytes,
): AgentSessionCipher {
  const root = canonicalRootSecret(dashboardSessionSecret);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      root,
      Buffer.from(ENVELOPE_SCHEMA),
      Buffer.from("ephemeral-session-state"),
      32,
    ),
  );

  return {
    open(sealed, binding) {
      const envelope = parseEnvelope(sealed);
      const nonce = canonicalBase64(envelope.nonce, "nonce");
      const tag = canonicalBase64(envelope.tag, "tag");
      const ciphertext = canonicalBase64(
        envelope.ciphertext,
        "ciphertext",
      );
      if (
        nonce.length !== 12 ||
        tag.length !== 16 ||
        ciphertext.length > MAX_PLAINTEXT_BYTES
      ) {
        throw new Error("Invalid sealed agent envelope");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: 16,
        });
        decipher.setAAD(additionalData(binding));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("Agent session authentication failed");
      }
    },
    seal(plaintext, binding) {
      const value = Buffer.from(plaintext, "utf8");
      if (value.length === 0 || value.length > MAX_PLAINTEXT_BYTES) {
        throw new Error("Invalid agent session plaintext");
      }
      const nonce = randomBytes(12);
      if (nonce.length !== 12) {
        throw new Error("Invalid agent session nonce");
      }
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: 16,
      });
      cipher.setAAD(additionalData(binding));
      const ciphertext = Buffer.concat([
        cipher.update(value),
        cipher.final(),
      ]);
      return JSON.stringify({
        ciphertext: ciphertext.toString("base64"),
        nonce: nonce.toString("base64"),
        schema: ENVELOPE_SCHEMA,
        tag: cipher.getAuthTag().toString("base64"),
      } satisfies SealedEnvelope);
    },
  };
}
