import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { RetryPendingReferences } from "../../src/application/retry-pending-references";
import type { UnitOfWork } from "../../src/application/unit-of-work";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { connectTestDatabase, run } from "../support/database";
import { ledgerBalance, storedBalance } from "../support/ledger";
import { TestClock } from "../support/test-clock";

let orm: MikroORM;
let uow: UnitOfWork;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;
let retry: RetryPendingReferences;
const clock = new TestClock();

beforeAll(async () => {
  orm = await connectTestDatabase();
  uow = new MikroOrmUnitOfWork(orm);
  openWallet = new OpenWallet(uow, clock);
  processWager = new ProcessWagerTransaction(uow, clock);
  retry = new RetryPendingReferences(uow, clock);
});

afterAll(async () => {
  await orm.close();
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

function reversal(wallet: Wallet, kind: "REFUND" | "ROLLBACK", reference: Body, overrides: Body = {}): Body {
  return command(wallet, {
    kind,
    referenceExternalTransactionId: reference.externalTransactionId,
    roundId: reference.roundId,
    money: reference.money,
    ...overrides,
  });
}

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

const entries = (walletId: string, direction: "DEBIT" | "CREDIT") =>
  count("select count(*)::text as total from wallet_ledger_entry where wallet_id = ? and direction = ?", [
    walletId,
    direction,
  ]);

const eventCount = (walletId: string, type: string) =>
  count("select count(*)::text as total from outbox_message where aggregate_id = ? and event_type = ?", [
    walletId,
    type,
  ]);

async function expectConsistent(walletId: string, expected: string) {
  expect(await storedBalance(orm, walletId)).toBe(expected);
  expect(await ledgerBalance(orm, walletId)).toBe(expected);
}

async function placedBet(wallet: Wallet, amount = "25.00") {
  const body = command(wallet, { money: money(amount) });
  const result = await submit(body);
  expect(result.status).toBe(WagerTransactionStatus.Processed);
  return { body, result };
}

describe("reversals that can be applied", () => {
  test("a REFUND gives the bet back and links to it", async () => {
    const wallet = await newWallet();
    const { body, result: bet } = await placedBet(wallet);
    const refund = await submit(reversal(wallet, "REFUND", body));
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance).toEqual(money("1000.00"));
    expect((await find(refund.transactionId))?.referenceTransactionId).toBe(bet.transactionId);
    expect(await entries(wallet.walletId, "DEBIT")).toBe(1);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a ROLLBACK of a BET credits it back", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const rollback = await submit(reversal(wallet, "ROLLBACK", body));
    expect(rollback.balance).toEqual(money("1000.00"));
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a ROLLBACK of a WIN takes the prize back with a debit", async () => {
    const wallet = await newWallet("100.00");
    const win = command(wallet, { kind: "WIN", money: money("40.00") });
    await submit(win);
    const rollback = await submit(reversal(wallet, "ROLLBACK", win));
    expect(rollback.balance).toEqual(money("100.00"));
    expect(await entries(wallet.walletId, "DEBIT")).toBe(1);
    await expectConsistent(wallet.walletId, "100.00");
  });

  test("a ROLLBACK of a REFUND debits again", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const refund = reversal(wallet, "REFUND", body);
    await submit(refund);
    const rollback = await submit(reversal(wallet, "ROLLBACK", refund));
    expect(rollback.balance).toEqual(money("975.00"));
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a replayed reversal returns the original result and applies once", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const refund = reversal(wallet, "REFUND", body);
    const first = await submit(refund);
    const second = await submit(refund);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    await expectConsistent(wallet.walletId, "1000.00");
  });
});

describe("reversals that are rejected", () => {
  test("a rollback that would overdraw uses its own failure code", async () => {
    const wallet = await newWallet("100.00");
    const win = command(wallet, { kind: "WIN", money: money("50.00") });
    await submit(win);
    await submit(command(wallet, { money: money("140.00") }));
    const rollback = await submit(reversal(wallet, "ROLLBACK", win));
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(rollback.balance).toEqual(money("10.00"));
    await expectConsistent(wallet.walletId, "10.00");
  });

  test("a bet without funds keeps INSUFFICIENT_FUNDS", async () => {
    const wallet = await newWallet("10.00");
    const result = await submit(command(wallet, { money: money("80.00") }));
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("a second REFUND of the same BET is rejected", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    await submit(reversal(wallet, "REFUND", body));
    const again = await submit(reversal(wallet, "REFUND", body));
    expect(again.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("after a REFUND, a ROLLBACK of the same BET is rejected too", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    await submit(reversal(wallet, "REFUND", body));
    const rollback = await submit(reversal(wallet, "ROLLBACK", body));
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a different amount is rejected", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const result = await submit(reversal(wallet, "REFUND", body, { money: money("20.00") }));
    expect(result.failureCode).toBe(FailureCode.AmountMismatch);
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a different round is rejected", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const result = await submit(reversal(wallet, "REFUND", body, { roundId: "round-2" }));
    expect(result.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test("a reference that belongs to another wallet and player is rejected", async () => {
    const wallet = await newWallet();
    const other = await newWallet();
    const { body } = await placedBet(wallet);
    const result = await submit(reversal(other, "REFUND", body));
    expect(result.failureCode).toBe(FailureCode.ReferenceMismatch);
    await expectConsistent(other.walletId, "1000.00");
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a REFUND only accepts a BET and a ROLLBACK does not accept a LOSS", async () => {
    const wallet = await newWallet();
    const win = command(wallet, { kind: "WIN", money: money("10.00") });
    const loss = command(wallet, { kind: "LOSS", money: money("5.00") });
    await submit(win);
    await submit(loss);
    expect((await submit(reversal(wallet, "REFUND", win))).failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect((await submit(reversal(wallet, "ROLLBACK", loss))).failureCode).toBe(FailureCode.InvalidReferenceKind);
    await expectConsistent(wallet.walletId, "1010.00");
  });

  test("a reference that was rejected has nothing to revert", async () => {
    const wallet = await newWallet("50.00");
    const bet = command(wallet, { money: money("80.00") });
    expect((await submit(bet)).status).toBe(WagerTransactionStatus.Rejected);
    const result = await submit(reversal(wallet, "REFUND", bet));
    expect(result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    await expectConsistent(wallet.walletId, "50.00");
  });
});

describe("references that arrive late", () => {
  test("a REFUND before its BET waits, then is applied by the worker", async () => {
    const wallet = await newWallet();
    const bet = command(wallet);
    const refund = reversal(wallet, "REFUND", bet);

    const waiting = await submit(refund);
    expect(waiting.status).toBe(WagerTransactionStatus.PendingReference);
    expect(waiting.balance).toBeUndefined();
    expect(await eventCount(wallet.walletId, "WagerTransactionPendingReference")).toBe(1);

    await submit(bet);
    await retry.execute();
    expect((await find(waiting.transactionId))?.status).toBe(WagerTransactionStatus.PendingReference);

    clock.advance(1_500);
    await retry.execute();
    const resolved = await find(waiting.transactionId);
    expect(resolved?.status).toBe(WagerTransactionStatus.Processed);
    expect(resolved?.observedBalance?.toJSON()).toEqual(money("1000.00"));
    expect(await eventCount(wallet.walletId, "WagerTransactionPendingReference")).toBe(1);
    await expectConsistent(wallet.walletId, "1000.00");

    const replay = await submit(refund);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
  });

  test("retries count attempts without repeating the pending event", async () => {
    const wallet = await newWallet();
    const bet = command(wallet);
    const waiting = await submit(reversal(wallet, "REFUND", bet));
    clock.advance(1_500);
    await retry.execute();
    const after = await find(waiting.transactionId);
    expect(after?.referenceAttempts).toBe(2);
    expect(await eventCount(wallet.walletId, "WagerTransactionPendingReference")).toBe(1);
    await submit(bet);
    await drain(waiting.transactionId);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("when the limit is reached it is rejected with REFERENCE_NOT_FOUND and an event", async () => {
    const wallet = await newWallet();
    const bet = command(wallet);
    const refund = reversal(wallet, "REFUND", bet);
    const waiting = await submit(refund);
    await drain(waiting.transactionId);

    const final = await find(waiting.transactionId);
    expect(final?.status).toBe(WagerTransactionStatus.Rejected);
    expect(final?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(final?.referenceAttempts).toBe(10);
    expect(await eventCount(wallet.walletId, "WagerTransactionRejected")).toBe(1);
    expect((await submit(refund)).status).toBe(WagerTransactionStatus.Rejected);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a ROLLBACK of a REFUND that is itself waiting resolves once the BET arrives", async () => {
    const wallet = await newWallet();
    const bet = command(wallet);
    const refund = reversal(wallet, "REFUND", bet);
    const rollback = reversal(wallet, "ROLLBACK", refund);
    const waitingRefund = await submit(refund);
    const waitingRollback = await submit(rollback);
    expect(waitingRollback.status).toBe(WagerTransactionStatus.PendingReference);
    await submit(bet);
    await drain(waitingRefund.transactionId, waitingRollback.transactionId);
    expect((await find(waitingRefund.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
    expect((await find(waitingRollback.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a waiting REFUND whose BET was rejected ends with REFERENCE_NOT_PROCESSED", async () => {
    const wallet = await newWallet("50.00");
    const bet = command(wallet, { money: money("80.00") });
    const refund = reversal(wallet, "REFUND", bet);
    const waiting = await submit(refund);
    await submit(bet);
    await drain(waiting.transactionId);
    expect((await find(waiting.transactionId))?.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    await expectConsistent(wallet.walletId, "50.00");
  });
});

describe("concurrency with reversals", () => {
  test("a REFUND and a ROLLBACK of the same BET in parallel: only one is applied", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const results = await Promise.all([
      submit(reversal(wallet, "REFUND", body)),
      submit(reversal(wallet, "ROLLBACK", body)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(results.find((result) => result.failureCode)?.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("the same REFUND sent 50 times in parallel credits once", async () => {
    const wallet = await newWallet();
    const { body } = await placedBet(wallet);
    const refund = reversal(wallet, "REFUND", body);
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(refund)));
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(await entries(wallet.walletId, "CREDIT")).toBe(2);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("two workers on the same waiting transaction apply it once", async () => {
    const wallet = await newWallet();
    const bet = command(wallet);
    const waiting = await submit(reversal(wallet, "REFUND", bet));
    await submit(bet);
    clock.advance(1_500);
    await Promise.all([retry.execute(), retry.execute(), retry.execute()]);
    expect((await find(waiting.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
    expect(await entries(wallet.walletId, "CREDIT")).toBe(2);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a REFUND racing with its own BET always ends applied exactly once", async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await newWallet();
      const bet = command(wallet);
      const refund = reversal(wallet, "REFUND", bet);
      const [, reversalResult] = await Promise.all([submit(bet), submit(refund)]);
      await drain(reversalResult.transactionId);
      expect((await find(reversalResult.transactionId))?.status).toBe(WagerTransactionStatus.Processed);
      expect(await entries(wallet.walletId, "CREDIT")).toBe(2);
      expect(await entries(wallet.walletId, "DEBIT")).toBe(1);
      await expectConsistent(wallet.walletId, "1000.00");
    }
  });
});
