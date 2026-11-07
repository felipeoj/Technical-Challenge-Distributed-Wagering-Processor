import { describe, expect, test } from "bun:test";
import { InvalidMessageStateError } from "../errors";
import { Money } from "../money";
import { LedgerDirection } from "../wallet/ledger-direction";
import { Wallet } from "../wallet/wallet";
import { WalletBalanceChanged } from "./events/wallet-balance-changed";
import { OutboxMessage } from "./outbox-message";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-07T12:00:00.000Z");

const buildMessage = () => {
  const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("100.00"), at });
  const entry = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("25.00"), at });
  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: "ev1",
    correlationId: "c1",
    causationId: "t1",
    occurredAt: at,
  });
  return { event, message: OutboxMessage.enqueue(event) };
};

describe("WalletBalanceChanged event", () => {
  test("serializes the envelope with money as strings", () => {
    const { event } = buildMessage();
    expect(event.toJSON()).toEqual({
      eventId: "ev1",
      eventType: "WalletBalanceChanged",
      aggregateId: "w1",
      correlationId: "c1",
      causationId: "t1",
      occurredAt: "2026-11-07T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "w1",
        transactionId: "t1",
        direction: LedgerDirection.Debit,
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("omits causationId when absent", () => {
    const wallet = Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl("10.00"), at });
    const entry = wallet.credit({ entryId: "e1", transactionId: "t1", money: brl("1.00"), at });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: "ev2",
      correlationId: "c1",
      occurredAt: at,
    });
    expect("causationId" in event.toJSON()).toBe(false);
  });
});

describe("OutboxMessage", () => {
  test("enqueue creates a pending message that is due immediately", () => {
    const { message } = buildMessage();
    expect(message.id).toBe("ev1");
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.payload.eventType).toBe("WalletBalanceChanged");
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  test("scheduleRetry increments attempts and applies exponential backoff", () => {
    const { message } = buildMessage();
    message.scheduleRetry(at);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(at.getTime() + 1000));
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 1000))).toBe(true);
    message.scheduleRetry(at);
    expect(message.nextAttemptAt).toEqual(new Date(at.getTime() + 2000));
  });

  test("markPublished ends the pending state", () => {
    const { message } = buildMessage();
    const publishedAt = new Date("2026-11-07T12:00:05.000Z");
    message.markPublished(publishedAt);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(publishedAt)).toBe(false);
    expect(message.publishedAt).toEqual(publishedAt);
  });

  test("a published message cannot be published or retried again", () => {
    const { message } = buildMessage();
    message.markPublished(at);
    expect(() => message.markPublished(at)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(at)).toThrow(InvalidMessageStateError);
  });

  test("rehydrate restores attempts and schedule", () => {
    const message = OutboxMessage.rehydrate({
      id: "ev1",
      aggregateId: "w1",
      eventType: "WalletBalanceChanged",
      payload: {},
      occurredAt: at,
      attempts: 3,
      nextAttemptAt: at,
    });
    expect(message.attempts).toBe(3);
    expect(message.isDue(at)).toBe(true);
  });
});
