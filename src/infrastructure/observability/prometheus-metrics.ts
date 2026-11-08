import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Metrics, RetryKind } from "../../application/ports";

export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions answered, by resulting status",
    labelNames: ["status"],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Requests answered from a stored result (idempotent replays)",
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Retries, by kind",
    labelNames: ["kind"],
    registers: [this.registry],
  });

  private readonly dlq = new Counter({
    name: "wager_dlq_messages_total",
    help: "Messages sent to the dead-letter queue",
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wager_lock_conflicts_total",
    help: "Lock timeouts, deadlocks and serialization failures",
    registers: [this.registry],
  });

  private readonly outboxLagGauge = new Gauge({
    name: "outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox message",
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "Time to process a wager transaction",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly walletsNotFound = new Counter({
    name: "wager_wallet_not_found_total",
    help: "Transactions submitted for a wallet that does not exist",
    registers: [this.registry],
  });

  private readonly divergences = new Counter({
    name: "wallet_reconciliation_divergences_total",
    help: "Reconciliations where the stored balance differs from the ledger",
    registers: [this.registry],
  });

  transactionResult(status: string, replay: boolean): void {
    this.transactions.inc({ status });
    if (replay) {
      this.duplicates.inc();
    }
  }

  processingDuration(seconds: number): void {
    this.duration.observe(seconds);
  }

  walletNotFound(): void {
    this.walletsNotFound.inc();
  }

  lockConflict(): void {
    this.lockConflicts.inc();
  }

  retry(kind: RetryKind): void {
    this.retries.inc({ kind });
  }

  dlqMessage(): void {
    this.dlq.inc();
  }

  outboxLag(seconds: number): void {
    this.outboxLagGauge.set(seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
