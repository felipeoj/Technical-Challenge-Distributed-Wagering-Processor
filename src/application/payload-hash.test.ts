import { describe, expect, test } from "bun:test";
import { InvalidCommandError, InvalidMoneyError } from "../domain/errors";
import { parseWagerCommand } from "./commands/wager-command";
import { canonicalJson, payloadHash } from "./payload-hash";

const raw = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("ignores undefined fields", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("payloadHash", () => {
  test("does not depend on the order of the fields", () => {
    const reordered = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: raw.gameId,
      roundId: raw.roundId,
      walletId: raw.walletId,
      playerId: raw.playerId,
      externalTransactionId: raw.externalTransactionId,
      providerId: raw.providerId,
    };
    expect(payloadHash(parseWagerCommand(reordered))).toBe(payloadHash(parseWagerCommand(raw)));
  });

  test("ignores fields that are not business data", () => {
    const withExtras = { ...raw, idempotencyKey: "provider-a:transaction-123", traceId: "abc" };
    expect(payloadHash(parseWagerCommand(withExtras))).toBe(payloadHash(parseWagerCommand(raw)));
  });

  test("changes when any business field changes", () => {
    const base = payloadHash(parseWagerCommand(raw));
    expect(payloadHash(parseWagerCommand({ ...raw, money: { amount: "26.00", currency: "BRL" } }))).not.toBe(base);
    expect(payloadHash(parseWagerCommand({ ...raw, kind: "WIN" }))).not.toBe(base);
    expect(payloadHash(parseWagerCommand({ ...raw, roundId: "round-1" }))).not.toBe(base);
  });

  test("is a 64 character sha-256 hex digest", () => {
    expect(payloadHash(parseWagerCommand(raw))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseWagerCommand", () => {
  test("OPENING cannot be submitted from outside", () => {
    expect(() => parseWagerCommand({ ...raw, kind: "OPENING" })).toThrow(InvalidCommandError);
  });

  test("rejects missing fields and reports their names, not their values", () => {
    const { roundId: _removed, ...incomplete } = raw;
    expect(() => parseWagerCommand(incomplete)).toThrow(/roundId/);
  });

  test("rejects a wallet id that is not a uuid", () => {
    expect(() => parseWagerCommand({ ...raw, walletId: "wallet-1" })).toThrow(InvalidCommandError);
  });

  test("rejects an amount sent as a number", () => {
    expect(() => parseWagerCommand({ ...raw, money: { amount: 25, currency: "BRL" } })).toThrow(
      InvalidCommandError,
    );
  });

  test("the payload hash rejects a badly formatted amount", () => {
    const command = parseWagerCommand({ ...raw, money: { amount: "25", currency: "BRL" } });
    expect(() => payloadHash(command)).toThrow(InvalidMoneyError);
  });
});
