import { describe, expect, it, vi } from "vitest";
import {
  continuationActionReference,
  parseWorkSessionOutcome,
  type WorkSessionOutcomeRepository,
  type WorkSessionOutcomeResult,
  WorkSessionOutcomeService,
} from "./outcomes.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const continuationId = "22222222-2222-4222-8222-222222222222";

class Repository implements WorkSessionOutcomeRepository {
  result: WorkSessionOutcomeResult = {
    completed: true,
    kind: "done",
  };
  readonly commands: unknown[] = [];

  async resolve(command: unknown): Promise<WorkSessionOutcomeResult> {
    this.commands.push(command);
    return this.result;
  }
}

describe("work-session outcomes", () => {
  it("parses only strict opaque session actions", () => {
    expect(parseWorkSessionOutcome(`s:${sessionId}:1:more`)).toEqual({
      action: "more",
      sessionId,
      version: 1,
    });
    expect(parseWorkSessionOutcome(`s:${sessionId}:0:done`)).toBeNull();
    expect(parseWorkSessionOutcome(`s:${sessionId}:1:percent_50`))
      .toBeNull();
  });

  it("records partial work without a percentage and asks remaining duration", async () => {
    const repository = new Repository();
    repository.result = {
      completed: true,
      continuationId,
      continuationVersion: 1,
      kind: "more",
    };
    const service = new WorkSessionOutcomeService({ repository });

    const reply = await service.handle(
      71,
      123456789,
      `s:${sessionId}:1:more`,
    );

    expect(reply?.text).toBe(
      "Partial work recorded. How much focused time remains?",
    );
    expect(reply?.text).not.toMatch(/%|percent/i);
    expect(reply?.actions?.map((action) => action.text)).toEqual([
      "30 min",
      "60 min",
      "90 min",
      "120 min",
    ]);
  });

  it("records a missed session and requires explicit continuation opt-in", async () => {
    const repository = new Repository();
    repository.result = {
      completed: true,
      continuationId,
      continuationVersion: 1,
      kind: "missed",
    };
    const service = new WorkSessionOutcomeService({ repository });

    const reply = await service.handle(
      72,
      123456789,
      `s:${sessionId}:1:missed`,
    );

    expect(reply).toEqual({
      actions: [
        {
          callbackData: `c:${continuationId}:1:another`,
          text: "Find a time",
        },
        {
          callbackData: `c:${continuationId}:1:decline`,
          text: "Not now",
        },
      ],
      text:
        "No work recorded for this session. Would you like another work window?",
    });
  });

  it("returns no second reply for a replay and uncertainty on persistence failure", async () => {
    const repository = new Repository();
    repository.result = { kind: "replay" };
    const service = new WorkSessionOutcomeService({ repository });
    await expect(
      service.handle(73, 123456789, `s:${sessionId}:1:done`),
    ).resolves.toBeNull();

    repository.resolve = vi.fn(async () => {
      throw new Error("network");
    });
    await expect(
      service.handle(74, 123456789, `s:${sessionId}:1:done`),
    ).resolves.toMatchObject({
      text: expect.stringMatching(/check \/status/),
    });
  });

  it("rejects malformed continuation references", () => {
    expect(() =>
      continuationActionReference("not-a-uuid", 1, "another"),
    ).toThrow("Invalid continuation action reference");
  });
});
