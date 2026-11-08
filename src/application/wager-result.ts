import type { MoneyProps } from "../domain/money";
import type { FailureCode } from "../domain/wagering/failure-code";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function toWagerResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}
