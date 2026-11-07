import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError } from "../../errors";
import { Money } from "../../money";
import { FailureCode } from "../../wagering/failure-code";
import { WagerTransaction } from "../../wagering/wager-transaction";
import { WagerTransactionKind } from "../../wagering/wager-transaction-kind";
import { WagerTransactionPendingReference } from "./wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "./wager-transaction-processed";
import { WagerTransactionRejected } from "./wager-transaction-rejected";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-07T12:00:00.000Z");
const ctx = { eventId: "ev1", correlationId: "c1", occurredAt: at };

const make = (kind: WagerTransactionKind, reference?: string) =>
  WagerTransaction.create({
    id: "t1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "h1",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind,
    money: brl("25.00"),
    referenceExternalTransactionId: reference,
    createdAt: at,
  });

describe("transaction events", () => {
  test("WagerTransactionProcessed carries the observed balance as strings", () => {
    const transaction = make(WagerTransactionKind.Bet);
    transaction.markProcessed(undefined, brl("75.00"), at);
    const json = WagerTransactionProcessed.from(transaction, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.aggregateId).toBe("w1");
    expect(json.data.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(json.data.kind).toBe(WagerTransactionKind.Bet);
  });

  test("WagerTransactionRejected carries the failure code", () => {
    const transaction = make(WagerTransactionKind.Bet);
    transaction.reject(FailureCode.InsufficientFunds, brl("20.00"));
    const json = WagerTransactionRejected.from(transaction, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.balance.amount).toBe("20.00");
  });

  test("WagerTransactionPendingReference carries the missing reference", () => {
    const transaction = make(WagerTransactionKind.Refund, "ext-0");
    transaction.markPendingReference(at);
    const json = WagerTransactionPendingReference.from(transaction, ctx).toJSON();
    expect(json.eventType).toBe("WagerTransactionPendingReference");
    expect(json.data.referenceExternalTransactionId).toBe("ext-0");
    expect(json.data.attempts).toBe(1);
  });

  test("an event cannot be built before the transaction has an observed balance", () => {
    expect(() => WagerTransactionProcessed.from(make(WagerTransactionKind.Bet), ctx)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("the serialized envelope is plain JSON", () => {
    const transaction = make(WagerTransactionKind.Bet);
    transaction.markProcessed(undefined, brl("75.00"), at);
    const event = WagerTransactionProcessed.from(transaction, ctx);
    expect(JSON.parse(JSON.stringify(event))).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
  });
});
