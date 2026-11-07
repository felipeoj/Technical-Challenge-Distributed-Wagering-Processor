import { InvalidTransactionStateError } from "../../errors";
import type { Money, MoneyProps } from "../../money";
import type { WagerTransaction } from "../../wagering/wager-transaction";
import type { WagerTransactionKind } from "../../wagering/wager-transaction-kind";

export interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export function transactionEventData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

export function observedBalanceOf(transaction: WagerTransaction): Money {
  if (!transaction.observedBalance) {
    throw new InvalidTransactionStateError("transaction has no observed balance yet");
  }
  return transaction.observedBalance;
}
