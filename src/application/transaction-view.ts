import type { MoneyProps } from "../domain/money";
import type { FailureCode } from "../domain/wagering/failure-code";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { WagerTransactionKind } from "../domain/wagering/wager-transaction-kind";
import type { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  roundId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  referenceAttempts: number;
  createdAt: string;
  processedAt?: string;
}

export function toTransactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    balance: transaction.observedBalance?.toJSON(),
    failureCode: transaction.failureCode,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    referenceAttempts: transaction.referenceAttempts,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
  };
}
