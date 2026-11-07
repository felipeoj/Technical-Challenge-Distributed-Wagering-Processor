import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../errors";
import { Money } from "../money";
import { LedgerDirection } from "../wallet/ledger-direction";
import { FailureCode } from "./failure-code";
import { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-11-07T12:00:00.000Z");
const later = new Date("2026-11-07T12:01:00.000Z");

const make = (kind: WagerTransactionKind, extra: { reference?: string; amount?: string } = {}) =>
  WagerTransaction.create({
    id: "t1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind,
    money: brl(extra.amount ?? "25.00"),
    referenceExternalTransactionId: extra.reference,
    createdAt: now,
  });

describe("WagerTransaction.create", () => {
  test("starts as PENDING", () => {
    const transaction = make(WagerTransactionKind.Bet);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.referenceAttempts).toBe(0);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    "%s requires a reference",
    (kind) => {
      expect(() => make(kind)).toThrow(InvalidWagerTransactionError);
      expect(make(kind, { reference: "ext-0" }).requiresReference()).toBe(true);
    },
  );

  test.each([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss])(
    "%s does not require a reference",
    (kind) => {
      expect(make(kind).requiresReference()).toBe(false);
    },
  );

  test("rejects zero amount when the balance is affected", () => {
    expect(() => make(WagerTransactionKind.Bet, { amount: "0.00" })).toThrow(InvalidWagerTransactionError);
    expect(make(WagerTransactionKind.Loss, { amount: "0.00" }).money.isZero()).toBe(true);
  });
});

describe("WagerTransaction queries", () => {
  test("only LOSS does not affect the balance", () => {
    expect(make(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(make(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });

  test("matchesPayload compares hashes", () => {
    const transaction = make(WagerTransactionKind.Bet);
    expect(transaction.matchesPayload("hash-1")).toBe(true);
    expect(transaction.matchesPayload("hash-2")).toBe(false);
  });
});

describe("WagerTransaction.ledgerDirectionFor", () => {
  test("BET debits, WIN and REFUND credit", () => {
    expect(make(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(WagerTransactionKind.Refund, { reference: "x" }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test("ROLLBACK inverts the direction of its reference", () => {
    const rollback = make(WagerTransactionKind.Rollback, { reference: "x" });
    expect(rollback.ledgerDirectionFor(make(WagerTransactionKind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make(WagerTransactionKind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(make(WagerTransactionKind.Refund, { reference: "y" }))).toBe(
      LedgerDirection.Debit,
    );
  });

  test("ROLLBACK without reference and LOSS have no direction", () => {
    expect(() => make(WagerTransactionKind.Rollback, { reference: "x" }).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => make(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe("WagerTransaction transitions", () => {
  test("PENDING to PROCESSED", () => {
    const transaction = make(WagerTransactionKind.Bet);
    transaction.markProcessed(undefined, brl("75.00"), later);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.processedAt).toEqual(later);
    expect(transaction.observedBalance?.toJSON().amount).toBe("75.00");
    expect(transaction.isTerminal()).toBe(true);
  });

  test("a reversal needs the reference id to be processed", () => {
    const transaction = make(WagerTransactionKind.Refund, { reference: "ext-0" });
    expect(() => transaction.markProcessed(undefined, brl("100.00"), later)).toThrow(
      InvalidWagerTransactionError,
    );
    transaction.markProcessed("t0", brl("100.00"), later);
    expect(transaction.referenceTransactionId).toBe("t0");
  });

  test("PENDING to REJECTED keeps code and observed balance", () => {
    const transaction = make(WagerTransactionKind.Bet);
    transaction.reject(FailureCode.InsufficientFunds, brl("20.00"));
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.observedBalance?.toJSON().amount).toBe("20.00");
  });

  test("PENDING to FAILED", () => {
    const transaction = make(WagerTransactionKind.Bet);
    transaction.fail(FailureCode.PermanentError);
    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.PermanentError);
  });

  test("PENDING_REFERENCE counts attempts and can be retried", () => {
    const transaction = make(WagerTransactionKind.Refund, { reference: "ext-0" });
    transaction.markPendingReference(later);
    transaction.markPendingReference(new Date("2026-11-07T12:02:00.000Z"));
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.referenceAttempts).toBe(2);
    expect(transaction.nextReferenceAttemptAt).toEqual(new Date("2026-11-07T12:02:00.000Z"));
  });

  test("PENDING_REFERENCE can end as PROCESSED or REJECTED", () => {
    const processed = make(WagerTransactionKind.Refund, { reference: "ext-0" });
    processed.markPendingReference(later);
    processed.markProcessed("t0", brl("125.00"), later);
    expect(processed.status).toBe(WagerTransactionStatus.Processed);
    expect(processed.nextReferenceAttemptAt).toBeUndefined();

    const rejected = make(WagerTransactionKind.Refund, { reference: "ext-0" });
    rejected.markPendingReference(later);
    rejected.reject(FailureCode.ReferenceNotFound, brl("100.00"));
    expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
  });

  const terminalSetups: Array<[string, (t: WagerTransaction) => void]> = [
    ["PROCESSED", (t) => t.markProcessed(undefined, brl("1.00"), later)],
    ["REJECTED", (t) => t.reject(FailureCode.InsufficientFunds, brl("1.00"))],
    ["FAILED", (t) => t.fail(FailureCode.PermanentError)],
  ];

  for (const [label, toTerminal] of terminalSetups) {
    test(`${label} is terminal: every transition throws`, () => {
      const transaction = make(WagerTransactionKind.Bet);
      toTerminal(transaction);
      expect(() => transaction.markProcessed(undefined, brl("1.00"), later)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => transaction.markPendingReference(later)).toThrow(InvalidTransactionStateError);
      expect(() => transaction.reject(FailureCode.InsufficientFunds, brl("1.00"))).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => transaction.fail(FailureCode.PermanentError)).toThrow(InvalidTransactionStateError);
    });
  }
});

describe("WagerTransaction.rehydrate", () => {
  test("rebuilds a terminal transaction without validating", () => {
    const transaction = WagerTransaction.rehydrate({
      id: "t1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash-1",
      walletId: "w1",
      playerId: "p1",
      roundId: "r1",
      gameId: "g1",
      kind: WagerTransactionKind.Refund,
      money: brl("25.00"),
      createdAt: now,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      observedBalance: brl("10.00"),
      referenceAttempts: 5,
    });
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(transaction.referenceAttempts).toBe(5);
  });
});
