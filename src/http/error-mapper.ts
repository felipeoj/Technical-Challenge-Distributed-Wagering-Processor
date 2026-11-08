import { HttpException } from "@nestjs/common";
import { DomainError, TransientInfrastructureError } from "../domain/errors";

export interface HttpErrorResponse {
  status: number;
  body: { error: { code: string; message: string } };
  retryAfterSeconds?: number;
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_MONEY: 400,
  INVALID_COMMAND: 400,
  INVALID_WAGER_TRANSACTION: 400,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  WALLET_NOT_FOUND: 422,
};

export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof TransientInfrastructureError) {
    return {
      status: 503,
      retryAfterSeconds: 1,
      body: { error: { code: error.code, message: "temporarily unavailable, retry the same request" } },
    };
  }
  if (error instanceof DomainError) {
    const status = STATUS_BY_CODE[error.code];
    if (status) {
      return { status, body: { error: { code: error.code, message: error.message } } };
    }
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, body: { error: { code: `HTTP_${status}`, message: error.message } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "unexpected error" } } };
}
