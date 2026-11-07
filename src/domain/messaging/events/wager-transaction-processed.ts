import type { MoneyProps } from "../../money";
import type { WagerTransaction } from "../../wagering/wager-transaction";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  observedBalanceOf,
  transactionEventData,
  type WagerTransactionEventData,
} from "./transaction-event-data";

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        balance: observedBalanceOf(transaction).toJSON(),
      },
    });
  }
}
