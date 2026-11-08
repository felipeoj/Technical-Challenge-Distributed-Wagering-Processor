import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { type Clock, type Observability, silentObservability } from "../../application/ports";
import type { UnitOfWork } from "../../application/unit-of-work";

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
      for (const message of messages) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
            }),
          );
          message.markPublished(this.clock.now());
          count += 1;
        } catch (error) {
          message.scheduleRetry(this.clock.now());
          this.observability.metrics.retry("outbox");
          this.observability.logger.warn("outbox_publish_failed", {
            eventId: message.id,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            reason: error instanceof Error ? error.name : "unknown",
          });
        }
        await repositories.outbox.save(message);
      }
      return count;
    });

    const oldest = await this.uow.run((repositories) => repositories.outbox.oldestPendingAt());
    const lagSeconds = oldest ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000) : 0;
    this.observability.metrics.outboxLag(lagSeconds);
    return published;
  }
}
