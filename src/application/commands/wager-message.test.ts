import { describe, expect, test } from "bun:test";
import { InvalidCommandError } from "../../domain/errors";
import { parseWagerMessage } from "./wager-message";

const data = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  idempotencyKey: "provider-a:transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

const message = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data,
    ...overrides,
  });

describe("parseWagerMessage", () => {
  test("reads the message exactly as the statement defines it", () => {
    const parsed = parseWagerMessage(message());
    expect(parsed.messageId).toBe("msg-123");
    expect(parsed.idempotencyKey).toBe("provider-a:transaction-123");
    expect(parsed.data.kind).toBe("BET");
  });

  test("falls back to provider and external id when there is no idempotency key", () => {
    const { idempotencyKey: _removed, ...withoutKey } = data;
    expect(parseWagerMessage(message({ data: withoutKey })).idempotencyKey).toBe("provider-a:transaction-123");
  });

  test.each([
    ["not json", "{oops"],
    ["empty body", ""],
    ["a different type", message({ type: "Other" })],
    ["no message id", message({ messageId: "" })],
    ["no data", message({ data: undefined })],
    ["data that is not an object", message({ data: "x" })],
  ])("rejects %s", (_label, body) => {
    expect(() => parseWagerMessage(body)).toThrow(InvalidCommandError);
  });

  test("rejects a message that gives no way to build an idempotency key", () => {
    expect(() => parseWagerMessage(message({ data: { kind: "BET" } }))).toThrow(InvalidCommandError);
  });

  test("an undefined body is rejected", () => {
    expect(() => parseWagerMessage(undefined)).toThrow(InvalidCommandError);
  });
});
