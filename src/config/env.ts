import { z } from "zod";

// Validated once at startup: a missing or malformed variable fails fast
// with a readable message instead of breaking later at an unrelated place.
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.string().url(),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_TRANSACTIONS_QUEUE_URL: z.string().url(),
  SQS_TRANSACTIONS_DLQ_URL: z.string().url(),
  SQS_EVENTS_QUEUE_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return parsed.data;
}
