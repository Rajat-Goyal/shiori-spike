/**
 * Bridges the OpenAI Agents SDK tracing contract onto Langfuse observations.
 *
 * `@openai/agents` 0.14.0 emits no OpenTelemetry, so a Langfuse span processor
 * alone sees nothing of an agent run. The SDK does expose its own processor
 * contract, and every span carries `traceId`, `spanId`, `parentId`, timestamps,
 * an error, and typed `spanData` including model and token usage. This
 * translates that tree into correctly typed Langfuse observations.
 *
 * Spans are buffered until the trace ends, then emitted parents-before-children
 * so each observation can be attached with an explicit `parentSpanContext`. The
 * SDK ends spans in completion order, which is not tree order, so emitting
 * eagerly would orphan children.
 */

export type AgentTraceLike = Readonly<{
  traceId: string;
  name: string;
  groupId: string | null;
  metadata?: Record<string, unknown>;
}>;

export type AgentSpanLike = Readonly<{
  traceId: string;
  spanId: string;
  parentId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: { message: string; data?: Record<string, unknown> } | null;
  spanData: Record<string, unknown> & { type: string };
}>;

/** Structural copy of the SDK's `TracingProcessor`. */
export interface AgentTracingProcessor {
  start?(): void;
  onTraceStart(trace: AgentTraceLike): Promise<void>;
  onTraceEnd(trace: AgentTraceLike): Promise<void>;
  onSpanStart(span: AgentSpanLike): Promise<void>;
  onSpanEnd(span: AgentSpanLike): Promise<void>;
  shutdown(timeout?: number): Promise<void>;
  forceFlush(): Promise<void>;
}

export type LangfuseObservationType =
  | "agent"
  | "generation"
  | "guardrail"
  | "span"
  | "tool";

export type EmittedObservation = Readonly<{
  end: (endTime?: Date) => void;
  spanContext: () => unknown;
}>;

export type ObservationRequest = Readonly<{
  attributes: Record<string, unknown>;
  asType: LangfuseObservationType;
  name: string;
  parentSpanContext?: unknown;
  startTime?: Date;
}>;

export type AgentTraceBridgeOptions = Readonly<{
  /** Creates one Langfuse observation. Injected so the tree logic is testable. */
  emit: (request: ObservationRequest) => EmittedObservation;
  onError?: (error: unknown) => void;
  /** Runs `fn` with trace-level attributes propagated onto every observation. */
  propagate: <T>(
    attributes: Readonly<{
      metadata?: Record<string, string>;
      sessionId?: string;
      userId?: string;
    }>,
    fn: () => T,
  ) => T;
  /** Stable identifier for the single configured owner. */
  userId?: string;
}>;

const OBSERVATION_TYPE: Readonly<Record<string, LangfuseObservationType>> = {
  agent: "agent",
  custom: "span",
  function: "tool",
  generation: "generation",
  guardrail: "guardrail",
  handoff: "span",
  mcp_tools: "tool",
  // A response span is the Responses API call itself: it carries the model and
  // usage, so Langfuse must see it as a generation for cost and token analytics.
  response: "generation",
  speech: "span",
  speech_group: "span",
  task: "span",
  transcription: "span",
  turn: "span",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function timeOf(value: string | null): Date | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Verb-first, dynamic-value-free observation names, per Langfuse naming
 * guidance: filters and evaluators key on the name, so ids must stay in
 * metadata.
 */
export function observationName(span: AgentSpanLike): string {
  const data = span.spanData;
  const type = data.type;
  const named = typeof data.name === "string" ? data.name : undefined;
  switch (type) {
    case "agent":
      return named ? `agent:${named}` : "agent";
    case "function":
      return named ? `tool:${named}` : "tool";
    case "generation":
      return "generate-decision";
    case "response":
      return "call-model";
    case "handoff":
      return "hand-off";
    case "guardrail":
      return named ? `guardrail:${named}` : "guardrail";
    case "turn":
      return "agent-turn";
    case "task":
      return named ? `task:${named}` : "task";
    default:
      return named ?? type;
  }
}

function usageDetails(
  data: Record<string, unknown>,
): Record<string, number> | undefined {
  const usage = asRecord(data.usage);
  if (!usage) {
    return undefined;
  }
  const input = positiveInteger(usage.input_tokens);
  const output = positiveInteger(usage.output_tokens);
  const cached = positiveInteger(usage.cached_input_tokens);
  const total = positiveInteger(usage.total_tokens);
  const details: Record<string, number> = {};
  if (input !== undefined) {
    details.input = input;
  }
  if (output !== undefined) {
    details.output = output;
  }
  if (cached !== undefined) {
    details.cache_read_input_tokens = cached;
  }
  if (total !== undefined) {
    details.total = total;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function modelOf(data: Record<string, unknown>): string | undefined {
  if (typeof data.model === "string" && data.model.length > 0) {
    return data.model;
  }
  const response = asRecord(data._response);
  return typeof response?.model === "string" ? response.model : undefined;
}

function inputOf(data: Record<string, unknown>): unknown {
  if (data.input !== undefined) {
    return data.input;
  }
  return data._input;
}

function outputOf(data: Record<string, unknown>): unknown {
  if (data.output !== undefined) {
    return data.output;
  }
  const response = asRecord(data._response);
  return response?.output ?? undefined;
}

/**
 * Metadata carries the identifiers and shape that must stay out of names and
 * out of input/output, per the Langfuse best-practice guidance.
 */
function metadataOf(span: AgentSpanLike): Record<string, unknown> {
  const data = span.spanData;
  const metadata: Record<string, unknown> = {
    agentSpanId: span.spanId,
    agentSpanType: data.type,
  };
  if (typeof data.agent_name === "string") {
    metadata.agentName = data.agent_name;
  }
  if (typeof data.turn === "number") {
    metadata.turn = data.turn;
  }
  if (typeof data.response_id === "string") {
    metadata.responseId = data.response_id;
  }
  if (Array.isArray(data.tools)) {
    metadata.tools = data.tools;
  }
  if (asRecord(data.model_config)) {
    metadata.modelConfig = data.model_config;
  }
  return metadata;
}

/**
 * True when a span merely re-states the trace itself.
 *
 * The SDK emits a root `task` span carrying the trace name, and the bridge
 * already emits a root observation for the trace. Keeping both double-represents
 * one event, which Langfuse guidance calls out explicitly: the duplicate node
 * adds a hop to every tree and splits the Agent Graph. Children of a skipped
 * span are re-attached to its parent.
 */
export function duplicatesTrace(
  span: AgentSpanLike,
  trace: AgentTraceLike,
): boolean {
  return (
    span.spanData.type === "task" &&
    span.parentId === null &&
    span.spanData.name === trace.name
  );
}

export function observationRequestFor(
  span: AgentSpanLike,
  parentSpanContext: unknown,
): ObservationRequest {
  const data = span.spanData;
  const asType = OBSERVATION_TYPE[data.type] ?? "span";
  const attributes: Record<string, unknown> = {
    metadata: metadataOf(span),
  };

  const input = inputOf(data);
  if (input !== undefined) {
    attributes.input = input;
  }
  const output = outputOf(data);
  if (output !== undefined) {
    attributes.output = output;
  }
  if (asType === "generation") {
    const model = modelOf(data);
    if (model !== undefined) {
      attributes.model = model;
    }
    const usage = usageDetails(data);
    if (usage !== undefined) {
      attributes.usageDetails = usage;
    }
  }
  if (span.error !== null) {
    attributes.level = "ERROR";
    attributes.statusMessage = span.error.message;
  }

  return {
    asType,
    attributes,
    name: observationName(span),
    ...(parentSpanContext === undefined ? {} : { parentSpanContext }),
    ...(timeOf(span.startedAt) === undefined
      ? {}
      : { startTime: timeOf(span.startedAt) }),
  };
}

/** Orders spans so every parent precedes its children. */
export function orderedByDepth(
  spans: readonly AgentSpanLike[],
): readonly AgentSpanLike[] {
  const byParent = new Map<string | null, AgentSpanLike[]>();
  const known = new Set(spans.map((span) => span.spanId));
  for (const span of spans) {
    // A parent outside this trace is treated as a root so the span still lands.
    const parent =
      span.parentId !== null && known.has(span.parentId)
        ? span.parentId
        : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(span);
    byParent.set(parent, siblings);
  }
  const ordered: AgentSpanLike[] = [];
  const walk = (parent: string | null): void => {
    for (const span of byParent.get(parent) ?? []) {
      ordered.push(span);
      walk(span.spanId);
    }
  };
  walk(null);
  return ordered;
}

export function createAgentTraceBridge(
  options: AgentTraceBridgeOptions,
): AgentTracingProcessor {
  const buffered = new Map<string, AgentSpanLike[]>();
  const traces = new Map<string, AgentTraceLike>();

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observability must never surface as an application failure.
    }
  };

  const flushTrace = (trace: AgentTraceLike): void => {
    const spans = buffered.get(trace.traceId) ?? [];
    buffered.delete(trace.traceId);
    traces.delete(trace.traceId);

    options.propagate(
      {
        metadata: { agentTraceId: trace.traceId },
        ...(trace.groupId ? { sessionId: trace.groupId } : {}),
        ...(options.userId ? { userId: options.userId } : {}),
      },
      () => {
        const root = options.emit({
          asType: "agent",
          attributes: {
            metadata: {
              agentTraceId: trace.traceId,
              ...(trace.metadata ?? {}),
            },
          },
          name: trace.name,
          ...(spans.length > 0 && timeOf(spans[0]!.startedAt)
            ? { startTime: timeOf(spans[0]!.startedAt) }
            : {}),
        });
        const contexts = new Map<string, unknown>();
        let latest: Date | undefined;

        for (const span of orderedByDepth(spans)) {
          const parentContext =
            span.parentId !== null && contexts.has(span.parentId)
              ? contexts.get(span.parentId)
              : root.spanContext();
          const endedAt = timeOf(span.endedAt);
          if (endedAt && (latest === undefined || endedAt > latest)) {
            latest = endedAt;
          }
          if (duplicatesTrace(span, trace)) {
            // Re-point children at the root so the subtree is preserved.
            contexts.set(span.spanId, parentContext);
            continue;
          }
          const emitted = options.emit(
            observationRequestFor(span, parentContext),
          );
          contexts.set(span.spanId, emitted.spanContext());
          emitted.end(endedAt);
        }
        root.end(latest);
      },
    );
  };

  return {
    async onTraceStart(trace) {
      traces.set(trace.traceId, trace);
    },
    async onTraceEnd(trace) {
      try {
        flushTrace(trace);
      } catch (error) {
        report(error);
      }
    },
    async onSpanStart() {
      // Nothing to do: spans are emitted once complete so timings and usage are
      // final and the parent tree is fully known.
    },
    async onSpanEnd(span) {
      const spans = buffered.get(span.traceId) ?? [];
      spans.push(span);
      buffered.set(span.traceId, spans);
    },
    async shutdown() {
      for (const trace of [...traces.values()]) {
        try {
          flushTrace(trace);
        } catch (error) {
          report(error);
        }
      }
      buffered.clear();
    },
    async forceFlush() {
      // Export batching is owned by the Langfuse span processor.
    },
  };
}
