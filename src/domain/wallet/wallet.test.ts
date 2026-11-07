import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from "../errors";
import { Money } from "../money";
import { LedgerDirection } from "./ledger-direction";
import { Wallet } from "./wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const opened = new Date("2026-11-07T12:00:00.000Z");
const later = new Date("2026-11-07T12:05:00.000Z");

const openWallet = (balance = "100.00") =>
  Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(balance), at: opened });

const movement = (amount: string, entryId = "e1") => ({
  entryId,
  transactionId: "t1",
  money: brl(amount),
  at: later,
});

describe("Wallet.open", () => {
  test("starts at version 1 with the initial balance", () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.createdAt).toEqual(opened);
    expect(wallet.updatedAt).toEqual(opened);
  });

  test("accepts a zero initial balance", () => {
    expect(openWallet("0.00").balance.isZero()).toBe(true);
  });

  test("rejects a negative initial balance", () => {
    const negative = brl("5.00").negate();
    expect(() => Wallet.open({ id: "w1", playerId: "p1", initialBalance: negative, at: opened })).toThrow(
      InvalidWalletOperationError,
    );
  });
});

describe("Wallet.debit", () => {
  test("lowers the balance and returns a matching ledger entry", () => {
    const wallet = openWallet();
    const entry = wallet.debit(movement("80.00"));
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.walletId).toBe("w1");
    expect(entry.transactionId).toBe("t1");
  });

  test("allows debiting the whole balance down to zero", () => {
    const wallet = openWallet();
    wallet.debit(movement("100.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("insufficient funds leaves balance, version and updatedAt untouched", () => {
    const wallet = openWallet();
    expect(() => wallet.debit(movement("100.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(opened);
  });
});

describe("Wallet.credit", () => {
  test("raises the balance and returns a matching ledger entry", () => {
    const wallet = openWallet();
    const entry = wallet.credit(movement("50.00"));
    expect(wallet.balance.toJSON().amount).toBe("150.00");
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("150.00");
  });
});

describe("Wallet version", () => {
  test("increments once per balance change and updates updatedAt", () => {
    const wallet = openWallet();
    wallet.debit(movement("10.00", "e1"));
    expect(wallet.version).toBe(2);
    wallet.credit(movement("5.00", "e2"));
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(later);
  });

  test("does not change when a movement is rejected", () => {
    const wallet = openWallet();
    expect(() => wallet.credit(movement("0.00"))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet movement validation", () => {
  test("rejects zero amount", () => {
    expect(() => openWallet().debit(movement("0.00"))).toThrow(InvalidWalletOperationError);
    expect(() => openWallet().credit(movement("0.00"))).toThrow(InvalidWalletOperationError);
  });

  test("rejects negative amount", () => {
    const negative = { ...movement("1.00"), money: brl("1.00").negate() };
    expect(() => openWallet().debit(negative)).toThrow(InvalidWalletOperationError);
    expect(() => openWallet().credit(negative)).toThrow(InvalidWalletOperationError);
  });

  test("rejects another currency without touching state", () => {
    const wallet = openWallet();
    const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet.rehydrate", () => {
  test("rebuilds persisted state as is, including the version", () => {
    const wallet = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: brl("20.00"),
      version: 7,
      createdAt: opened,
      updatedAt: later,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.updatedAt).toEqual(later);
  });

  test("rehydrated wallet keeps enforcing the rules", () => {
    const wallet = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: brl("20.00"),
      version: 7,
      createdAt: opened,
      updatedAt: later,
    });
    expect(() => wallet.debit(movement("20.01"))).toThrow(InsufficientFundsError);
    wallet.debit(movement("20.00"));
    expect(wallet.version).toBe(8);
  });
});
