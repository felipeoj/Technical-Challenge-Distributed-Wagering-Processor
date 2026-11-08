import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { parseWagerMessage, type WagerMessage } from "../../application/commands/wager-message";
import type { FailWagerTransaction } from "../../application/fail-wager-transaction";
import { type Observability, silentObservability } from "../../application/ports";
import type { ProcessWagerTransaction } from "../../application/process-wager-transaction";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
} from "../../domain/errors";

export interface ConsumerOptions {
  consumerName?: string;
  waitSeconds?: number;
  maxReceiveCount?: number;
  visibilityBackoffSeconds?: (receiveCount: number) => number;
}

type Outcome = "business" | "permanent" | "transient";

function classify(error: unknown): Outcome {
  if (error instanceof WalletNotFoundError || error instanceof IdempotencyConflictError) {
    return "business";
  }
  if (
    error instanceof InvalidCommandError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError
  ) {
    return "permanent";
  }
  return "transient";
}

const defaultBackoff = (receiveCount: number) => Math.min(60, 2 ** receiveCount);

export class WagerQueueConsumer {
  private readonly consumerName: string;
  private readonly waitSeconds: number;
  private readonly maxReceiveCount: number;
  private readonly backoff: (receiveCount: number) => number;

  constructor(
    private readonly sqs: SQSClient,
    private readonly urls: { queue: string; dlq: string },
    private readonly processWager: ProcessWagerTransaction,
    private readonly failWager: FailWagerTransaction,
    private readonly observability: Observability = silentObservability,
    options: ConsumerOptions = {},
  ) {
    this.consumerName = options.consumerName ?? "wager-transactions-consumer";
    this.waitSeconds = options.waitSeconds ?? 2;
    this.maxReceiveCount = options.maxReceiveCount ?? 5;
    this.backoff = options.visibilityBackoffSeconds ?? defaultBackoff;
  }

  async pollOnce(shouldStop: () => boolean = () => false): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urls.queue,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    let handled = 0;
    for (const message of response.Messages ?? []) {
      if (shouldStop()) {
        await this.changeVisibility(message, 0);
        continue;
      }
      await this.handle(message);
      handled += 1;
    }
    return handled;
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let parsed: WagerMessage | undefined;
    try {
      parsed = parseWagerMessage(message.Body);
      const result = await this.processWager.execute(parsed.data, {
        idempotencyKey: parsed.idempotencyKey,
        inbox: { messageId: parsed.messageId, consumerName: this.consumerName },
      });
      this.observability.logger.info("message_processed", {
        messageId: parsed.messageId,
        transactionId: result.transactionId,
        status: result.status,
        replay: result.idempotentReplay,
        receiveCount,
      });
      await this.acknowledge(message);
    } catch (error) {
      await this.recover(message, error, receiveCount, parsed);
    }
  }

  private async recover(
    message: Message,
    error: unknown,
    receiveCount: number,
    parsed: WagerMessage | undefined,
  ): Promise<void> {
    const outcome = classify(error);
    const reason = error instanceof Error ? error.name : "unknown";
    if (outcome === "business") {
      this.observability.logger.warn("message_dropped_business", { sqsMessageId: message.MessageId, reason });
      await this.acknowledge(message);
      return;
    }
    if (outcome === "permanent") {
      try {
        await this.sendToDeadLetterQueue(message, reason);
        await this.acknowledge(message);
        this.observability.metrics.dlqMessage();
        this.observability.logger.error("message_sent_to_dlq", { sqsMessageId: message.MessageId, reason });
        return;
      } catch {
        await this.retryLater(message, receiveCount, reason, parsed);
        return;
      }
    }
    await this.retryLater(message, receiveCount, reason, parsed);
  }

  private async retryLater(
    message: Message,
    receiveCount: number,
    reason: string,
    parsed: WagerMessage | undefined,
  ): Promise<void> {
    this.observability.metrics.retry("sqs");
    if (receiveCount >= this.maxReceiveCount) {
      await this.recordFailure(parsed);
      this.observability.metrics.dlqMessage();
      this.observability.logger.error("message_retries_exhausted", {
        sqsMessageId: message.MessageId,
        receiveCount,
        reason,
      });
    } else {
      this.observability.logger.warn("message_will_retry", {
        sqsMessageId: message.MessageId,
        receiveCount,
        reason,
      });
    }
    await this.changeVisibility(message, this.backoff(receiveCount));
  }

  private async recordFailure(parsed: WagerMessage | undefined): Promise<void> {
    if (!parsed) {
      return;
    }
    try {
      await this.failWager.execute(parsed.data, {
        idempotencyKey: parsed.idempotencyKey,
        inbox: { messageId: parsed.messageId, consumerName: this.consumerName },
      });
    } catch (error) {
      this.observability.logger.warn("failure_not_recorded", {
        messageId: parsed.messageId,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private async acknowledge(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.urls.queue, ReceiptHandle: message.ReceiptHandle }));
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.urls.queue,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async sendToDeadLetterQueue(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.urls.dlq,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "poison",
        MessageDeduplicationId: `dlq-${message.MessageId}`,
        MessageAttributes: { failureReason: { DataType: "String", StringValue: reason } },
      }),
    );
  }
}
