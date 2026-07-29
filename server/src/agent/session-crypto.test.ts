import { describe, expect, it } from "vitest";
import { createAgentSessionCipher } from "./session-crypto.js";

const secret = Buffer.alloc(32, 41).toString("base64");
const sessionBinding = {
  chatId: 123,
  sessionId: "session-1",
  type: "session_turn",
  updateId: 42,
} as const;

describe("agent session cipher", () => {
  it("round-trips bounded ephemeral state", () => {
    const cipher = createAgentSessionCipher(
      secret,
      () => Buffer.alloc(12, 7),
    );
    const sealed = cipher.seal("private recent turn", sessionBinding);

    expect(sealed).not.toContain("private recent turn");
    expect(cipher.open(sealed, sessionBinding)).toBe(
      "private recent turn",
    );
  });

  it("binds ciphertext to its exact owner session and update", () => {
    const cipher = createAgentSessionCipher(
      secret,
      () => Buffer.alloc(12, 8),
    );
    const sealed = cipher.seal("private recent turn", sessionBinding);

    expect(() =>
      cipher.open(sealed, { ...sessionBinding, updateId: 43 })
    ).toThrow("Agent session authentication failed");
  });

  it("fails closed after secret rotation or envelope tampering", () => {
    const cipher = createAgentSessionCipher(
      secret,
      () => Buffer.alloc(12, 9),
    );
    const sealed = cipher.seal("pending run", sessionBinding);
    const rotated = createAgentSessionCipher(
      Buffer.alloc(32, 42).toString("base64"),
    );

    expect(() => rotated.open(sealed, sessionBinding)).toThrow(
      "Agent session authentication failed",
    );
    expect(() =>
      cipher.open(`${sealed.slice(0, -2)}xx`, sessionBinding)
    ).toThrow(/Invalid sealed agent/);
  });

  it("rejects invalid roots and unbounded plaintext", () => {
    expect(() => createAgentSessionCipher("not-base64")).toThrow(
      "Invalid agent session root secret",
    );
    const cipher = createAgentSessionCipher(secret);
    expect(() => cipher.seal("", sessionBinding)).toThrow(
      "Invalid agent session plaintext",
    );
    expect(() =>
      cipher.seal("x".repeat(128_001), sessionBinding)
    ).toThrow("Invalid agent session plaintext");
  });
});
