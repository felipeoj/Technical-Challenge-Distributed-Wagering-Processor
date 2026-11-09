import type { MikroORM, SqlEntityManager } from "@mikro-orm/postgresql";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { type Metrics, silentObservability } from "../../application/ports";
import type { Repositories } from "../../application/repositories";
import type { UnitOfWork } from "../../application/unit-of-work";
import { TransientInfrastructureError } from "../../domain/errors";
import { translateDatabaseError } from "./error-translator";
import { MikroInboxRepository } from "./repositories/mikro-inbox.repository";
import { MikroLedgerRepository } from "./repositories/mikro-ledger.repository";
import { MikroOutboxRepository } from "./repositories/mikro-outbox.repository";
import { MikroWagerTransactionRepository } from "./repositories/mikro-wager-transaction.repository";
import { MikroWalletRepository } from "./repositories/mikro-wallet.repository";

const LOCK_CONFLICT_SQLSTATES = new Set(["55P03", "40P01", "40001"]);
const tracer = trace.getTracer("persistence");

function createRepositories(em: SqlEntityManager): Repositories {
  return {
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics = silentObservability.metrics,
    private readonly options: { lockTimeoutMs?: number } = {},
  ) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    if (!trace.getActiveSpan()) {
      return this.execute(work);
    }
    return tracer.startActiveSpan("db.transaction", async (span) => {
      try {
        return await this.execute(work);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.name : "unknown" });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async execute<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${Math.trunc(this.options.lockTimeoutMs ?? 5000)}ms'`);
        return work(createRepositories(em));
      });
    } catch (error) {
      const translated = translateDatabaseError(error);
      const sqlState = (error as { code?: string } | undefined)?.code;
      if (translated instanceof TransientInfrastructureError && sqlState && LOCK_CONFLICT_SQLSTATES.has(sqlState)) {
        this.metrics.lockConflict();
      }
      throw translated;
    }
  }
}
