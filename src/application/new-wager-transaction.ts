import { v7 as uuidv7 } from "uuid";
import type { Money } from "../domain/money";
import { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { WagerCommand } from "./commands/wager-command";

export function newWagerTransaction(
  command: WagerCommand,
  money: Money,
  idempotencyKey: string,
  payloadHash: string,
  createdAt: Date,
): WagerTransaction {
  return WagerTransaction.create({
    id: uuidv7(),
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    idempotencyKey,
    payloadHash,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
    createdAt,
  });
}
