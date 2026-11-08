import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OpenWallet } from "../../src/application/open-wallet";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import {
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidCommandError,
  InvalidMoneyError,
  WalletNotFoundError,
} from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { SystemClock } from "../../src/infrastructure/system-clock";
import { connectTestDatabase, run } from "../support/database";
import { ledgerBalance, storedBalance } from "../support/ledger";

let orm: MikroORM;
let openWallet: OpenWallet;
let processWager: ProcessWagerTransaction;

beforeAll(async () => {
  orm = await connectTestDatabase();
  const uow = new MikroOrmUnitOfWork(orm);
  openWallet = new OpenWallet(uow, new SystemClock());
  processWager = new ProcessWagerTransaction(uow, new SystemClock());
});

afterAll(async () => {
  await orm.close();
});

const money = (amount: string, currency = "BRL") => ({ amount, currency });

async function newWallet(amount = "1000.00") {
  const created = await openWallet.execute({ playerId: randomUUID(), initialBalance: money(amount) });
  return { walletId: created.id, playerId: created.playerId };
}

function command(
  wallet: { walletId: string; playerId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

const keyOf = (body: Record<string, unknown>) => `${body.providerId}:${body.externalTransactionId}`;

const submit = (body: Record<string, unknown>, key = keyOf(body)) =>
  processWager.execute(body, { idempotencyKey: key });

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await run<{ total: string }>(orm, sql, params);
  return Number(row?.total ?? 0);
}

const ledgerEntries = (walletId: string, direction?: string) =>
  count(
    `select count(*)::text as total from wallet_ledger_entry where wallet_id = ?${direction ? " and direction = ?" : ""}`,
    direction ? [walletId, direction] : [walletId],
  );

const outboxTypes = async (walletId: string) =>
  (await run<{ event_type: string }>(orm, "select event_type from outbox_message where aggregate_id = ? order by event_type", [walletId])).map(
    (row) => row.event_type,
  );

async function expectConsistent(walletId: string, expected: string) {
  expect(await storedBalance(orm, walletId)).toBe(expected);
  expect(await ledgerBalance(orm, walletId)).toBe(expected);
}

describe("open wallet", () => {
  test("creates the wallet, the OPENING transaction and the credit entry together", async () => {
    const created = await openWallet.execute({ playerId: randomUUID(), initialBalance: money("1000.00") });
    expect(created.balance).toEqual(money("1000.00"));
    expect(created.version).toBe(1);
    expect(await ledgerEntries(created.id, "CREDIT")).toBe(1);
    await expectConsistent(created.id, "1000.00");
    expect(await outboxTypes(created.id)).toEqual(["WalletBalanceChanged"]);
  });

  test("a zero balance creates no ledger entry", async () => {
    const created = await openWallet.execute({ playerId: randomUUID(), initialBalance: money("0.00") });
    expect(await ledgerEntries(created.id)).toBe(0);
    await expectConsistent(created.id, "0.00");
  });

  test("a second wallet for the same player and currency is a conflict", async () => {
    const playerId = randomUUID();
    await openWallet.execute({ playerId, initialBalance: money("10.00") });
    await expect(openWallet.execute({ playerId, initialBalance: money("10.00") })).rejects.toBeInstanceOf(
      DuplicateWalletError,
    );
    await openWallet.execute({ playerId, initialBalance: money("10.00", "USD") });
  });

  test("rejects invalid input", async () => {
    await expect(openWallet.execute({ playerId: randomUUID(), initialBalance: money("10") })).rejects.toBeInstanceOf(
      InvalidMoneyError,
    );
    await expect(openWallet.execute({ initialBalance: money("10.00") })).rejects.toBeInstanceOf(InvalidCommandError);
  });
});

describe("BET, WIN and LOSS", () => {
  test("a BET debits the wallet and writes ledger and events", async () => {
    const wallet = await newWallet();
    const result = await submit(command(wallet));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual(money("975.00"));
    expect(result.idempotentReplay).toBe(false);
    expect(await ledgerEntries(wallet.walletId, "DEBIT")).toBe(1);
    await expectConsistent(wallet.walletId, "975.00");
    expect(await outboxTypes(wallet.walletId)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
  });

  test("a WIN credits the wallet", async () => {
    const wallet = await newWallet("100.00");
    const result = await submit(command(wallet, { kind: "WIN", money: money("40.00") }));
    expect(result.balance).toEqual(money("140.00"));
    await expectConsistent(wallet.walletId, "140.00");
  });

  test("a LOSS records the result without moving the balance or the ledger", async () => {
    const wallet = await newWallet("100.00");
    const before = await outboxTypes(wallet.walletId);
    const result = await submit(command(wallet, { kind: "LOSS", money: money("10.00") }));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual(money("100.00"));
    expect(await ledgerEntries(wallet.walletId)).toBe(1);
    const after = await outboxTypes(wallet.walletId);
    expect(after.length - before.length).toBe(1);
    expect(after).toContain("WagerTransactionProcessed");
    await expectConsistent(wallet.walletId, "100.00");
  });

  test("a BET without funds is REJECTED, committed, and creates no ledger entry", async () => {
    const wallet = await newWallet("50.00");
    const result = await submit(command(wallet, { money: money("80.00") }));
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance).toEqual(money("50.00"));
    expect(await ledgerEntries(wallet.walletId, "DEBIT")).toBe(0);
    expect(await outboxTypes(wallet.walletId)).toContain("WagerTransactionRejected");
    await expectConsistent(wallet.walletId, "50.00");
  });

  test("a currency different from the wallet is rejected", async () => {
    const wallet = await newWallet();
    const result = await submit(command(wallet, { money: money("5.00", "USD") }));
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a player that does not own the wallet is rejected", async () => {
    const wallet = await newWallet();
    const result = await submit(command(wallet, { playerId: "someone-else" }));
    expect(result.failureCode).toBe(FailureCode.PlayerMismatch);
    await expectConsistent(wallet.walletId, "1000.00");
  });

  test("a wallet that does not exist persists nothing", async () => {
    const body = command({ walletId: randomUUID(), playerId: "p" });
    await expect(submit(body)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(
      await count("select count(*)::text as total from wager_transaction where idempotency_key = ?", [keyOf(body)]),
    ).toBe(0);
  });

  test("OPENING cannot be submitted", async () => {
    const wallet = await newWallet();
    await expect(submit(command(wallet, { kind: "OPENING" }))).rejects.toBeInstanceOf(InvalidCommandError);
  });
});

describe("idempotency", () => {
  test("the same request again returns the original result and debits once", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    const first = await submit(body);
    const second = await submit(body);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toEqual(first.balance);
    expect(await ledgerEntries(wallet.walletId, "DEBIT")).toBe(1);
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a replay returns the balance observed at that moment, not the current one", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    await submit(body);
    await submit(command(wallet, { money: money("75.00") }));
    const replay = await submit(body);
    expect(replay.balance).toEqual(money("975.00"));
    await expectConsistent(wallet.walletId, "900.00");
  });

  test("a rejected request replays as the same rejection", async () => {
    const wallet = await newWallet("10.00");
    const body = command(wallet, { money: money("80.00") });
    const first = await submit(body);
    const second = await submit(body);
    expect(second.idempotentReplay).toBe(true);
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(first.failureCode);
  });

  test("the same key with a different payload is a conflict and changes nothing", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    await submit(body);
    await expect(submit({ ...body, money: money("26.00") }, keyOf(body))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("a custom idempotency key works as the source of truth", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    const key = `custom-${randomUUID()}`;
    const first = await submit(body, key);
    const second = await submit(body, key);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
  });

  test("the same provider and external id under another key is a conflict", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    await submit(body, `key-${randomUUID()}`);
    await expect(submit(body, `key-${randomUUID()}`)).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expectConsistent(wallet.walletId, "975.00");
  });
});

describe("inbox", () => {
  test("a redelivered message is deduplicated and marked processed once", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    const inbox = { messageId: `msg-${randomUUID()}`, consumerName: "wager-consumer" };
    const first = await processWager.execute(body, { idempotencyKey: keyOf(body), inbox });
    const second = await processWager.execute(body, { idempotencyKey: keyOf(body), inbox });
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    const rows = await run<{ processed_at: Date | null }>(
      orm,
      "select processed_at from inbox_message where consumer_name = ? and message_id = ?",
      [inbox.consumerName, inbox.messageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed_at).not.toBeNull();
    await expectConsistent(wallet.walletId, "975.00");
  });
});

describe("concurrency through the use case", () => {
  test("two 80.00 bets on a 100.00 wallet: one PROCESSED, one REJECTED, one debit, balance 20.00", async () => {
    const wallet = await newWallet("100.00");
    const results = await Promise.all([
      submit(command(wallet, { money: money("80.00") })),
      submit(command(wallet, { money: money("80.00") })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(await ledgerEntries(wallet.walletId, "DEBIT")).toBe(1);
    await expectConsistent(wallet.walletId, "20.00");
  });

  test("the same bet sent 50 times in parallel debits once", async () => {
    const wallet = await newWallet();
    const body = command(wallet);
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(await ledgerEntries(wallet.walletId, "DEBIT")).toBe(1);
    await expectConsistent(wallet.walletId, "975.00");
  });

  test("different wallets are processed in parallel", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => newWallet("100.00")));
    const results = await Promise.all(wallets.map((wallet) => submit(command(wallet, { money: money("40.00") }))));
    expect(results.every((result) => result.status === WagerTransactionStatus.Processed)).toBe(true);
    for (const wallet of wallets) {
      await expectConsistent(wallet.walletId, "60.00");
    }
  });

  test("mixed parallel traffic on one wallet keeps balance equal to the ledger", async () => {
    const wallet = await newWallet("100.00");
    const requests = [
      ...Array.from({ length: 6 }, () => command(wallet, { kind: "BET", money: money("30.00") })),
      ...Array.from({ length: 4 }, () => command(wallet, { kind: "WIN", money: money("10.00") })),
      ...Array.from({ length: 3 }, () => command(wallet, { kind: "LOSS", money: money("5.00") })),
    ];
    const results = await Promise.all(requests.map((body) => submit(body)));
    expect(results.every((result) => result.balance !== undefined)).toBe(true);
    const stored = await storedBalance(orm, wallet.walletId);
    expect(stored.startsWith("-")).toBe(false);
    expect(await ledgerBalance(orm, wallet.walletId)).toBe(stored);
  });
});
