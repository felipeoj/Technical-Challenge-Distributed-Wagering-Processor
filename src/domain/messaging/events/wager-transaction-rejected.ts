import type { MoneyProps } from "../../money";
import type { FailureCode } from "../../wagering/failure-code";
import type { WagerTransaction } from "../../wagering/wager-transaction";
import { type EventContext, IntegrationEvent } from "./integration-event";
import {
  observedBalanceOf,
  transactionEventData,
  type WagerTransactionEventData,
} from "./transaction-event-data";

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        failureCode: transaction.failureCode as FailureCode,
        balance: observedBalanceOf(transaction).toJSON(),
      },
    });
  }
}
