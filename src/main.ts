import "reflect-metadata";
import { createApp } from "./create-app";
import { loadEnv } from "./config/env";
import { otlpTraceExporter, startTracing } from "./infrastructure/observability/tracing";
import { startWorkers } from "./workers";

async function bootstrap() {
  const env = loadEnv();
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    startTracing(otlpTraceExporter(env.OTEL_EXPORTER_OTLP_ENDPOINT));
  }
  const app = await createApp();
  await app.listen(env.PORT);
  startWorkers(app);
}

bootstrap();
