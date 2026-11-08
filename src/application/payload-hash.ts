import { createHash } from "node:crypto";
import { Money } from "../domain/money";
import type { WagerCommand } from "./commands/wager-command";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(command: WagerCommand): string {
  const business = {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: Money.from(command.money).toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  };
  return createHash("sha256").update(canonicalJson(business)).digest("hex");
}
