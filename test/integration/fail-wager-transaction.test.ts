import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { FailWagerTransaction } from "../../src/application/fail-wager-transaction";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import type { UnitOfWork } from "../../src/application/unit-of-work";
import { InvalidCommandError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { SystemClock } from "../../src/infrastructure/system-clock";
import { connectTestDatabase, run } from "../support/database";
import { ledgerBalance, storedBalance } from "../support/ledger";

let orm: MikroORM;
let uow: UnitOfWork;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;
let failWager: FailWagerTransaction;

beforeAll(async () => {
  orm = await connectTestDatabase();
  uow = new MikroOrmUnitOfWork(orm);
  const clock = new SystemClock();
  openWallet = new OpenWallet(uow, clock);
  processWager = new ProcessWagerTransaction(uow, clock);
  failWager = new FailWagerTransaction(uow, clock);
});

afterAll(async () => {
  await orm.close();
});

const money = (amount: string) => ({ amount, currency: "BRL" });

async function newWallet() {
  const created = await openWallet.execute({ playerId: randomUUID(), initialBalance: money("1000.00") });
  return { walletId: created.id, playerId: created.playerId };
}

function betBody(wallet: { walletId: string; playerId: string }) {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: money("25.00"),
  };
}

const keyOf = (body: { providerId: string; externalTransactionId: string }) =>
  `${body.providerId}:${body.externalTransactionId}`;

const find = (id: string) => uow.run((repositories) => repositories.transactions.findById(id));

async function expectConsistent(walletId: string, expected: string) {
  expect(await storedBalance(orm, walletId)).toBe(expected);
  expect(await ledgerBalance(orm, walletId)).toBe(expected);
}

describe("FailWagerTransaction", () => {
  test("records a terminal FAILED transaction and leaves the wallet untouched", async () => {
    const wallet = await newWallet();
    const body = betBody(wallet);
    const result = await failWager.execute(body, { idempotencyKey: keyOf(body) });

    expect(result?.status).toBe(WagerTransactionStatus.Failed);
    expect(result?.failureCode).toBe(FailureCode.PermanentError);
    expect(result?.balance).toBeUndefined();
    const stored = await find(result?.transactionId ?? "");
    expect(stored?.isTerminal()).toBe(true);
    await expectConsistent(wallet.walletId, "1000.00");
    const [entries] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from wallet_ledger_entry where transaction_id = ?",
      [result?.transactionId],
    );
    expect(entries?.total).toBe("0");
  });

  test("recording it twice keeps a single transaction", async () => {
    const wallet = await newWallet();
    const body = betBody(wallet);
    const first = await failWager.execute(body, { idempotencyKey: keyOf(body) });
    const second = await failWager.execute(body, { idempotencyKey: keyOf(body) });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    const [rows] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from wager_transaction where idempotency_key = ?",
      [keyOf(body)],
    );
    expect(rows?.total).toBe("1");
  });

  test("it never overrides a transaction that was already processed", async () => {
    const wallet = await newWallet();
    const body = betBody(wallet);
    const processed = await processWager.execute(body, { idempotencyKey: keyOf(body) });
    expect(await failWager.execute(body, { idempotencyKey: keyOf(body) })).toBeUndefined();
    expect((await find(processed.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a wallet that does not exist leaves nothing behind", async () => {
    const body = betBody({ walletId: randomUUID(), playerId: "p" });
    expect(await failWager.execute(body, { idempotencyKey: keyOf(body) })).toBeUndefined();
    const [rows] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from wager_transaction where idempotency_key = ?",
      [keyOf(body)],
    );
    expect(rows?.total).toBe("0");
  });

  test("a later request with the same key replays the failure and never moves money", async () => {
    const wallet = await newWallet();
    const body = betBody(wallet);
    const failed = await failWager.execute(body, { idempotencyKey: keyOf(body) });
    expect(failed).toBeDefined();
    const replay = await processWager.execute(body, { idempotencyKey: keyOf(body) });
    expect(replay.status).toBe(WagerTransactionStatus.Failed);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(failed?.transactionId as string);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("the inbox message is marked processed when the failure comes from the queue", async () => {
    const wallet = await newWallet();
    const body = betBody(wallet);
    const messageId = `msg-${randomUUID()}`;
    await failWager.execute(body, {
      idempotencyKey: keyOf(body),
      inbox: { messageId, consumerName: "wager-transactions-consumer" },
    });
    const [inbox] = await run<{ processed_at: Date | null }>(
      orm,
      "select processed_at from inbox_message where message_id = ?",
      [messageId],
    );
    expect(inbox?.processed_at).not.toBeNull();
  });

  test("an invalid command is rejected before touching the database", async () => {
    await expect(failWager.execute({ kind: "BET" }, { idempotencyKey: "x" })).rejects.toBeInstanceOf(
      InvalidCommandError,
    );
  });
});
