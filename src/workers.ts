import type { SQSClient } from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { CLOCK, ENV, OBSERVABILITY, SQS, UNIT_OF_WORK } from "./app.tokens";
import type { Clock, Observability } from "./application/ports";
import { FailWagerTransaction } from "./application/fail-wager-transaction";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { RetryPendingReferences } from "./application/retry-pending-references";
import type { UnitOfWork } from "./application/unit-of-work";
import type { Env } from "./config/env";
import { OutboxPublisher } from "./infrastructure/sqs/outbox-publisher";
import { WagerQueueConsumer } from "./infrastructure/sqs/wager-consumer";
import { PollingWorker } from "./infrastructure/workers/polling-worker";
import { WorkerRegistry } from "./infrastructure/workers/worker-registry";

export function startWorkers(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  const sqs = app.get<SQSClient>(SQS);
  const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
  const clock = app.get<Clock>(CLOCK);
  const observability = app.get<Observability>(OBSERVABILITY);
  const registry = app.get(WorkerRegistry);

  const publisher = new OutboxPublisher(uow, sqs, env.SQS_EVENTS_QUEUE_URL, clock, observability);
  const consumer = new WagerQueueConsumer(
    sqs,
    { queue: env.SQS_TRANSACTIONS_QUEUE_URL, dlq: env.SQS_TRANSACTIONS_DLQ_URL },
    app.get(ProcessWagerTransaction),
    app.get(FailWagerTransaction),
    observability,
  );
  const retryReferences = app.get(RetryPendingReferences);

  const { logger } = observability;
  registry.start(new PollingWorker("outbox-publisher", () => publisher.publishBatch(), 500, logger));
  registry.start(new PollingWorker("sqs-consumer", (shouldStop) => consumer.pollOnce(shouldStop), 100, logger));
  registry.start(new PollingWorker("pending-references", () => retryReferences.execute(), 1000, logger));
}
