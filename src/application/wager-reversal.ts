import { backoffDelayMs } from "../domain/messaging/backoff";
import { WagerTransactionPendingReference } from "../domain/messaging/events/wager-transaction-pending-reference";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { FailureCode } from "../domain/wagering/failure-code";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import { LedgerDirection } from "../domain/wallet/ledger-direction";
import { WagerTransactionKind } from "../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";
import {
  applyMovement,
  eventContext,
  reject,
  type SettlementContext,
} from "./settlement-steps";

export const MAX_REFERENCE_ATTEMPTS = 10;

const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export function referenceMismatch(reference: WagerTransaction, transaction: WagerTransaction): boolean {
  return (
    reference.walletId !== transaction.walletId ||
    reference.playerId !== transaction.playerId ||
    reference.roundId !== transaction.roundId ||
    reference.money.currency !== transaction.money.currency
  );
}

export async function settleReversal(context: SettlementContext): Promise<void> {
  const { repositories, transaction } = context;
  const reference = await repositories.transactions.findByProviderAndExternalId(
    transaction.providerId,
    transaction.referenceExternalTransactionId as string,
  );
  if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
    return waitForReference(context);
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(context, FailureCode.ReferenceNotProcessed);
  }
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) {
    return reject(context, FailureCode.InvalidReferenceKind);
  }
  if (referenceMismatch(reference, transaction)) {
    return reject(context, FailureCode.ReferenceMismatch);
  }
  if (!reference.money.equals(transaction.money)) {
    return reject(context, FailureCode.AmountMismatch);
  }
  if (await repositories.transactions.findProcessedReversalOf(reference.id)) {
    return reject(context, FailureCode.ReferenceAlreadyReversed);
  }
  const direction = transaction.ledgerDirectionFor(reference);
  return applyMovement(context, direction === LedgerDirection.Debit ? "debit" : "credit", {
    referenceTransactionId: reference.id,
    insufficientFundsCode: FailureCode.ReversalWouldOverdraw,
  });
}

export async function waitForReference(context: SettlementContext): Promise<void> {
  const { repositories, transaction, now } = context;
  if (transaction.referenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
    return reject(context, FailureCode.ReferenceNotFound);
  }
  const firstTime = transaction.status === WagerTransactionStatus.Pending;
  const delay = backoffDelayMs(transaction.referenceAttempts + 1);
  transaction.markPendingReference(new Date(now.getTime() + delay));
  await repositories.transactions.save(transaction);
  if (firstTime) {
    await repositories.outbox.add(
      OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext(context))),
    );
  }
}
