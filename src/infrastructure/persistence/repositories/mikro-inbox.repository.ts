import type { SqlEntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository } from "../../../application/repositories";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import { inboxToRecordData } from "../mappers/messaging.mapper";
import { InboxMessageRecord } from "../schemas/inbox-message.schema";

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async receive(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxMessageRecord)
      .insert(inboxToRecordData(message))
      .onConflict()
      .ignore()
      .execute();
    return result.affectedRows === 1;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}
