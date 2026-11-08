import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { RetryPendingReferences } from "../../src/application/retry-pending-references";
import type { UnitOfWork } from "../../src/application/unit-of-work";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { connectIsolatedDatabase, run } from "../support/database";
import { ledgerBalance, storedBalance, walletsOutOfBalance } from "../support/ledger";
import { TestClock } from "../support/test-clock";

let orm: MikroORM;
let uow: UnitOfWork;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;
let retry: RetryPendingReferences;
const clock = new TestClock();

beforeAll(async () => {
  ({ orm } = await connectIsolatedDatabase("wagering_win_test"));
  uow = new MikroOrmUnitOfWork(orm);
  openWallet = new OpenWallet(uow, clock);
  processWager = new ProcessWagerTransaction(uow, clock);
  retry = new RetryPendingReferences(uow, clock);
});

afterAll(async () => {
  await orm.close();
});

afterEach(async () => {
  expect(await walletsOutOfBalance(orm)).toEqual([]);
});

type Wallet = { walletId: string; playerId: string };
type Body = Record<string, unknown>;

const money = (amount: string) => ({ amount, currency: "BRL" });

async function newWallet(amount = "1000.00"): Promise<Wallet> {
  const created = await openWallet.execute({ playerId: randomUUID(), initialBalance: money(amount) });
  return { walletId: created.id, playerId: created.playerId };
}

function command(wallet: Wallet, overrides: Body = {}): Body {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: money("25.00"),
    ...overrides,
  };
}

const win = (wallet: Wallet, bet: Body, amount = "40.00", overrides: Body = {}): Body =>
  command(wallet, {
    kind: "WIN",
    money: money(amount),
    roundId: bet.roundId,
    referenceExternalTransactionId: bet.externalTransactionId,
    ...overrides,
  });

const submit = (body: Body) =>
  processWager.execute(body, { idempotencyKey: `${body.providerId}:${body.externalTransactionId}` });

const find = (id: string) => uow.run((repositories) => repositories.transactions.findById(id));

async function drain(...ids: string[]) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const found = await Promise.all(ids.map(find));
    if (found.every((transaction) => transaction?.isTerminal())) return;
    clock.advance(301_000);
    await retry.execute();
  }
  throw new Error("transactions are still pending");
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await run<{ total: string }>(orm, sql, params);
  return Number(row?.total ?? 0);
}

const creditEntries = (walletId: string) =>
  count("select count(*)::text as total from wallet_ledger_entry where wallet_id = ? and direction = 'CREDIT'", [walletId]);

async function expectConsistent(walletId: string, expected: string) {
  expect(await storedBalance(orm, walletId)).toBe(expected);
  expect(await ledgerBalance(orm, walletId)).toBe(expected);
}

async function placedBet(wallet: Wallet, overrides: Body = {}) {
  const body = command(wallet, overrides);
  const result = await submit(body);
  return { body, result };
}

describe("a WIN that references its BET", () => {
  test("credits the prize and links to the BET", async () => {
    const wallet = await newWallet();
    const { body, result: bet } = await placedBet(wallet);
    const prize = await submit(win(wallet, body));
    expect(prize.status).toBe(WagerTransactionStatus.Processed);
    expect(prize.balance).toEqual(money("1015.00"));
    expect((await find(prize.transactionId))?.referenceTransactionId).toBe(bet.transactionId);
    await expectConsistent(wallet.walletId, "1015.00");
  });

  test("a WIN without a reference is still accepted", async () => {
    const wallet = await newWallet();
    const prize = await submit(command(wallet, { kind: "WIN", money: money("40.00") }));
    expect(prize.status).toBe(WagerTransactionStatus.Processed);
    expect((await find(prize.transactionId))?.referenceTransactionId).toBeUndefined();
    await expectConsistent(wallet.walletId, "1040.00");
  });

  test("the prize does not need to match the amount of the BET", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet, { money: money("10.00") });
    const prize = await submit(win(wallet, body, "250.00"));
    expect(prize.status).toBe(WagerTransactionStatus.Processed);
    await expectConsistent(wallet.walletId, "1240.00");
  });

  test("several WINs may reference the same BET", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const first = await submit(win(wallet, body, "10.00"));
    const second = await submit(win(wallet, body, "15.00"));
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(second.status).toBe(WagerTransactionStatus.Processed);
    expect(await creditEntries(wallet.walletId)).toBe(3);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a replay returns the original result and credits once", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const prize = win(wallet, body);
    const first = await submit(prize);
    const second = await submit(prize);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    await expectConsistent(wallet.walletId, "1015.00");
  });
});

describe("a WIN whose reference does not hold", () => {
  test("a reference to a BET of another player and wallet is rejected", async () => {
    const wallet = await newWallet();
    const other = await newWallet();
    const { body } = await placedBet(wallet);
    const prize = await submit(win(other, body));
    expect(prize.status).toBe(WagerTransactionStatus.Rejected);
    expect(prize.failureCode).toBe(FailureCode.ReferenceMismatch);
    await expectConsistent(other.walletId, "1000.00");
  });

  test("a reference to a BET of another round is rejected", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const prize = await submit(win(wallet, body, "40.00", { roundId: "round-2" }));
    expect(prize.failureCode).toBe(FailureCode.ReferenceMismatch);
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a reference to something that is not a BET is rejected", async () => {
    const wallet = await newWallet();
    const earlier = command(wallet, { kind: "WIN", money: money("5.00") });
    await submit(earlier);
    const prize = await submit(win(wallet, earlier));
    expect(prize.failureCode).toBe(FailureCode.InvalidReferenceKind);
    await expectConsistent(wallet.walletId, "1005.00");
  });

  test("a reference to a BET that was rejected has nothing to win", async () => {
    const wallet = await newWallet("10.00");
    const { body, result } = await placedBet(wallet, { money: money("80.00") });
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    const prize = await submit(win(wallet, body));
    expect(prize.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    await expectConsistent(wallet.walletId, "10.00");
  });
});

describe("a WIN that arrives before its BET", () => {
  test("waits, then is credited once the BET is processed", async () => {
    const wallet = await newWallet();
    const bet = command(wallet);
    const prize = win(wallet, bet);

    const waiting = await submit(prize);
    expect(waiting.status).toBe(WagerTransactionStatus.PendingReference);
    expect(waiting.balance).toBeUndefined();
    expect(
      await count(
        "select count(*)::text as total from outbox_message where aggregate_id = ? and event_type = 'WagerTransactionPendingReference'",
        [wallet.walletId],
      ),
    ).toBe(1);

    await submit(bet);
    await drain(waiting.transactionId);
    const resolved = await find(waiting.transactionId);
    expect(resolved?.status).toBe(WagerTransactionStatus.Processed);
    await expectConsistent(wallet.walletId, "1015.00");
  });

  test("when the BET never arrives it ends rejected with REFERENCE_NOT_FOUND and nothing is credited", async () => {
    const wallet = await newWallet();
    const waiting = await submit(win(wallet, command(wallet)));
    await drain(waiting.transactionId);
    const final = await find(waiting.transactionId);
    expect(final?.status).toBe(WagerTransactionStatus.Rejected);
    expect(final?.failureCode).toBe(FailureCode.ReferenceNotFound);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("racing with its own BET it always ends credited exactly once", async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await newWallet();
      const bet = command(wallet);
      const prize = win(wallet, bet);
      const [, prizeResult] = await Promise.all([submit(bet), submit(prize)]);
      await drain(prizeResult.transactionId);
      expect((await find(prizeResult.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
      expect(await creditEntries(wallet.walletId)).toBe(2);
      await expectConsistent(wallet.walletId, "1015.00");
    }
  });
});
