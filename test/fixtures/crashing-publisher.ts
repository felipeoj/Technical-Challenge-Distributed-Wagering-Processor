import "reflect-metadata";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../../src/config/env";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";

const crashPoint = process.argv[2];
if (crashPoint !== "before_send" && crashPoint !== "after_send") {
  console.error("usage: crashing-publisher.ts before_send|after_send");
  process.exit(2);
}

const env = loadEnv();
const orm = await MikroORM.init(buildOrmConfig(env.DATABASE_URL));
const uow = new MikroOrmUnitOfWork(orm);
const sqs = createSqsClient(env);

await uow.run(async (repositories) => {
  const messages = await repositories.outbox.claimDue(new Date(), 100);
  if (crashPoint === "before_send") {
    process.exit(1);
  }
  for (const message of messages) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: env.SQS_EVENTS_QUEUE_URL,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }
  process.exit(1);
});
