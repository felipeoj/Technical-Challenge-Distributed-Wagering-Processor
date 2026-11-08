import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { IntegrationEvent } from "../../src/domain/messaging/events/integration-event";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { PrometheusMetrics } from "../../src/infrastructure/observability/prometheus-metrics";
import { OutboxPublisher } from "../../src/infrastructure/sqs/outbox-publisher";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { connectIsolatedDatabase, run } from "../support/database";
import { env, purgeAll, queues, receiveAll, sqs } from "../support/queues";
import { TestClock } from "../support/test-clock";

let orm: MikroORM;
let databaseUrl: string;
let uow: MikroOrmUnitOfWork;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;
let publisher: OutboxPublisher;
const clock = new TestClock();
const metrics = new PrometheusMetrics();

class TestEvent extends IntegrationEvent<{ n: number }> {
  readonly eventType = "TestEvent";
  readonly version = 1;

  static make(aggregateId: string): TestEvent {
    return new TestEvent({
      eventId: randomUUID(),
      aggregateId,
      correlationId: randomUUID(),
      occurredAt: new Date(),
      data: { n: 1 },
    });
  }
}

beforeAll(async () => {
  ({ orm, url: databaseUrl } = await connectIsolatedDatabase("wagering_outbox_test"));
  uow = new MikroOrmUnitOfWork(orm);
  openWallet = new OpenWallet(uow, clock);
  processWager = new ProcessWagerTransaction(uow, clock);
  publisher = new OutboxPublisher(uow, sqs, queues.events, clock, { logger: silentLogger(), metrics });
});

afterAll(async () => {
  await orm.close();
});

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop };
}

async function pendingCount(): Promise<number> {
  const [row] = await run<{ total: string }>(orm, "select count(*)::text as total from outbox_message where published_at is null");
  return Number(row?.total ?? 0);
}

async function totalCount(): Promise<number> {
  const [row] = await run<{ total: string }>(orm, "select count(*)::text as total from outbox_message");
  return Number(row?.total ?? 0);
}

async function seed(bets: number): Promise<number> {
  const before = await totalCount();
  const wallet = await openWallet.execute({ playerId: randomUUID(), initialBalance: { amount: "1000.00", currency: "BRL" } });
  for (let index = 0; index < bets; index += 1) {
    await processWager.execute(
      {
        providerId: "provider-a",
        externalTransactionId: randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "game",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
      { idempotencyKey: randomUUID() },
    );
  }
  return (await totalCount()) - before;
}

async function freshState() {
  await run(orm, "update outbox_message set published_at = now() where published_at is null");
  await purgeAll();
}

async function spawnFixture(point: "before_send" | "after_send"): Promise<number> {
  const script = new URL("../fixtures/crashing-publisher.ts", import.meta.url).pathname;
  const process = Bun.spawn(["bun", script, point], {
    env: { ...Bun.env, DATABASE_URL: databaseUrl },
    stdout: "ignore",
    stderr: "ignore",
  });
  return process.exited;
}

const eventIds = async () => (await receiveAll(queues.events)).map((message) => JSON.parse(message.Body ?? "{}").eventId as string);

describe("publishing", () => {
  test("publishes committed events to the events queue and marks them published", async () => {
    await freshState();
    const created = await seed(3);
    expect(await pendingCount()).toBe(created);

    expect(await publisher.publishBatch(100)).toBe(created);
    expect(await pendingCount()).toBe(0);

    const messages = await receiveAll(queues.events);
    expect(messages).toHaveLength(created);
    const bodies = messages.map((message) => JSON.parse(message.Body ?? "{}"));
    expect(new Set(bodies.map((body) => body.eventId)).size).toBe(created);
    expect(new Set(bodies.map((body) => body.eventType))).toEqual(
      new Set(["WalletBalanceChanged", "WagerTransactionProcessed"]),
    );
    const balanceChange = bodies.find((body) => body.eventType === "WalletBalanceChanged");
    expect(balanceChange.data.money.amount).toMatch(/^[0-9]+\.[0-9]{2}$/);
    expect(typeof balanceChange.data.walletVersion).toBe("number");

    expect(await publisher.publishBatch(100)).toBe(0);
  });

  test("events of an open transaction are never published before its commit", async () => {
    await freshState();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = uow.run(async (repositories) => {
      await repositories.outbox.add(OutboxMessage.enqueue(TestEvent.make(randomUUID())));
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await publisher.publishBatch(100)).toBe(0);
    expect(await receiveAll(queues.events, { rounds: 2 })).toHaveLength(0);

    release();
    await open;
    expect(await publisher.publishBatch(100)).toBe(1);
    expect(await receiveAll(queues.events)).toHaveLength(1);
  });

  test("a rolled back transaction leaves nothing to publish", async () => {
    await freshState();
    await expect(
      uow.run(async (repositories) => {
        await repositories.outbox.add(OutboxMessage.enqueue(TestEvent.make(randomUUID())));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await publisher.publishBatch(100)).toBe(0);
    expect(await receiveAll(queues.events, { rounds: 2 })).toHaveLength(0);
  });
});

describe("concurrent publishers", () => {
  test("several publishers share the pending events and each event is published once", async () => {
    await freshState();
    const created = await seed(10);
    const publishers = Array.from({ length: 4 }, () => new OutboxPublisher(uow, sqs, queues.events, clock));

    const published = await Promise.all(publishers.map((instance) => instance.publishBatch(5)));
    let total = published.reduce((sum, count) => sum + count, 0);
    for (let guard = 0; guard < 10 && (await pendingCount()) > 0; guard += 1) {
      const more = await Promise.all(publishers.map((instance) => instance.publishBatch(5)));
      total += more.reduce((sum, count) => sum + count, 0);
    }

    expect(total).toBe(created);
    expect(await pendingCount()).toBe(0);
    const ids = await eventIds();
    expect(ids).toHaveLength(created);
    expect(new Set(ids).size).toBe(created);
  });
});

describe("failures", () => {
  test("when SQS is unreachable the events stay pending and are retried with backoff", async () => {
    await freshState();
    const created = await seed(2);
    const broken = new OutboxPublisher(
      uow,
      createSqsClient({ ...env, AWS_ENDPOINT_URL: "http://127.0.0.1:1" }),
      queues.events,
      clock,
    );

    expect(await broken.publishBatch(100)).toBe(0);
    expect(await pendingCount()).toBe(created);
    const [attempt] = await run<{ attempts: number; next: Date }>(
      orm,
      "select attempts, next_attempt_at as next from outbox_message where published_at is null limit 1",
    );
    expect(attempt?.attempts).toBe(1);
    expect(Number.isNaN(new Date(String(attempt?.next)).getTime())).toBe(false);

    expect(await publisher.publishBatch(100)).toBe(0);
    clock.advance(2_000);
    expect(await publisher.publishBatch(100)).toBe(created);
    expect(await pendingCount()).toBe(0);
    expect(await receiveAll(queues.events)).toHaveLength(created);
  });

  test("the outbox lag metric grows while events wait and drops after publishing", async () => {
    await freshState();
    await seed(1);
    clock.advance(1_000);
    const broken = new OutboxPublisher(
      uow,
      createSqsClient({ ...env, AWS_ENDPOINT_URL: "http://127.0.0.1:1" }),
      queues.events,
      clock,
      { logger: silentLogger(), metrics },
    );
    await broken.publishBatch(100);
    const lagWhileWaiting = Number((await metrics.registry.getSingleMetricAsString("outbox_lag_seconds")).match(/^outbox_lag_seconds (\S+)$/m)?.[1]);
    expect(lagWhileWaiting).toBeGreaterThan(0);

    clock.advance(5_000);
    await publisher.publishBatch(100);
    const lagAfter = Number((await metrics.registry.getSingleMetricAsString("outbox_lag_seconds")).match(/^outbox_lag_seconds (\S+)$/m)?.[1]);
    expect(lagAfter).toBe(0);
    await receiveAll(queues.events);
  });
});

describe("a publisher process that dies", () => {
  test("after the commit and before publishing: another instance publishes everything", async () => {
    await freshState();
    const created = await seed(3);

    expect(await spawnFixture("before_send")).toBe(1);
    expect(await pendingCount()).toBe(created);
    expect(await receiveAll(queues.events, { rounds: 2 })).toHaveLength(0);

    expect(await publisher.publishBatch(100)).toBe(created);
    const ids = await eventIds();
    expect(ids).toHaveLength(created);
    expect(new Set(ids).size).toBe(created);
  });

  test("after sending and before marking: the second publication is harmless", async () => {
    await freshState();
    const created = await seed(3);

    expect(await spawnFixture("after_send")).toBe(1);
    expect(await pendingCount()).toBe(created);

    expect(await publisher.publishBatch(100)).toBe(created);
    expect(await pendingCount()).toBe(0);
    const ids = await eventIds();
    expect(new Set(ids).size).toBe(created);
    expect(ids).toHaveLength(created);
    const [{ total }] = await run<{ total: string }>(orm, "select count(distinct id)::text as total from outbox_message where published_at is not null");
    expect(Number(total)).toBeGreaterThanOrEqual(created);
  });
});
