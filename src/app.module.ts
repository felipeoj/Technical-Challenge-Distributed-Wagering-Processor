import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  CLOCK,
  ENV,
  LOGGER,
  NEST_LOGGER,
  OBSERVABILITY,
  ORM,
  METRICS,
  SQS,
  UNIT_OF_WORK,
} from "./app.tokens";
import { FailWagerTransaction } from "./application/fail-wager-transaction";
import { OpenWallet } from "./application/open-wallet";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import type { Clock, Observability } from "./application/ports";
import { GetTransaction } from "./application/queries/get-transaction";
import { GetWallet } from "./application/queries/get-wallet";
import { ListLedger } from "./application/queries/list-ledger";
import { ReconcileWallet } from "./application/queries/reconcile-wallet";
import { RetryPendingReferences } from "./application/retry-pending-references";
import type { UnitOfWork } from "./application/unit-of-work";
import { type Env, loadEnv } from "./config/env";
import { NoopAuthGuard } from "./http/auth/auth.guard";
import { HttpErrorFilter } from "./http/http-error.filter";
import { TracingInterceptor } from "./http/tracing.interceptor";
import { WageringController } from "./http/wagering.controller";
import { WalletsController } from "./http/wallets.controller";
import { HealthController } from "./infrastructure/health/health.controller";
import { MetricsController } from "./infrastructure/observability/metrics.controller";
import { NestLoggerAdapter } from "./infrastructure/observability/nest-logger";
import { PinoLogger } from "./infrastructure/observability/pino-logger";
import { OpenTelemetryMetrics } from "./infrastructure/observability/otel-metrics";
import { stopTracing } from "./infrastructure/observability/tracing";
import { buildOrmConfig } from "./infrastructure/persistence/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-unit-of-work";
import { createSqsClient } from "./infrastructure/sqs/sqs-client";
import { SystemClock } from "./infrastructure/system-clock";
import { WorkerRegistry } from "./infrastructure/workers/worker-registry";

class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

class SqsShutdown implements OnApplicationShutdown {
  constructor(@Inject(SQS) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

class TracingShutdown implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return stopTracing();
  }
}

@Module({
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    { provide: METRICS, useFactory: () => new OpenTelemetryMetrics() },
    { provide: LOGGER, useFactory: (env: Env) => new PinoLogger(env.LOG_LEVEL), inject: [ENV] },
    { provide: NEST_LOGGER, useFactory: (logger: PinoLogger) => new NestLoggerAdapter(logger), inject: [LOGGER] },
    {
      provide: OBSERVABILITY,
      useFactory: (logger: PinoLogger, metrics: OpenTelemetryMetrics): Observability => ({ logger, metrics }),
      inject: [LOGGER, METRICS],
    },
    { provide: SQS, useFactory: (env: Env) => createSqsClient(env), inject: [ENV] },
    { provide: ORM, useFactory: (env: Env) => MikroORM.init(buildOrmConfig(env.DATABASE_URL)), inject: [ENV] },
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM, metrics: OpenTelemetryMetrics) => new MikroOrmUnitOfWork(orm, metrics),
      inject: [ORM, METRICS],
    },
    { provide: CLOCK, useFactory: () => new SystemClock() },
    {
      provide: OpenWallet,
      useFactory: (uow: UnitOfWork, clock: Clock) => new OpenWallet(uow, clock),
      inject: [UNIT_OF_WORK, CLOCK],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, clock: Clock, observability: Observability) =>
        new ProcessWagerTransaction(uow, clock, observability),
      inject: [UNIT_OF_WORK, CLOCK, OBSERVABILITY],
    },
    {
      provide: FailWagerTransaction,
      useFactory: (uow: UnitOfWork, clock: Clock, observability: Observability) =>
        new FailWagerTransaction(uow, clock, observability),
      inject: [UNIT_OF_WORK, CLOCK, OBSERVABILITY],
    },
    {
      provide: RetryPendingReferences,
      useFactory: (uow: UnitOfWork, clock: Clock, observability: Observability) =>
        new RetryPendingReferences(uow, clock, observability),
      inject: [UNIT_OF_WORK, CLOCK, OBSERVABILITY],
    },
    { provide: GetWallet, useFactory: (uow: UnitOfWork) => new GetWallet(uow), inject: [UNIT_OF_WORK] },
    { provide: GetTransaction, useFactory: (uow: UnitOfWork) => new GetTransaction(uow), inject: [UNIT_OF_WORK] },
    { provide: ListLedger, useFactory: (uow: UnitOfWork) => new ListLedger(uow), inject: [UNIT_OF_WORK] },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork, observability: Observability) => new ReconcileWallet(uow, observability),
      inject: [UNIT_OF_WORK, OBSERVABILITY],
    },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    { provide: APP_GUARD, useClass: NoopAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
    { provide: WorkerRegistry, useFactory: (logger: PinoLogger) => new WorkerRegistry(logger), inject: [LOGGER] },
    DatabaseShutdown,
    SqsShutdown,
    TracingShutdown,
  ],
})
export class AppModule {}
