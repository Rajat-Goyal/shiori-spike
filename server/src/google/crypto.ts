import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";

export type EncryptedSecret = Readonly<{
  ciphertext: string;
  keyVersion: number;
  nonce: string;
  tag: string;
}>;

type SecretContext = Readonly<{
  email: string;
  keyVersion: number;
  ownerReference: string;
  purpose: "pkce_verifier" | "refresh_token";
}>;

type EncryptSecretOptions = SecretContext &
  Readonly<{
    key: Buffer;
    plaintext: string;
    randomBytes?: (size: number) => Buffer;
  }>;

function aad(context: SecretContext): Buffer {
  return Buffer.from(
    JSON.stringify({
      email: context.email,
      keyVersion: context.keyVersion,
      ownerReference: context.ownerReference,
      purpose: context.purpose,
      schema: "shiori.google.secret.v1",
    }),
  );
}

function canonicalBase64(value: string, label: string): Buffer {
  const strict =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!strict.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid encrypted Google ${label}`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`Invalid encrypted Google ${label}`);
  }
  return decoded;
}

export function decodeGoogleEncryptionKey(value: string): Buffer {
  const key = canonicalBase64(value, "key");
  if (key.length !== 32) {
    throw new Error("Invalid encrypted Google key");
  }
  return key;
}

export function encryptSecret(
  options: EncryptSecretOptions,
): EncryptedSecret {
  if (options.key.length !== 32) {
    throw new Error("Invalid Google encryption key");
  }
  const nonce = (options.randomBytes ?? nodeRandomBytes)(12);
  if (nonce.length !== 12) {
    throw new Error("Invalid Google encryption nonce");
  }

  const cipher = createCipheriv("aes-256-gcm", options.key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad(options));
  const ciphertext = Buffer.concat([
    cipher.update(options.plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    keyVersion: options.keyVersion,
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  options: SecretContext & Readonly<{ key: Buffer }>,
): string {
  if (
    options.key.length !== 32 ||
    encrypted.keyVersion !== options.keyVersion
  ) {
    throw new Error("Google credential key version is unavailable");
  }
  const nonce = canonicalBase64(encrypted.nonce, "nonce");
  const tag = canonicalBase64(encrypted.tag, "tag");
  const ciphertext = canonicalBase64(encrypted.ciphertext, "ciphertext");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid encrypted Google credential");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", options.key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(options));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Google credential authentication failed");
  }
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function pkceChallenge(verifier: string): string {
  return digest(verifier);
}

export function randomOpaqueValue(
  size = 32,
  randomBytes: (size: number) => Buffer = nodeRandomBytes,
): string {
  return randomBytes(size).toString("base64url");
}
