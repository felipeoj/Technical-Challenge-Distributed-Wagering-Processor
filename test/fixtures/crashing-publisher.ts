import "reflect-metadata";
import type { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../../src/config/env";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { OutboxPublisher } from "../../src/infrastructure/sqs/outbox-publisher";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { SystemClock } from "../../src/infrastructure/system-clock";

const crashPoint = process.argv[2];
if (crashPoint !== "before_send" && crashPoint !== "after_send") {
  console.error("usage: crashing-publisher.ts before_send|after_send");
  process.exit(2);
}

const env = loadEnv();
const orm = await MikroORM.init(buildOrmConfig(env.DATABASE_URL));
const sqs = createSqsClient(env);

const crashingSqs = {
  async send(command: SendMessageBatchCommand) {
    if (crashPoint === "before_send") process.exit(1);
    await sqs.send(command);
    process.exit(1);
  },
} as unknown as SQSClient;

const publisher = new OutboxPublisher(new MikroOrmUnitOfWork(orm), crashingSqs, env.SQS_EVENTS_QUEUE_URL, new SystemClock());
await publisher.publishBatch(100);
