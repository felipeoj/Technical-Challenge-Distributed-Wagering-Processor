import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { type Clock, type Observability, silentObservability } from "../../application/ports";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { UnitOfWork } from "../../application/unit-of-work";

const SQS_BATCH_LIMIT = 10;

export class OutboxPublisher {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly clock: Clock,
    private readonly observability: Observability = silentObservability,
  ) {}

  async publishBatch(limit = 20): Promise<number> {
    const published = await this.uow.run(async (repositories) => {
      const messages = await repositories.outbox.claimDue(this.clock.now(), limit);
      let count = 0;
      for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
        const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
        const failed = await this.send(chunk);
        for (const message of chunk) {
          if (failed.has(message.id)) {
            message.scheduleRetry(this.clock.now());
            this.observability.metrics.retry("outbox");
            this.observability.logger.warn("outbox_publish_failed", {
              eventId: message.id,
              aggregateId: message.aggregateId,
              attempts: message.attempts,
              reason: failed.get(message.id),
            });
          } else {
            message.markPublished(this.clock.now());
            count += 1;
          }
          await repositories.outbox.save(message);
        }
      }
      return count;
    });

    const oldest = await this.uow.run((repositories) => repositories.outbox.oldestPendingAt());
    const lagSeconds = oldest ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000) : 0;
    this.observability.metrics.outboxLag(lagSeconds);
    return published;
  }

  private async send(chunk: OutboxMessage[]): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    try {
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((message) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
          })),
        }),
      );
      const accepted = new Set(response.Successful?.map((entry) => entry.Id));
      for (const message of chunk) {
        if (accepted.has(message.id)) continue;
        const refusal = response.Failed?.find((entry) => entry.Id === message.id);
        failed.set(message.id, refusal?.Code ?? "not_confirmed");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown";
      for (const message of chunk) failed.set(message.id, reason);
    }
    return failed;
  }
}
