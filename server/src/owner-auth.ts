import {
  argon2Sync,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const SESSION_VERSION = "v1";
const SESSION_MAX_AGE_SECONDS = 4 * 60 * 60;

type ParsedPasswordHash = {
  expected: Buffer;
  memory: number;
  parallelism: number;
  passes: number;
  salt: Buffer;
};

function decodePhcBase64(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parsePasswordHash(phc: string): ParsedPasswordHash {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/_-]+)\$([A-Za-z0-9+/_-]+)$/.exec(
      phc,
    );

  if (!match) {
    throw new Error("DASHBOARD_PASSWORD_HASH is not a valid Argon2id PHC string");
  }

  const [, memoryValue, passesValue, parallelismValue, saltValue, expectedValue] =
    match;
  const parsed = {
    expected: decodePhcBase64(expectedValue),
    memory: Number(memoryValue),
    parallelism: Number(parallelismValue),
    passes: Number(passesValue),
    salt: decodePhcBase64(saltValue),
  };

  if (
    parsed.salt.length < 8 ||
    parsed.expected.length < 16 ||
    !Number.isSafeInteger(parsed.memory) ||
    parsed.memory < 8 * parsed.parallelism ||
    parsed.memory > 1_048_576 ||
    !Number.isSafeInteger(parsed.passes) ||
    parsed.passes < 1 ||
    parsed.passes > 10 ||
    !Number.isSafeInteger(parsed.parallelism) ||
    parsed.parallelism < 1 ||
    parsed.parallelism > 16
  ) {
    throw new Error("DASHBOARD_PASSWORD_HASH uses invalid Argon2id parameters");
  }

  return parsed;
}

export function createPasswordVerifier(
  passwordHash: string,
): (password: string) => boolean {
  const parsed = parsePasswordHash(passwordHash);

  return (password: string) => {
    const actual = argon2Sync("argon2id", {
      memory: parsed.memory,
      message: password,
      nonce: parsed.salt,
      parallelism: parsed.parallelism,
      passes: parsed.passes,
      tagLength: parsed.expected.length,
    });

    return timingSafeEqual(actual, parsed.expected);
  };
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export const ownerSession = {
  cookieName: "shiori_owner_session",
  maxAgeSeconds: SESSION_MAX_AGE_SECONDS,

  issue(secret: string, now: Date): string {
    const expiresAt = Math.floor(now.getTime() / 1_000) + SESSION_MAX_AGE_SECONDS;
    const value = `${SESSION_VERSION}.${expiresAt}`;
    return `${value}.${signature(value, secret)}`;
  },

  verify(token: string | undefined, secret: string, now: Date): boolean {
    if (!token) {
      return false;
    }

    const [version, expiresAtValue, actualSignature, ...remainder] = token.split(".");
    if (
      version !== SESSION_VERSION ||
      !expiresAtValue ||
      !actualSignature ||
      remainder.length > 0
    ) {
      return false;
    }

    const expiresAt = Number(expiresAtValue);
    const signedValue = `${version}.${expiresAtValue}`;

    return (
      Number.isSafeInteger(expiresAt) &&
      expiresAt > Math.floor(now.getTime() / 1_000) &&
      signaturesMatch(actualSignature, signature(signedValue, secret))
    );
  },
};

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    if (key === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return undefined;
}

type FailureWindow = {
  blockedUntil?: number;
  failures: number[];
};

export class LoginRateLimiter {
  readonly #attempts = new Map<string, FailureWindow>();
  readonly #limit: number;
  readonly #windowMilliseconds: number;

  constructor(limit = 5, windowMilliseconds = 60_000) {
    this.#limit = limit;
    this.#windowMilliseconds = windowMilliseconds;
  }

  isBlocked(key: string, now: Date): boolean {
    const entry = this.#attempts.get(key);
    if (!entry) {
      return false;
    }

    const timestamp = now.getTime();
    if (entry.blockedUntil && entry.blockedUntil > timestamp) {
      return true;
    }

    entry.failures = entry.failures.filter(
      (failure) => timestamp - failure < this.#windowMilliseconds,
    );
    entry.blockedUntil = undefined;

    if (entry.failures.length === 0) {
      this.#attempts.delete(key);
    }

    return false;
  }

  recordFailure(key: string, now: Date): void {
    const timestamp = now.getTime();
    const entry = this.#attempts.get(key) ?? { failures: [] };
    entry.failures = entry.failures.filter(
      (failure) => timestamp - failure < this.#windowMilliseconds,
    );
    entry.failures.push(timestamp);

    if (entry.failures.length >= this.#limit) {
      entry.blockedUntil = timestamp + this.#windowMilliseconds;
    }

    this.#attempts.set(key, entry);
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }
}
