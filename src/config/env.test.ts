import { describe, expect, test } from "bun:test";
import { loadEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://wagering:wagering@localhost:5433/wagering",
  AWS_REGION: "us-east-1",
  AWS_ENDPOINT_URL: "http://localhost:4566",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  SQS_TRANSACTIONS_QUEUE_URL: "http://localhost:4566/000000000000/wager-transactions.fifo",
  SQS_TRANSACTIONS_DLQ_URL: "http://localhost:4566/000000000000/wager-transactions-dlq.fifo",
  SQS_EVENTS_QUEUE_URL: "http://localhost:4566/000000000000/wager-events.fifo",
};

describe("loadEnv", () => {
  test("applies defaults for PORT and LOG_LEVEL", () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  test("coerces PORT from a string", () => {
    expect(loadEnv({ ...valid, PORT: "8080" }).PORT).toBe(8080);
  });

  test("fails fast when a required variable is missing", () => {
    const { DATABASE_URL: _removed, ...incomplete } = valid;
    expect(() => loadEnv(incomplete)).toThrow(/DATABASE_URL/);
  });

  test("rejects a malformed queue URL", () => {
    expect(() => loadEnv({ ...valid, SQS_EVENTS_QUEUE_URL: "not-a-url" })).toThrow(
      /SQS_EVENTS_QUEUE_URL/,
    );
  });
});
