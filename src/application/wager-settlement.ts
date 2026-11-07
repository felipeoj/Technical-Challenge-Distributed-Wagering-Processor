import { FailureCode } from "../domain/wagering/failure-code";
import { WagerTransactionKind } from "../domain/wagering/wager-transaction-kind";
import {
  applyMovement,
  recordWithoutMovement,
  reject,
  type SettlementContext,
} from "./settlement-steps";
import { settleReversal } from "./wager-reversal";

export async function settle(context: SettlementContext): Promise<void> {
  const { wallet, transaction } = context;
  if (transaction.money.currency !== wallet.currency) {
    return reject(context, FailureCode.CurrencyMismatch);
  }
  if (transaction.playerId !== wallet.playerId) {
    return reject(context, FailureCode.PlayerMismatch);
  }
  switch (transaction.kind) {
    case WagerTransactionKind.Bet:
      return applyMovement(context, "debit");
    case WagerTransactionKind.Win:
      return applyMovement(context, "credit");
    case WagerTransactionKind.Loss:
      return recordWithoutMovement(context);
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return settleReversal(context);
    default:
      throw new Error(`${transaction.kind} cannot be settled from outside`);
  }
}
