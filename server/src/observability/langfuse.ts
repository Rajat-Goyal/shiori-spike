import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  startObservation,
} from "@langfuse/tracing";
import { getGlobalTraceProvider } from "@openai/agents-core";
import {
  type AgentTracingProcessor,
  createAgentTraceBridge,
  type EmittedObservation,
  type ObservationRequest,
} from "./agent-trace-bridge.js";
import { failureChain, failureFrames } from "../failure-chain.js";

export type LangfuseTracingOptions = Readonly<{
  baseUrl?: string;
  environment: string;
  onError?: (event: LangfuseTracingFailureEvent) => void;
  publicKey: string;
  release?: string;
  secretKey: string;
  userId?: string;
}>;

export type LangfuseTracingFailureEvent = Readonly<{
  event: "langfuse_tracing_failed";
  failureChain: readonly string[];
  failureFrames: readonly string[];
  operation: "emit" | "shutdown";
}>;

export type LangfuseTracing = Readonly<{
  processor: AgentTracingProcessor;
  shutdown: () => Promise<void>;
}>;

/**
 * Starts OpenTelemetry with the Langfuse span processor and registers the
 * Agents SDK bridge.
 *
 * Must run before the first agent run so the global trace provider already has
 * the processor attached.
 */
export function startLangfuseTracing(
  options: LangfuseTracingOptions,
): LangfuseTracing {
  const report = (
    operation: LangfuseTracingFailureEvent["operation"],
    error: unknown,
  ): void => {
    try {
      options.onError?.({
        event: "langfuse_tracing_failed",
        failureChain: failureChain(error),
        failureFrames: failureFrames(error),
        operation,
      });
    } catch {
      // Observability must never surface as an application failure.
    }
  };

  const spanProcessor = new LangfuseSpanProcessor({
    environment: options.environment,
    publicKey: options.publicKey,
    secretKey: options.secretKey,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.release ? { release: options.release } : {}),
  });
  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();

  const emit = (request: ObservationRequest): EmittedObservation => {
    const observation = startObservation(
      request.name,
      request.attributes as never,
      {
        asType: request.asType,
        ...(request.parentSpanContext === undefined
          ? {}
          : { parentSpanContext: request.parentSpanContext as never }),
        ...(request.startTime === undefined
          ? {}
          : { startTime: request.startTime }),
      } as never,
    );
    return {
      end: (endTime) => observation.end(endTime),
      spanContext: () => observation.otelSpan.spanContext(),
    };
  };

  const processor = createAgentTraceBridge({
    emit,
    onError: (error) => report("emit", error),
    propagate: (attributes, fn) => propagateAttributes(attributes, fn),
    ...(options.userId ? { userId: options.userId } : {}),
  });

  // setProcessors, not registerProcessor: the default OpenAI exporter would
  // otherwise also ship traces to OpenAI, which is outside the data boundary.
  getGlobalTraceProvider().setProcessors([processor as never]);

  return {
    processor,
    shutdown: async () => {
      try {
        await processor.shutdown();
        await spanProcessor.forceFlush();
        await sdk.shutdown();
      } catch (error) {
        report("shutdown", error);
      }
    },
  };
}
