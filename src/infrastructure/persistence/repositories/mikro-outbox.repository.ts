import { LockMode, type SqlEntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository } from "../../../application/repositories";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { outboxToRecordData } from "../mappers/messaging.mapper";
import { OutboxMessageRecord } from "../schemas/outbox-message.schema";

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageRecord, outboxToRecordData(message));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      {
        orderBy: { occurredAt: "asc" },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return records.map((record) =>
      OutboxMessage.rehydrate({
        id: record.id,
        aggregateId: record.aggregateId,
        eventType: record.eventType,
        payload: record.payload,
        occurredAt: record.occurredAt,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt ?? undefined,
        publishedAt: record.publishedAt ?? undefined,
      }),
    );
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async oldestPendingAt(): Promise<Date | undefined> {
    const record = await this.em.findOne(
      OutboxMessageRecord,
      { publishedAt: null },
      { orderBy: { occurredAt: "asc" }, refresh: true },
    );
    return record?.occurredAt;
  }
}
