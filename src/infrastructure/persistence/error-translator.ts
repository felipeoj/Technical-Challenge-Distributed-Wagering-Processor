import { DomainError, TransientInfrastructureError } from "../../domain/errors";

const TRANSIENT_SQLSTATES = new Set(["55P03", "40001", "40P01", "57014", "57P01", "53300"]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof TransientInfrastructureError) {
    return error;
  }
  const code = (error as { code?: string } | undefined)?.code;
  if (code && (TRANSIENT_SQLSTATES.has(code) || (code.startsWith("08") && code !== "08P01") || TRANSIENT_NETWORK_CODES.has(code))) {
    return new TransientInfrastructureError(`database temporarily unavailable (${code})`, { cause: error });
  }
  return error;
}
