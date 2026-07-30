import { describe, expect, it } from "vitest";
import { failureChain, failureFrames } from "./failure-chain.js";

class SupabaseReadError extends Error {}

describe("failureChain", () => {
  it("names an error and every wrapped cause outermost first", () => {
    const root = new SupabaseReadError("read failed");
    const middle = new Error("Conversation read failed", { cause: root });
    const outer = new Error("Telegram processing failed", {
      cause: middle,
    });

    expect(failureChain(outer)).toEqual([
      "Error",
      "Error",
      "SupabaseReadError",
    ]);
  });

  it("prefers an explicit error name over the constructor name", () => {
    const aborted = new Error("aborted");
    aborted.name = "TimeoutError";

    expect(failureChain(aborted)).toEqual(["TimeoutError"]);
  });

  it("never includes a message, so owner text and secrets cannot leak", () => {
    const secret = "owner-text-and-bot-token";
    const chain = failureChain(
      new Error("outer", { cause: new Error(secret) }),
    );

    expect(chain.join(" ")).not.toContain(secret);
  });

  it("bounds the walked chain", () => {
    let error = new Error("root");
    for (let depth = 0; depth < 10; depth += 1) {
      error = new Error(`wrap-${depth}`, { cause: error });
    }

    expect(failureChain(error, 3)).toHaveLength(3);
  });

  it("stops on a cyclic cause instead of looping forever", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(failureChain(first)).toEqual(["Error", "Error"]);
  });

  it("reports a bounded name for a non-error throw", () => {
    expect(failureChain("a thrown string")).toEqual(["UnknownFailure"]);
    expect(failureChain(undefined)).toEqual(["UnknownFailure"]);
  });
});

describe("failureFrames", () => {
  it("keeps stack frames and drops the message header line", () => {
    const secret = "private-owner-text";
    const frames = failureFrames(new Error(secret));

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.startsWith("at "))).toBe(true);
    expect(frames.join(" ")).not.toContain(secret);
  });

  it("bounds the frame count", () => {
    expect(failureFrames(new Error("boom"), 2)).toHaveLength(2);
  });

  it("returns nothing for a non-error throw or a stackless error", () => {
    const stackless = new Error("boom");
    Reflect.deleteProperty(stackless, "stack");
    Object.defineProperty(stackless, "stack", { value: undefined });

    expect(failureFrames("a thrown string")).toEqual([]);
    expect(failureFrames(stackless)).toEqual([]);
  });
});
