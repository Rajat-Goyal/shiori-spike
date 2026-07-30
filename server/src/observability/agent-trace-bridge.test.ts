import { describe, expect, it, vi } from "vitest";
import {
  type AgentSpanLike,
  type AgentTraceLike,
  createAgentTraceBridge,
  type EmittedObservation,
  observationName,
  observationRequestFor,
  type ObservationRequest,
  orderedByDepth,
} from "./agent-trace-bridge.js";

function span(
  overrides: Partial<AgentSpanLike> & {
    spanData: AgentSpanLike["spanData"];
  },
): AgentSpanLike {
  return {
    endedAt: "2026-07-30T04:00:01.000Z",
    error: null,
    parentId: null,
    spanId: "span-1",
    startedAt: "2026-07-30T04:00:00.000Z",
    traceId: "trace-1",
    ...overrides,
  };
}

function trace(overrides: Partial<AgentTraceLike> = {}): AgentTraceLike {
  return {
    groupId: null,
    name: "shiori-bounded-decision",
    traceId: "trace-1",
    ...overrides,
  };
}

function recordingBridge() {
  const requests: ObservationRequest[] = [];
  const ends: Array<Date | undefined> = [];
  const propagated: unknown[] = [];
  let nextId = 0;
  const emit = (request: ObservationRequest): EmittedObservation => {
    requests.push(request);
    const id = `otel-${(nextId += 1)}`;
    return {
      end: (endTime) => ends.push(endTime),
      spanContext: () => id,
    };
  };
  const processor = createAgentTraceBridge({
    emit,
    propagate: (attributes, fn) => {
      propagated.push(attributes);
      return fn();
    },
    userId: "123456789",
  });
  return { ends, processor, propagated, requests };
}

describe("observationName", () => {
  it("uses verb-first names and keeps dynamic ids out", () => {
    expect(
      observationName(span({ spanData: { type: "response" } })),
    ).toBe("call-model");
    expect(
      observationName(span({ spanData: { type: "generation" } })),
    ).toBe("generate-decision");
    expect(
      observationName(
        span({ spanData: { name: "propose_draft_update", type: "function" } }),
      ),
    ).toBe("tool:propose_draft_update");
    // A response id must never reach the name; filters key on names.
    expect(
      observationName(
        span({ spanData: { response_id: "resp_abc123", type: "response" } }),
      ),
    ).not.toContain("resp_abc123");
  });
});

describe("observationRequestFor", () => {
  it("maps a response span to a generation with model and usage", () => {
    const request = observationRequestFor(
      span({
        spanData: {
          _response: { model: "gpt-test-model" },
          response_id: "resp_abc123",
          type: "response",
          usage: {
            cached_input_tokens: 5,
            input_tokens: 120,
            output_tokens: 30,
          },
        },
      }),
      "parent-context",
    );

    expect(request.asType).toBe("generation");
    expect(request.attributes.model).toBe("gpt-test-model");
    expect(request.attributes.usageDetails).toEqual({
      cache_read_input_tokens: 5,
      input: 120,
      output: 30,
    });
    expect(request.parentSpanContext).toBe("parent-context");
    expect(request.startTime).toEqual(
      new Date("2026-07-30T04:00:00.000Z"),
    );
    expect(
      (request.attributes.metadata as Record<string, unknown>).responseId,
    ).toBe("resp_abc123");
  });

  it("maps a function span to a tool carrying input and output", () => {
    const request = observationRequestFor(
      span({
        spanData: {
          input: '{"definitionOfDone":"x"}',
          name: "propose_draft_update",
          output: '{"accepted":false,"reason":"draft_target_invalid"}',
          type: "function",
        },
      }),
      undefined,
    );

    expect(request.asType).toBe("tool");
    expect(request.attributes.input).toBe('{"definitionOfDone":"x"}');
    expect(request.attributes.output).toContain("draft_target_invalid");
  });

  it("marks an errored span at ERROR level", () => {
    const request = observationRequestFor(
      span({
        error: { message: "execution_authority_mismatch" },
        spanData: { type: "agent" },
      }),
      undefined,
    );

    expect(request.attributes.level).toBe("ERROR");
    expect(request.attributes.statusMessage).toBe(
      "execution_authority_mismatch",
    );
  });

  it("does not invent usage or model on a non-generation span", () => {
    const request = observationRequestFor(
      span({ spanData: { name: "Shiori", type: "agent" } }),
      undefined,
    );

    expect(request.asType).toBe("agent");
    expect(request.attributes.model).toBeUndefined();
    expect(request.attributes.usageDetails).toBeUndefined();
  });
});

describe("orderedByDepth", () => {
  it("orders parents before children regardless of completion order", () => {
    // The SDK ends spans innermost-first, so arrival order is not tree order.
    const ordered = orderedByDepth([
      span({ parentId: "a", spanId: "c", spanData: { type: "function" } }),
      span({ parentId: null, spanId: "a", spanData: { type: "agent" } }),
      span({ parentId: "a", spanId: "b", spanData: { type: "response" } }),
    ]);

    expect(ordered.map((item) => item.spanId)).toEqual(["a", "c", "b"]);
  });

  it("treats a parent outside the trace as a root so the span still lands", () => {
    const ordered = orderedByDepth([
      span({ parentId: "missing", spanId: "x", spanData: { type: "agent" } }),
    ]);

    expect(ordered.map((item) => item.spanId)).toEqual(["x"]);
  });
});

describe("createAgentTraceBridge", () => {
  it("emits a root agent observation with every span nested under it", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace({ groupId: "session-42" }));
    await bridge.processor.onSpanEnd(
      span({ parentId: "root-a", spanId: "gen-b", spanData: { type: "response" } }),
    );
    await bridge.processor.onSpanEnd(
      span({ parentId: null, spanId: "root-a", spanData: { type: "agent" } }),
    );
    await bridge.processor.onTraceEnd(trace({ groupId: "session-42" }));

    expect(bridge.requests.map((r) => [r.name, r.asType])).toEqual([
      ["shiori-bounded-decision", "agent"],
      ["agent", "agent"],
      ["call-model", "generation"],
    ]);
    // The child attaches to its parent's context, not to the root.
    expect(bridge.requests[1]!.parentSpanContext).toBe("otel-1");
    expect(bridge.requests[2]!.parentSpanContext).toBe("otel-2");
  });

  it("propagates the session and user for conversation grouping", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace({ groupId: "session-42" }));
    await bridge.processor.onTraceEnd(trace({ groupId: "session-42" }));

    expect(bridge.propagated).toEqual([
      {
        metadata: { agentTraceId: "trace-1" },
        sessionId: "session-42",
        userId: "123456789",
      },
    ]);
  });

  it("omits the session when the run has no group", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace());
    await bridge.processor.onTraceEnd(trace());

    expect(bridge.propagated[0]).not.toHaveProperty("sessionId");
  });

  it("ends the root at the latest child end time", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace());
    await bridge.processor.onSpanEnd(
      span({
        endedAt: "2026-07-30T04:00:05.000Z",
        spanId: "a",
        spanData: { type: "agent" },
      }),
    );
    await bridge.processor.onTraceEnd(trace());

    expect(bridge.ends).toEqual([
      new Date("2026-07-30T04:00:05.000Z"),
      new Date("2026-07-30T04:00:05.000Z"),
    ]);
  });

  it("flushes a trace that never ended on shutdown", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace());
    await bridge.processor.onSpanEnd(
      span({ spanId: "a", spanData: { type: "agent" } }),
    );
    await bridge.processor.shutdown();

    expect(bridge.requests).toHaveLength(2);
  });

  it("reports rather than throws when emitting fails", async () => {
    const onError = vi.fn();
    const processor = createAgentTraceBridge({
      emit: () => {
        throw new Error("langfuse unavailable");
      },
      onError,
      propagate: (_attributes, fn) => fn(),
    });

    await processor.onTraceStart(trace());
    // Observability must never surface as an application failure.
    await expect(processor.onTraceEnd(trace())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("collapses the SDK task span that duplicates the trace", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace());
    // The SDK emits a root task span named for the trace, and the bridge already
    // emits a root for the trace itself. Keeping both double-represents one event.
    await bridge.processor.onSpanEnd(
      span({
        parentId: null,
        spanData: { name: "shiori-bounded-decision", type: "task" },
        spanId: "task-root",
      }),
    );
    await bridge.processor.onSpanEnd(
      span({
        parentId: "task-root",
        spanData: { name: "Shiori", type: "agent" },
        spanId: "agent-a",
      }),
    );
    await bridge.processor.onTraceEnd(trace());

    expect(bridge.requests.map((r) => r.name)).toEqual([
      "shiori-bounded-decision",
      "agent:Shiori",
    ]);
    // The child of the collapsed span is re-pointed at the root, not orphaned.
    expect(bridge.requests[1]!.parentSpanContext).toBe("otel-1");
  });

  it("keeps a task span that is not the trace itself", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace());
    await bridge.processor.onSpanEnd(
      span({
        parentId: null,
        spanData: { name: "some-other-task", type: "task" },
        spanId: "task-x",
      }),
    );
    await bridge.processor.onTraceEnd(trace());

    expect(bridge.requests.map((r) => r.name)).toEqual([
      "shiori-bounded-decision",
      "task:some-other-task",
    ]);
  });

  it("does not leak buffered spans across traces", async () => {
    const bridge = recordingBridge();
    await bridge.processor.onTraceStart(trace());
    await bridge.processor.onSpanEnd(
      span({ spanId: "a", spanData: { type: "agent" } }),
    );
    await bridge.processor.onTraceEnd(trace());
    const afterFirst = bridge.requests.length;

    await bridge.processor.onTraceStart(trace({ traceId: "trace-2" }));
    await bridge.processor.onTraceEnd(trace({ traceId: "trace-2" }));

    expect(bridge.requests.length - afterFirst).toBe(1);
  });
});
