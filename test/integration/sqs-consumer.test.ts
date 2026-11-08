import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { FailWagerTransaction } from "../../src/application/fail-wager-transaction";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { PrometheusMetrics } from "../../src/infrastructure/observability/prometheus-metrics";
import { WagerQueueConsumer } from "../../src/infrastructure/sqs/wager-consumer";
import { SystemClock } from "../../src/infrastructure/system-clock";
import { connectIsolatedDatabase, run } from "../support/database";
import { ledgerBalance, storedBalance } from "../support/ledger";
import { purgeAll, queueEnv, queues, receiveAll, sendRaw, sendWagerMessage, sqs, wagerMessageBody } from "../support/queues";

let orm: MikroORM;
let databaseUrl: string;
let uow: MikroOrmUnitOfWork;
let impatientUow: MikroOrmUnitOfWork;
let openWallet: OpenWallet;
const metrics = new PrometheusMetrics();
const noop = () => {};
const observability = { logger: { info: noop, warn: noop, error: noop }, metrics };
const clock = new SystemClock();

beforeAll(async () => {
  ({ orm, url: databaseUrl } = await connectIsolatedDatabase("wagering_consumer_test"));
  uow = new MikroOrmUnitOfWork(orm, metrics);
  impatientUow = new MikroOrmUnitOfWork(orm, metrics, { lockTimeoutMs: 300 });
  openWallet = new OpenWallet(uow, clock);
  await purgeAll();
});

afterAll(async () => {
  await orm.close();
});

type Wallet = { walletId: string; playerId: string };

async function newWallet(amount = "1000.00"): Promise<Wallet> {
  const created = await openWallet.execute({ playerId: randomUUID(), initialBalance: { amount, currency: "BRL" } });
  return { walletId: created.id, playerId: created.playerId };
}

function betData(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = randomUUID();
  return {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}

function makeConsumer(unit: MikroOrmUnitOfWork = uow) {
  return new WagerQueueConsumer(
    sqs,
    { queue: queues.transactions, dlq: queues.dlq },
    new ProcessWagerTransaction(unit, clock, observability),
    new FailWagerTransaction(uow, clock, observability),
    observability,
    { waitSeconds: 1, visibilityBackoffSeconds: () => 0 },
  );
}

async function pollUntilIdle(consumer: WagerQueueConsumer, limit = 12): Promise<number> {
  let handled = 0;
  let idle = 0;
  for (let round = 0; round < limit && idle < 2; round += 1) {
    const count = await consumer.pollOnce();
    handled += count;
    idle = count === 0 ? idle + 1 : 0;
  }
  return handled;
}

async function seriesValue(prefix: string): Promise<number> {
  const text = await metrics.registry.metrics();
  const line = text.split("\n").find((entry) => entry.startsWith(`${prefix} `));
  return line ? Number(line.split(" ")[1]) : 0;
}

async function holdWalletLock(walletId: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockedSignal = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = uow.run(async (repositories) => {
    await repositories.wallets.findByIdForUpdate(walletId);
    locked();
    await gate;
  });
  await lockedSignal;
  return async () => {
    release();
    await held;
  };
}

async function expectConsistent(walletId: string, expected: string) {
  expect(await storedBalance(orm, walletId)).toBe(expected);
  expect(await ledgerBalance(orm, walletId)).toBe(expected);
}

const mainQueueIsEmpty = async () =>
  (await receiveAll(queues.transactions, { remove: false, rounds: 2 })).length === 0;

describe("processing and acknowledging", () => {
  test("a valid message is processed, recorded in the inbox and removed from the queue", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const messageId = await sendWagerMessage(betData(wallet));
    expect(await makeConsumer().pollOnce()).toBe(1);

    await expectConsistent(wallet.walletId, "975.00");
    const [inbox] = await run<{ processed_at: Date | null }>(
      orm,
      "select processed_at from inbox_message where message_id = ?",
      [messageId],
    );
    expect(inbox?.processed_at).not.toBeNull();
    expect(await mainQueueIsEmpty()).toBe(true);
  });

  test("the same business message delivered twice is applied once", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const data = betData(wallet);
    const messageId = randomUUID();
    await sendWagerMessage(data, { messageId, deduplicationId: randomUUID() });
    await sendWagerMessage(data, { messageId, deduplicationId: randomUUID() });

    expect(await pollUntilIdle(makeConsumer())).toBe(2);
    await expectConsistent(wallet.walletId, "975.00");
    expect(await mainQueueIsEmpty()).toBe(true);
  });

  test("a rejection by business rule is acknowledged, not retried and not sent to the DLQ", async () => {
    await purgeAll();
    const wallet = await newWallet("10.00");
    const data = betData(wallet, { money: { amount: "80.00", currency: "BRL" } });
    await sendWagerMessage(data);
    await pollUntilIdle(makeConsumer());

    const [row] = await run<{ status: string; failure_code: string }>(
      orm,
      "select status, failure_code from wager_transaction where idempotency_key = ?",
      [data.idempotencyKey],
    );
    expect(row).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await mainQueueIsEmpty()).toBe(true);
    expect(await receiveAll(queues.dlq, { rounds: 2 })).toHaveLength(0);
  });

  test("a message for an unknown wallet is dropped as a business error", async () => {
    await purgeAll();
    await sendWagerMessage(betData({ walletId: randomUUID(), playerId: "p" }));
    expect(await pollUntilIdle(makeConsumer())).toBe(1);
    expect(await mainQueueIsEmpty()).toBe(true);
    expect(await receiveAll(queues.dlq, { rounds: 2 })).toHaveLength(0);
  });
});

describe("permanent failures go to the DLQ", () => {
  test("malformed messages are moved to the DLQ with the reason", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const before = await seriesValue("wager_dlq_messages_total");
    await sendRaw("{not json", "group-a");
    await sendRaw(wagerMessageBody(betData(wallet), "m-1").replace("WagerTransactionRequested", "SomethingElse"), "group-b");
    await sendRaw(
      wagerMessageBody(betData(wallet, { money: { amount: "25", currency: "BRL" } }), "m-2"),
      "group-c",
    );

    expect(await pollUntilIdle(makeConsumer())).toBe(3);
    expect(await mainQueueIsEmpty()).toBe(true);

    const dead = await receiveAll(queues.dlq);
    expect(dead).toHaveLength(3);
    const reasons = dead.map((message) => message.MessageAttributes?.failureReason?.StringValue).sort();
    expect(reasons).toEqual(["InvalidCommandError", "InvalidCommandError", "InvalidMoneyError"]);
    expect((await seriesValue("wager_dlq_messages_total")) - before).toBe(3);
    await expectConsistent(wallet.walletId, "1000.00");
  });
});

describe("transient failures", () => {
  test("the message is kept, retried and finally processed once", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const retriesBefore = await seriesValue('wager_retries_total{kind="sqs"}');
    const conflictsBefore = await seriesValue("wager_lock_conflicts_total");
    const release = await holdWalletLock(wallet.walletId);
    await sendWagerMessage(betData(wallet));

    const consumer = makeConsumer(impatientUow);
    expect(await consumer.pollOnce()).toBe(1);
    await release();
    expect(await storedBalance(orm, wallet.walletId)).toBe("1000.00");
    expect((await seriesValue('wager_retries_total{kind="sqs"}')) - retriesBefore).toBe(1);
    expect((await seriesValue("wager_lock_conflicts_total")) - conflictsBefore).toBeGreaterThanOrEqual(1);

    expect(await consumer.pollOnce()).toBe(1);
    await expectConsistent(wallet.walletId, "975.00");
    expect(await mainQueueIsEmpty()).toBe(true);
  });

  test("when the receive limit is reached the transaction is recorded as FAILED and the queue moves the message to the DLQ", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const data = betData(wallet);
    const dlqBefore = await seriesValue("wager_dlq_messages_total");
    const release = await holdWalletLock(wallet.walletId);
    await sendWagerMessage(data);

    const consumer = makeConsumer(impatientUow);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await consumer.pollOnce()).toBe(1);
    }
    const lastAttempt = consumer.pollOnce();
    const released = new Promise<void>((resolve) => {
      setTimeout(() => void release().then(resolve), 700);
    });
    expect(await lastAttempt).toBe(1);
    await released;
    expect(await consumer.pollOnce()).toBe(0);

    const [row] = await run<{ status: string; failure_code: string }>(
      orm,
      "select status, failure_code from wager_transaction where idempotency_key = ?",
      [data.idempotencyKey],
    );
    expect(row).toEqual({ status: "FAILED", failure_code: "PERMANENT_ERROR" });
    expect(await receiveAll(queues.dlq)).toHaveLength(1);
    expect((await seriesValue("wager_dlq_messages_total")) - dlqBefore).toBe(1);
    await expectConsistent(wallet.walletId, "1000.00");

    const replay = await new ProcessWagerTransaction(uow, clock).execute(data, {
      idempotencyKey: data.idempotencyKey,
    });
    expect(replay.status).toBe(WagerTransactionStatus.Failed);
    expect(replay.idempotentReplay).toBe(true);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("when the failure cannot be recorded the message still reaches the DLQ", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const data = betData(wallet);
    const release = await holdWalletLock(wallet.walletId);
    await sendWagerMessage(data);

    const consumer = makeConsumer(impatientUow);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await consumer.pollOnce()).toBe(1);
    }
    expect(await consumer.pollOnce()).toBe(0);
    await release();

    expect(await receiveAll(queues.dlq)).toHaveLength(1);
    const [row] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from wager_transaction where idempotency_key = ?",
      [data.idempotencyKey],
    );
    expect(row?.total).toBe("0");
    await expectConsistent(wallet.walletId, "1000.00");
  });
});

describe("shutdown and redelivery", () => {
  test("on shutdown the unprocessed messages of a batch are returned and later processed once", async () => {
    await purgeAll();
    const wallet = await newWallet();
    for (let index = 0; index < 3; index += 1) {
      await sendWagerMessage(betData(wallet, { money: { amount: "10.00", currency: "BRL" } }));
    }
    const consumer = makeConsumer();
    let calls = 0;
    expect(await consumer.pollOnce(() => calls++ >= 1)).toBe(1);

    expect(await pollUntilIdle(consumer)).toBe(2);
    await expectConsistent(wallet.walletId, "970.00");
    expect(await mainQueueIsEmpty()).toBe(true);
  });

  test("a worker process that dies after the commit and before the ack causes no duplicate", async () => {
    await purgeAll();
    const wallet = await newWallet();
    const data = betData(wallet);
    await sendWagerMessage(data);

    const script = new URL("../fixtures/crashing-consumer.ts", import.meta.url).pathname;
    const dying = Bun.spawn(["bun", script], {
      env: { ...Bun.env, ...queueEnv, DATABASE_URL: databaseUrl },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await dying.exited).toBe(1);
    expect(await storedBalance(orm, wallet.walletId)).toBe("975.00");

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await pollUntilIdle(makeConsumer())).toBe(1);

    await expectConsistent(wallet.walletId, "975.00");
    const [transactions] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from wager_transaction where idempotency_key = ?",
      [data.idempotencyKey],
    );
    expect(transactions?.total).toBe("1");
    expect(await mainQueueIsEmpty()).toBe(true);
  });
});

describe("several consumers", () => {
  test("three consumers on the same queue apply every message exactly once", async () => {
    await purgeAll();
    const wallets = await Promise.all(Array.from({ length: 12 }, () => newWallet()));
    for (const wallet of wallets) {
      const data = betData(wallet);
      const messageId = randomUUID();
      await sendWagerMessage(data, { messageId, deduplicationId: randomUUID() });
      await sendWagerMessage(data, { messageId, deduplicationId: randomUUID() });
    }

    const consumers = [makeConsumer(), makeConsumer(), makeConsumer()];
    await Promise.all(consumers.map((consumer) => pollUntilIdle(consumer, 20)));

    for (const wallet of wallets) {
      await expectConsistent(wallet.walletId, "975.00");
    }
    expect(await mainQueueIsEmpty()).toBe(true);
    expect(await receiveAll(queues.dlq, { rounds: 2 })).toHaveLength(0);
  });
});
