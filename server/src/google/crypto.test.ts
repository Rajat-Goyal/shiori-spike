import { describe, expect, it } from "vitest";
import {
  decodeGoogleEncryptionKey,
  decryptSecret,
  digest,
  encryptSecret,
  pkceChallenge,
  randomOpaqueValue,
} from "./crypto.js";

const key = Buffer.alloc(32, 23);
const context = {
  email: "owner@example.com",
  keyVersion: 3,
  ownerReference: "owner",
  purpose: "refresh_token" as const,
};

describe("Google credential crypto", () => {
  it("creates an authenticated AES-256-GCM envelope with fresh bounded metadata", () => {
    const first = encryptSecret({
      ...context,
      key,
      plaintext: "private-refresh-token",
      randomBytes: () => Buffer.alloc(12, 1),
    });
    const second = encryptSecret({
      ...context,
      key,
      plaintext: "private-refresh-token",
      randomBytes: () => Buffer.alloc(12, 2),
    });

    expect(first).toMatchObject({
      keyVersion: 3,
      nonce: Buffer.alloc(12, 1).toString("base64"),
    });
    expect(Buffer.from(first.tag, "base64")).toHaveLength(16);
    expect(first.ciphertext).not.toContain("private-refresh-token");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(
      decryptSecret(first, {
        ...context,
        key,
      }),
    ).toBe("private-refresh-token");
  });

  it.each([
    { email: "other@example.com" },
    { ownerReference: "other-owner" },
    { purpose: "pkce_verifier" as const },
    { keyVersion: 4 },
  ])("authenticates AAD context $email$ownerReference$purpose$keyVersion", (change) => {
    const encrypted = encryptSecret({
      ...context,
      key,
      plaintext: "private-refresh-token",
      randomBytes: () => Buffer.alloc(12, 3),
    });

    expect(() =>
      decryptSecret(encrypted, {
        ...context,
        ...change,
        key,
      }),
    ).toThrow(/Google credential/);
  });

  it("rejects tampering in every authenticated envelope field", () => {
    const encrypted = encryptSecret({
      ...context,
      key,
      plaintext: "private-refresh-token",
      randomBytes: () => Buffer.alloc(12, 3),
    });
    const mutate = (value: string) =>
      `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

    for (const changed of [
      { ...encrypted, ciphertext: mutate(encrypted.ciphertext) },
      { ...encrypted, nonce: mutate(encrypted.nonce) },
      { ...encrypted, tag: mutate(encrypted.tag) },
    ]) {
      expect(() =>
        decryptSecret(changed, {
          ...context,
          key,
        }),
      ).toThrow(/encrypted Google|Google credential/);
    }
  });

  it("rejects malformed, empty, or wrongly-sized envelope fields", () => {
    const encrypted = encryptSecret({
      ...context,
      key,
      plaintext: "private-refresh-token",
      randomBytes: () => Buffer.alloc(12, 4),
    });

    for (const malformed of [
      { ...encrypted, ciphertext: "" },
      { ...encrypted, ciphertext: "not-base64" },
      { ...encrypted, nonce: Buffer.alloc(11).toString("base64") },
      { ...encrypted, nonce: "not-base64" },
      { ...encrypted, tag: Buffer.alloc(15).toString("base64") },
      { ...encrypted, tag: "not-base64" },
    ]) {
      expect(() =>
        decryptSecret(malformed, {
          ...context,
          key,
        }),
      ).toThrow(/encrypted Google|Google credential/);
    }
  });

  it("strictly decodes only a canonical 32-byte encryption key", () => {
    expect(
      decodeGoogleEncryptionKey(Buffer.alloc(32, 9).toString("base64")),
    ).toEqual(Buffer.alloc(32, 9));

    for (const invalid of [
      "not-base64",
      Buffer.alloc(31, 9).toString("base64"),
      `${Buffer.alloc(32, 9).toString("base64")}=`,
    ]) {
      expect(() => decodeGoogleEncryptionKey(invalid)).toThrow(
        "Invalid encrypted Google key",
      );
    }
  });

  it("derives PKCE S256 and opaque digests without retaining source values", () => {
    const verifier =
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(pkceChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(digest("private-session")).not.toContain("private-session");
    expect(
      randomOpaqueValue(32, () => Buffer.alloc(32, 7)),
    ).toBe(Buffer.alloc(32, 7).toString("base64url"));
  });
});
