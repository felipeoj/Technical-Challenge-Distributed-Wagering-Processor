import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from "@nestjs/common";
import { LOGGER } from "../app.tokens";
import type { Logger } from "../application/ports";
import { toHttpError } from "./error-mapper";

interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ErrorResponse>();
    const mapped = toHttpError(exception);
    if (mapped.status === 500) {
      this.logger.error("unhandled_error", {
        errorName: exception instanceof Error ? exception.name : typeof exception,
        message: exception instanceof Error ? exception.message : undefined,
      });
    }
    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json(mapped.body);
  }
}
