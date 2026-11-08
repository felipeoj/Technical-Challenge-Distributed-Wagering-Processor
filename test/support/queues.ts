import {
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../../src/config/env";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";

export const env = loadEnv();
export const sqs = createSqsClient(env);

const queueBase = env.SQS_TRANSACTIONS_QUEUE_URL.replace(/[^/]+$/, "");

export const queues = {
  transactions: `${queueBase}wager-transactions-test.fifo`,
  dlq: `${queueBase}wager-transactions-test-dlq.fifo`,
  events: `${queueBase}wager-events-test.fifo`,
};

export const queueEnv = {
  SQS_TRANSACTIONS_QUEUE_URL: queues.transactions,
  SQS_TRANSACTIONS_DLQ_URL: queues.dlq,
  SQS_EVENTS_QUEUE_URL: queues.events,
};

export async function purgeAll(): Promise<void> {
  for (const url of Object.values(queues)) {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
  }
}

export function wagerMessageBody(data: Record<string, unknown>, messageId: string): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  });
}

export async function sendRaw(body: string, groupId: string, deduplicationId: string = randomUUID()): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.transactions,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

export async function sendWagerMessage(
  data: Record<string, unknown>,
  options: { messageId?: string; deduplicationId?: string } = {},
): Promise<string> {
  const messageId = options.messageId ?? randomUUID();
  await sendRaw(wagerMessageBody(data, messageId), String(data.walletId), options.deduplicationId);
  return messageId;
}

export async function receiveAll(
  queueUrl: string,
  options: { remove?: boolean; rounds?: number } = {},
): Promise<Message[]> {
  const collected: Message[] = [];
  let emptyRounds = 0;
  for (let round = 0; round < (options.rounds ?? 8) && emptyRounds < 2; round += 1) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: options.remove === false ? 0 : 30,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    const messages = response.Messages ?? [];
    emptyRounds = messages.length === 0 ? emptyRounds + 1 : 0;
    for (const message of messages) {
      collected.push(message);
      if (options.remove !== false) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
    }
    if (options.remove === false && messages.length > 0) {
      break;
    }
  }
  return collected;
}
