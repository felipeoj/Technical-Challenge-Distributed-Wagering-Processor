import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";

let provider: TracerProvider | undefined;

export function startTracing(exporter: SpanExporter): TracerProvider {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "wagering-processor" }),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  return provider;
}

export function otlpTraceExporter(endpoint: string): SpanExporter {
  return new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
}

export async function stopTracing(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
  trace.disable();
  context.disable();
}
