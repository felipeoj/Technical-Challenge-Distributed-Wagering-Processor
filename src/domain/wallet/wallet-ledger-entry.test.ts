import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidLedgerEntryError } from "../errors";
import { Money } from "../money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-07T12:00:00.000Z");

const entry = (overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) =>
  WalletLedgerEntry.create({
    id: "e1",
    walletId: "w1",
    transactionId: "t1",
    direction: LedgerDirection.Debit,
    money: brl("80.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("20.00"),
    createdAt: at,
    ...overrides,
  });

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced debit", () => {
    const created = entry();
    expect(created.isBalanced()).toBe(true);
    expect(created.balanceAfter.toJSON().amount).toBe("20.00");
  });

  test("accepts a balanced credit", () => {
    const created = entry({
      direction: LedgerDirection.Credit,
      balanceBefore: brl("20.00"),
      balanceAfter: brl("100.00"),
    });
    expect(created.isBalanced()).toBe(true);
  });

  test("rejects inconsistent arithmetic", () => {
    expect(() => entry({ balanceAfter: brl("21.00") })).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a debit recorded as if it were a credit", () => {
    expect(() => entry({ direction: LedgerDirection.Credit })).toThrow(InvalidLedgerEntryError);
  });

  test("rejects zero amount", () => {
    expect(() =>
      entry({ money: brl("0.00"), balanceBefore: brl("10.00"), balanceAfter: brl("10.00") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects mixed currencies", () => {
    const usd = Money.from({ amount: "20.00", currency: "USD" });
    expect(() => entry({ balanceAfter: usd })).toThrow(CurrencyMismatchError);
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("does not revalidate persisted state", () => {
    const rebuilt = WalletLedgerEntry.rehydrate({
      id: "e1",
      walletId: "w1",
      transactionId: "t1",
      direction: LedgerDirection.Debit,
      money: brl("80.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("99.00"),
      createdAt: at,
    });
    expect(rebuilt.isBalanced()).toBe(false);
  });
});
