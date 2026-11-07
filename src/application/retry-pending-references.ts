import { v7 as uuidv7 } from "uuid";
import { TransientInfrastructureError } from "../domain/errors";
import { WagerTransactionStatus } from "../domain/wagering/wager-transaction-status";
import { type Clock, type Observability, silentObservability } from "./ports";
import type { UnitOfWork } from "./unit-of-work";
import { settle } from "./wager-settlement";

export class RetryPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly observability: Observability = silentObservability,
  ) {}

  async execute(limit = 50): Promise<number> {
    const due = await this.uow.run((repositories) =>
      repositories.transactions.findDueForReferenceRetry(this.clock.now(), limit),
    );
    let retried = 0;
    for (const item of due) {
      try {
        if (await this.retryOne(item.id, item.walletId)) {
          retried += 1;
          this.observability.metrics.retry("pending_reference");
        }
      } catch (error) {
        if (!(error instanceof TransientInfrastructureError)) {
          throw error;
        }
      }
    }
    return retried;
  }

  private retryOne(transactionId: string, walletId: string): Promise<boolean> {
    return this.uow.run(async (repositories) => {
      const now = this.clock.now();
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      const transaction = await repositories.transactions.findById(transactionId);
      const stillDue =
        transaction?.status === WagerTransactionStatus.PendingReference &&
        (transaction.nextReferenceAttemptAt === undefined || transaction.nextReferenceAttemptAt <= now);
      if (!wallet || !transaction || !stillDue) {
        return false;
      }
      await settle({ repositories, wallet, transaction, now, correlationId: uuidv7() });
      return true;
    });
  }
}
