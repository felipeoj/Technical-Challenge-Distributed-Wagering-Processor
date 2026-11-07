import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { connectTestDatabase, run } from "../support/database";

let orm: MikroORM;

beforeAll(async () => {
  orm = await connectTestDatabase();
});

afterAll(async () => {
  await orm.close();
});

async function insertWallet(balance = "100.00", playerId = randomUUID(), currency = "BRL") {
  const id = randomUUID();
  const now = new Date();
  await run(
    orm,
    "insert into wallet (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, 1, ?, ?)",
    [id, playerId, currency, balance, now, now],
  );
  return id;
}

async function insertTransaction(walletId: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    provider_id: "provider-a",
    external_transaction_id: randomUUID(),
    idempotency_key: randomUUID(),
    payload_hash: "hash",
    wallet_id: walletId,
    player_id: "player",
    round_id: "round",
    game_id: "game",
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "PENDING",
    failure_code: null,
    processed_at: null,
    created_at: new Date(),
    ...overrides,
  };
  const columns = Object.keys(row);
  await run(
    orm,
    `insert into wager_transaction (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
  return row.id as string;
}

async function insertLedgerEntry(
  walletId: string,
  transactionId: string,
  overrides: Record<string, unknown> = {},
) {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: "DEBIT",
    amount: "10.00",
    currency: "BRL",
    balance_before: "100.00",
    balance_after: "90.00",
    created_at: new Date(),
    ...overrides,
  };
  const columns = Object.keys(row);
  await run(
    orm,
    `insert into wallet_ledger_entry (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
    Object.values(row),
  );
  return row.id as string;
}

describe("wallet constraints", () => {
  test("rejects a negative balance on insert", async () => {
    await expect(insertWallet("-0.01")).rejects.toThrow(/wallet_balance_non_negative/);
  });

  test("rejects an update that would make the balance negative", async () => {
    const walletId = await insertWallet("10.00");
    await expect(
      run(orm, "update wallet set balance = balance - 10.01 where id = ?", [walletId]),
    ).rejects.toThrow(/wallet_balance_non_negative/);
    const [wallet] = await run<{ balance: string }>(orm, "select balance from wallet where id = ?", [walletId]);
    expect(wallet?.balance).toBe("10.00");
  });

  test("allows only one wallet per player and currency", async () => {
    const playerId = randomUUID();
    await insertWallet("1.00", playerId, "BRL");
    await expect(insertWallet("1.00", playerId, "BRL")).rejects.toThrow(/wallet_player_currency_unique/);
    await insertWallet("1.00", playerId, "USD");
  });

  test("reads the balance back as an exact string", async () => {
    const walletId = await insertWallet("20.00");
    const [wallet] = await run<{ balance: string }>(orm, "select balance from wallet where id = ?", [walletId]);
    expect(wallet?.balance).toBe("20.00");
  });
});

describe("wager_transaction constraints", () => {
  test("rejects a repeated idempotency key", async () => {
    const walletId = await insertWallet();
    const key = randomUUID();
    await insertTransaction(walletId, { idempotency_key: key });
    await expect(insertTransaction(walletId, { idempotency_key: key })).rejects.toThrow(
      /wager_transaction_idempotency_unique/,
    );
  });

  test("rejects a repeated provider and external transaction id", async () => {
    const walletId = await insertWallet();
    const externalId = randomUUID();
    await insertTransaction(walletId, { external_transaction_id: externalId });
    await expect(insertTransaction(walletId, { external_transaction_id: externalId })).rejects.toThrow(
      /wager_transaction_provider_external_unique/,
    );
    await insertTransaction(walletId, { provider_id: "provider-b", external_transaction_id: externalId });
  });

  test("a reversal must carry a reference", async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { kind: "REFUND" })).rejects.toThrow(
      /wager_transaction_reversal_has_reference/,
    );
  });

  test("a rejected transaction must carry a failure code", async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { status: "REJECTED" })).rejects.toThrow(
      /wager_transaction_rejected_has_code/,
    );
  });

  test("rejects unknown kind and status", async () => {
    const walletId = await insertWallet();
    await expect(insertTransaction(walletId, { kind: "TIP" })).rejects.toThrow(/wager_transaction_kind_valid/);
    await expect(insertTransaction(walletId, { status: "DONE" })).rejects.toThrow(
      /wager_transaction_status_valid/,
    );
  });

  test("a reference can be reversed once per kind among processed transactions", async () => {
    const walletId = await insertWallet();
    const bet = await insertTransaction(walletId, { status: "PROCESSED", processed_at: new Date() });
    const reversal = (overrides: Record<string, unknown>) =>
      insertTransaction(walletId, {
        kind: "REFUND",
        reference_external_transaction_id: "bet-ext",
        reference_transaction_id: bet,
        ...overrides,
      });

    await reversal({ status: "PROCESSED", processed_at: new Date() });
    await expect(reversal({ status: "PROCESSED", processed_at: new Date() })).rejects.toThrow(
      /wager_transaction_reversed_once/,
    );
    await reversal({ status: "REJECTED", failure_code: "REFERENCE_ALREADY_REVERSED" });
    await reversal({ kind: "ROLLBACK", status: "PROCESSED", processed_at: new Date() });
  });
});

describe("wallet_ledger_entry constraints", () => {
  async function ledgerFixture() {
    const walletId = await insertWallet();
    const transactionId = await insertTransaction(walletId);
    return { walletId, transactionId };
  }

  test("accepts a balanced debit and credit", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await insertLedgerEntry(walletId, transactionId);
    const other = await insertTransaction(walletId);
    await insertLedgerEntry(walletId, other, {
      direction: "CREDIT",
      balance_before: "90.00",
      balance_after: "100.00",
    });
  });

  test("rejects inconsistent arithmetic", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await expect(insertLedgerEntry(walletId, transactionId, { balance_after: "89.00" })).rejects.toThrow(
      /ledger_arithmetic/,
    );
    await expect(
      insertLedgerEntry(walletId, transactionId, { direction: "CREDIT" }),
    ).rejects.toThrow(/ledger_arithmetic/);
  });

  test("rejects zero amount and negative balances", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await expect(
      insertLedgerEntry(walletId, transactionId, { amount: "0.00", balance_after: "100.00" }),
    ).rejects.toThrow(/ledger_amount_positive/);
    await expect(
      insertLedgerEntry(walletId, transactionId, { amount: "20.00", balance_before: "10.00", balance_after: "-10.00" }),
    ).rejects.toThrow(/ledger_balances_non_negative/);
  });

  test("allows one entry per transaction and wallet", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    await insertLedgerEntry(walletId, transactionId);
    await expect(insertLedgerEntry(walletId, transactionId)).rejects.toThrow(
      /ledger_one_entry_per_transaction/,
    );
  });

  test("is append-only: UPDATE, DELETE and TRUNCATE are blocked", async () => {
    const { walletId, transactionId } = await ledgerFixture();
    const entryId = await insertLedgerEntry(walletId, transactionId);
    await expect(
      run(orm, "update wallet_ledger_entry set amount = 99.00 where id = ?", [entryId]),
    ).rejects.toThrow(/append-only/);
    await expect(run(orm, "delete from wallet_ledger_entry where id = ?", [entryId])).rejects.toThrow(
      /append-only/,
    );
    await expect(run(orm, "truncate wallet_ledger_entry")).rejects.toThrow(/append-only/);
    await expect(run(orm, "truncate wallet_ledger_entry cascade")).rejects.toThrow(/append-only/);
    const [entry] = await run<{ amount: string }>(orm, "select amount from wallet_ledger_entry where id = ?", [
      entryId,
    ]);
    expect(entry?.amount).toBe("10.00");
  });
});

describe("inbox and outbox", () => {
  test("inbox deduplicates by consumer and message id", async () => {
    const messageId = randomUUID();
    const insert = (consumer: string) =>
      run(
        orm,
        "insert into inbox_message (consumer_name, message_id, payload_hash, received_at) values (?, ?, 'h', now())",
        [consumer, messageId],
      );
    await insert("wager-consumer");
    await expect(insert("wager-consumer")).rejects.toThrow(/inbox_message_pkey/);
    await insert("other-consumer");
  });

  test("inbox insert with ON CONFLICT DO NOTHING reports the duplicate", async () => {
    const messageId = randomUUID();
    const insert = () =>
      run<{ message_id: string }>(
        orm,
        "insert into inbox_message (consumer_name, message_id, payload_hash, received_at) values ('c', ?, 'h', now()) on conflict do nothing returning message_id",
        [messageId],
      );
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toHaveLength(0);
  });

  test("outbox stores the payload as jsonb and starts unpublished", async () => {
    const id = randomUUID();
    await run(
      orm,
      "insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at) values (?, 'w1', 'WalletBalanceChanged', ?::jsonb, now())",
      [id, JSON.stringify({ data: { money: { amount: "25.00", currency: "BRL" } } })],
    );
    const [row] = await run<{ payload: { data: { money: { amount: string } } }; attempts: number; published_at: Date | null }>(
      orm,
      "select payload, attempts, published_at from outbox_message where id = ?",
      [id],
    );
    expect(row?.payload.data.money.amount).toBe("25.00");
    expect(row?.attempts).toBe(0);
    expect(row?.published_at).toBeNull();
  });
});
