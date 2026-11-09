import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { InMemorySpanExporter, type TracerProvider } from "@opentelemetry/sdk-trace";
import { createApp } from "../../src/create-app";
import { startTracing, stopTracing } from "../../src/infrastructure/observability/tracing";
import { connectIsolatedDatabase } from "../support/database";

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;
let provider: TracerProvider;
const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  const database = await connectIsolatedDatabase("wagering_tracing_test");
  orm = database.orm;
  process.env.DATABASE_URL = database.url;
  process.env.LOG_LEVEL = "fatal";
  provider = startTracing(exporter);
  app = await createApp({ quiet: true });
  await app.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
  await stopTracing();
  await orm.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

describe("tracing", () => {
  test("a bet is one HTTP span with its database transaction inside", async () => {
    const playerId = randomUUID();
    const wallet = await post("/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
    await provider.forceFlush();
    exporter.reset();

    const bet = await post(
      "/wagering/transactions",
      {
        providerId: "provider-a",
        externalTransactionId: "trace-1",
        playerId,
        walletId: wallet.json.id,
        roundId: "r1",
        gameId: "g",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
      { "idempotency-key": "provider-a:trace-1" },
    );
    expect(bet.status).toBe(200);
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const http = spans.find((span) => span.name === "POST /wagering/transactions");
    if (!http) {
      throw new Error("the HTTP span was not exported");
    }
    expect(http.attributes["http.response.status_code"]).toBe(200);
    const database = spans.filter(
      (span) => span.name === "db.transaction" && span.parentSpanContext?.spanId === http.spanContext().spanId,
    );
    expect(database).toHaveLength(1);
    expect(database[0]?.spanContext().traceId).toBe(http.spanContext().traceId);
    expect(spans).toHaveLength(2);
  });

  test("health checks and metrics are not traced", async () => {
    exporter.reset();
    await fetch(`${baseUrl}/health/live`);
    await fetch(`${baseUrl}/health/ready`);
    await fetch(`${baseUrl}/metrics`);
    await provider.forceFlush();
    expect(exporter.getFinishedSpans().filter((span) => span.name.includes("/health") || span.name.includes("/metrics"))).toEqual([]);
  });
});
