import "reflect-metadata";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { parseWagerMessage } from "../../src/application/commands/wager-message";
import { ProcessWagerTransaction } from "../../src/application/process-wager-transaction";
import { loadEnv } from "../../src/config/env";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { SystemClock } from "../../src/infrastructure/system-clock";

const env = loadEnv();
const orm = await MikroORM.init(buildOrmConfig(env.DATABASE_URL));
const processWager = new ProcessWagerTransaction(new MikroOrmUnitOfWork(orm), new SystemClock());
const sqs = createSqsClient(env);

const response = await sqs.send(
  new ReceiveMessageCommand({
    QueueUrl: env.SQS_TRANSACTIONS_QUEUE_URL,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 3,
    VisibilityTimeout: 1,
  }),
);

const message = response.Messages?.[0];
if (!message) {
  process.exit(3);
}

const parsed = parseWagerMessage(message.Body);
await processWager.execute(parsed.data, {
  idempotencyKey: parsed.idempotencyKey,
  inbox: { messageId: parsed.messageId, consumerName: "wager-transactions-consumer" },
});
process.exit(1);
