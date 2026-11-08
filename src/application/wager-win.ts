import { FailureCode } from "../domain/wagering/failure-code";
import { WagerTransactionKind } from "../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";
import { applyMovement, reject, type SettlementContext } from "./settlement-steps";
import { referenceMismatch, waitForReference } from "./wager-reversal";

export async function settleWin(context: SettlementContext): Promise<void> {
  const { repositories, transaction } = context;
  if (!transaction.referenceExternalTransactionId) {
    return applyMovement(context, "credit");
  }
  const reference = await repositories.transactions.findByProviderAndExternalId(
    transaction.providerId,
    transaction.referenceExternalTransactionId,
  );
  if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
    return waitForReference(context);
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return reject(context, FailureCode.ReferenceNotProcessed);
  }
  if (reference.kind !== WagerTransactionKind.Bet) {
    return reject(context, FailureCode.InvalidReferenceKind);
  }
  if (referenceMismatch(reference, transaction)) {
    return reject(context, FailureCode.ReferenceMismatch);
  }
  return applyMovement(context, "credit", { referenceTransactionId: reference.id });
}
