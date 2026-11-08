import { describe, expect, test } from "bun:test";
import { InvalidCommandError } from "../../domain/errors";
import { parseOpenWalletCommand } from "./open-wallet-command";
import { parseWagerCommand } from "./wager-command";

const valid = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("null bytes in text fields", () => {
  test("a valid command is accepted", () => {
    expect(parseWagerCommand(valid).providerId).toBe("provider-a");
  });

  test.each(["providerId", "externalTransactionId", "playerId", "roundId", "gameId", "referenceExternalTransactionId"])(
    "%s with a null byte is an invalid command, not a database error",
    (field) => {
      expect(() => parseWagerCommand({ ...valid, [field]: "a\u0000b" })).toThrow(InvalidCommandError);
    },
  );

  test("open wallet rejects a player id with a null byte", () => {
    expect(() => parseOpenWalletCommand({ playerId: "a\u0000b", initialBalance: { amount: "1.00", currency: "BRL" } })).toThrow(
      InvalidCommandError,
    );
  });
});
