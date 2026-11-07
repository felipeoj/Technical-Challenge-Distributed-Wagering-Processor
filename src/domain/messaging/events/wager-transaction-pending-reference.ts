import type { WagerTransaction } from "../../wagering/wager-transaction";
import { type EventContext, IntegrationEvent } from "./integration-event";
import { transactionEventData, type WagerTransactionEventData } from "./transaction-event-data";

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  attempts: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId as string,
        attempts: transaction.referenceAttempts,
      },
    });
  }
}
