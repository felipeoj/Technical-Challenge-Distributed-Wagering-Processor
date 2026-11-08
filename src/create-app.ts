import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { NEST_LOGGER } from "./app.tokens";
import type { NestLoggerAdapter } from "./infrastructure/observability/nest-logger";

export async function createApp(options: { quiet?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, options.quiet ? { logger: false } : { bufferLogs: true });
  if (!options.quiet) {
    app.useLogger(app.get<NestLoggerAdapter>(NEST_LOGGER));
  }
  app.enableShutdownHooks();
  return app;
}
