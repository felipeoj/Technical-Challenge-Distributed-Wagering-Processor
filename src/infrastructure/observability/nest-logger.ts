import type { LoggerService } from "@nestjs/common";
import type { Logger } from "../../application/ports";

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info("nest", { message: String(message), context });
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn("nest", { message: String(message), context });
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error("nest", { message: String(message), context: context ?? trace });
  }

  debug(): void {}

  verbose(): void {}
}
