import { z } from "zod";
import { InvalidCommandError } from "../../domain/errors";
import { hasNullByte, safeText } from "./safe-text";

const MAX_KEY_LENGTH = 200;

const envelopeSchema = z.object({
  messageId: safeText(200),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

export interface WagerMessage {
  messageId: string;
  idempotencyKey: string;
  data: Record<string, unknown>;
}

function fieldNames(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join(".") || "body"))].join(", ");
}

export function parseWagerMessage(body: string | undefined): WagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    throw new InvalidCommandError("message body is not valid JSON");
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidCommandError(`invalid fields: ${fieldNames(parsed.error)}`);
  }
  const { messageId, data } = parsed.data;
  const explicit = typeof data.idempotencyKey === "string" ? data.idempotencyKey.trim() : "";
  const fallback =
    typeof data.providerId === "string" && typeof data.externalTransactionId === "string"
      ? `${data.providerId}:${data.externalTransactionId}`
      : "";
  const idempotencyKey = explicit || fallback;
  if (!idempotencyKey || idempotencyKey.length > MAX_KEY_LENGTH || hasNullByte(idempotencyKey)) {
    throw new InvalidCommandError("invalid fields: idempotencyKey");
  }
  return { messageId, idempotencyKey, data };
}
