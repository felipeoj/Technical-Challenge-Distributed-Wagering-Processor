import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../src/application/unit-of-work";
import { ConcurrentModificationError, InsufficientFundsError } from "../../src/domain/errors";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/messaging/events/wallet-balance-changed";
import { Money } from "../../src/domain/money";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { connectIsolatedDatabase, run } from "../support/database";
import { ledgerBalance, storedBalance, walletsOutOfBalance } from "../support/ledger";

let orm: MikroORM;
let uow: UnitOfWork;

beforeAll(async () => {
  ({ orm } = await connectIsolatedDatabase("wagering_persistence_test"));
  uow = new MikroOrmUnitOfWork(orm);
});

afterAll(async () => {
  await orm.close();
});

afterEach(async () => {
  expect(await walletsOutOfBalance(orm)).toEqual([]);
});

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function newTransaction(walletId: string, kind: WagerTransactionKind, amount: string, key = randomUUID()) {
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: key,
    idempotencyKey: key,
    payloadHash: "hash",
    walletId,
    playerId: "player",
    roundId: "round",
    gameId: "game",
    kind,
    money: brl(amount),
    createdAt: new Date(),
  });
}

async function openWallet(initial = "100.00"): Promise<string> {
  const now = new Date();
  const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl(initial), at: now });
  await uow.run(async (repositories) => {
    await repositories.wallets.insert(wallet);
    const opening = WagerTransaction.create({
      id: randomUUID(),
      providerId: "INTERNAL",
      externalTransactionId: wallet.id,
      idempotencyKey: `OPENING:${wallet.id}`,
      payloadHash: "opening",
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "opening",
      gameId: "opening",
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: now,
    });
    opening.markProcessed(undefined, wallet.balance, now);
    await repositories.transactions.insertIfAbsent(opening);
    await repositories.ledger.insert(
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: wallet.balance,
        balanceBefore: Money.zero("BRL"),
        balanceAfter: wallet.balance,
        createdAt: now,
      }),
    );
  });
  return wallet.id;
}

async function placeBet(walletId: string, amount: string, key = randomUUID()): Promise<"PROCESSED" | "REJECTED"> {
  try {
    await uow.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new Error("wallet missing");
      const transaction = newTransaction(walletId, WagerTransactionKind.Bet, amount, key);
      await repositories.transactions.insertIfAbsent(transaction);
      const readVersion = wallet.version;
      const entry = wallet.debit({
        entryId: randomUUID(),
        transactionId: transaction.id,
        money: brl(amount),
        at: new Date(),
      });
      await repositories.ledger.insert(entry);
      await repositories.wallets.save(wallet, readVersion);
      transaction.markProcessed(undefined, wallet.balance, new Date());
      await repositories.transactions.save(transaction);
    });
    return "PROCESSED";
  } catch (error) {
    if (error instanceof InsufficientFundsError) return "REJECTED";
    throw error;
  }
}

describe("wallet repository", () => {
  test("reads the balance back as an exact Money", async () => {
    const walletId = await openWallet("100.00");
    const wallet = await uow.run((repositories) => repositories.wallets.findByIdForUpdate(walletId));
    expect(wallet?.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(wallet?.version).toBe(1);
  });

  test("returns undefined for a wallet that does not exist", async () => {
    const wallet = await uow.run((repositories) => repositories.wallets.findById(randomUUID()));
    expect(wallet).toBeUndefined();
  });

  test("save fails when the version changed since it was read", async () => {
    const walletId = await openWallet("100.00");
    await expect(
      uow.run(async (repositories) => {
        const wallet = await repositories.wallets.findByIdForUpdate(walletId);
        if (!wallet) throw new Error("wallet missing");
        wallet.credit({ entryId: randomUUID(), transactionId: randomUUID(), money: brl("1.00"), at: new Date() });
        await repositories.wallets.save(wallet, 99);
      }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(await storedBalance(orm, walletId)).toBe("100.00");
  });
});

describe("transaction repository", () => {
  test("insertIfAbsent reports the duplicate and keeps the first row", async () => {
    const walletId = await openWallet();
    const key = randomUUID();
    const first = newTransaction(walletId, WagerTransactionKind.Bet, "10.00", key);
    const second = newTransaction(walletId, WagerTransactionKind.Bet, "99.00", key);
    const result = await uow.run(async (repositories) => ({
      first: await repositories.transactions.insertIfAbsent(first),
      second: await repositories.transactions.insertIfAbsent(second),
      stored: await repositories.transactions.findByIdempotencyKey(key),
    }));
    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.stored?.id).toBe(first.id);
    expect(result.stored?.money.toJSON().amount).toBe("10.00");
    expect(result.stored?.status).toBe(WagerTransactionStatus.Pending);
  });

  test("a saved terminal state is read back with the observed balance", async () => {
    const walletId = await openWallet();
    const transaction = newTransaction(walletId, WagerTransactionKind.Bet, "10.00");
    await uow.run(async (repositories) => {
      await repositories.transactions.insertIfAbsent(transaction);
      transaction.markProcessed(undefined, brl("90.00"), new Date());
      await repositories.transactions.save(transaction);
    });
    const stored = await uow.run((repositories) => repositories.transactions.findById(transaction.id));
    expect(stored?.status).toBe(WagerTransactionStatus.Processed);
    expect(stored?.observedBalance?.toJSON().amount).toBe("90.00");
    expect(stored?.processedAt).toBeInstanceOf(Date);
  });

  test("finds a transaction by provider and external id", async () => {
    const walletId = await openWallet();
    const transaction = newTransaction(walletId, WagerTransactionKind.Bet, "10.00");
    await uow.run((repositories) => repositories.transactions.insertIfAbsent(transaction));
    const stored = await uow.run((repositories) =>
      repositories.transactions.findByProviderAndExternalId("provider-a", transaction.externalTransactionId),
    );
    expect(stored?.id).toBe(transaction.id);
  });
});

describe("unit of work", () => {
  test("rolls everything back when the work fails", async () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: brl("5.00"), at: new Date() });
    await expect(
      uow.run(async (repositories) => {
        await repositories.wallets.insert(wallet);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await uow.run((repositories) => repositories.wallets.findById(wallet.id))).toBeUndefined();
  });

  test("wallet, ledger, transaction and outbox commit together", async () => {
    const walletId = await openWallet("100.00");
    const transaction = newTransaction(walletId, WagerTransactionKind.Bet, "30.00");
    await uow.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new Error("wallet missing");
      await repositories.transactions.insertIfAbsent(transaction);
      const readVersion = wallet.version;
      const entry = wallet.debit({ entryId: randomUUID(), transactionId: transaction.id, money: brl("30.00"), at: new Date() });
      await repositories.ledger.insert(entry);
      await repositories.wallets.save(wallet, readVersion);
      const event = WalletBalanceChanged.from(wallet, entry, {
        eventId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: new Date(),
      });
      await repositories.outbox.add(OutboxMessage.enqueue(event));
    });
    expect(await storedBalance(orm, walletId)).toBe("70.00");
    expect(await ledgerBalance(orm, walletId)).toBe("70.00");
    const [outbox] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from outbox_message where aggregate_id = ?",
      [walletId],
    );
    expect(outbox?.total).toBe("1");
  });
});

describe("concurrency on the same wallet", () => {
  test("two 80.00 bets on a 100.00 wallet: one processed, one rejected, one debit", async () => {
    const walletId = await openWallet("100.00");
    const results = await Promise.all([placeBet(walletId, "80.00"), placeBet(walletId, "80.00")]);
    expect([...results].sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(await storedBalance(orm, walletId)).toBe("20.00");
    expect(await ledgerBalance(orm, walletId)).toBe("20.00");
    const [debits] = await run<{ total: string }>(
      orm,
      "select count(*)::text as total from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'",
      [walletId],
    );
    expect(debits?.total).toBe("1");
  });

  test("ten parallel bets never overdraw and keep balance equal to the ledger", async () => {
    const walletId = await openWallet("100.00");
    const results = await Promise.all(Array.from({ length: 10 }, () => placeBet(walletId, "30.00")));
    expect(results.filter((result) => result === "PROCESSED")).toHaveLength(3);
    expect(await storedBalance(orm, walletId)).toBe("10.00");
    expect(await ledgerBalance(orm, walletId)).toBe("10.00");
  });

  test("different wallets are processed in parallel", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet("100.00")));
    const results = await Promise.all(wallets.map((walletId) => placeBet(walletId, "40.00")));
    expect(results.every((result) => result === "PROCESSED")).toBe(true);
    for (const walletId of wallets) {
      expect(await storedBalance(orm, walletId)).toBe("60.00");
      expect(await ledgerBalance(orm, walletId)).toBe("60.00");
    }
  });
});
