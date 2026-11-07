import type { SqlEntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../../application/repositories";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../../domain/wagering/wager-transaction-kind";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction-status";
import {
  transactionStateData,
  transactionToDomain,
  transactionToRecordData,
} from "../mappers/wager-transaction.mapper";
import { WagerTransactionRecord } from "../schemas/wager-transaction.schema";

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(WagerTransactionRecord)
      .insert(transactionToRecordData(transaction))
      .onConflict()
      .ignore()
      .execute();
    return result.affectedRows === 1;
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ id });
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ idempotencyKey: key });
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      {
        referenceTransactionId,
        status: WagerTransactionStatus.Processed,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      },
      { refresh: true },
    );
    return record ? transactionToDomain(record) : undefined;
  }

  async findDueForReferenceRetry(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: "asc" }, limit, refresh: true },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      transactionStateData(transaction),
    );
  }

  private async findOneBy(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
    return record ? transactionToDomain(record) : undefined;
  }
}
