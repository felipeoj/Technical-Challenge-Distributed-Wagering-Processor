import { AggregationType, MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import type { Metrics, RetryKind } from "../../application/ports";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction-status";

const DURATION_NAME = "wager_processing_duration_seconds";
const RETRY_KINDS: RetryKind[] = ["pending_reference", "sqs", "outbox"];
const ANSWERED_STATUSES = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.PendingReference,
  WagerTransactionStatus.Failed,
];
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class OpenTelemetryMetrics implements Metrics {
  private readonly reader = new PrometheusExporter({ preventServerStart: true });
  private readonly serializer = new PrometheusSerializer("", false, undefined, true, true);
  private readonly meter = new MeterProvider({
    readers: [this.reader],
    views: [
      {
        instrumentName: DURATION_NAME,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: DURATION_BUCKETS, recordMinMax: false },
        },
      },
    ],
  }).getMeter("wagering-processor");

  private readonly transactions = this.meter.createCounter("wager_transactions_total", {
    description: "Wager transactions answered, by resulting status",
  });
  private readonly duplicates = this.meter.createCounter("wager_duplicates_total", {
    description: "Requests answered from a stored result (idempotent replays)",
  });
  private readonly retries = this.meter.createCounter("wager_retries_total", { description: "Retries, by kind" });
  private readonly dlq = this.meter.createCounter("wager_dlq_messages_total", {
    description: "Messages sent to the dead-letter queue",
  });
  private readonly lockConflicts = this.meter.createCounter("wager_lock_conflicts_total", {
    description: "Lock timeouts, deadlocks and serialization failures",
  });
  private readonly outboxLagGauge = this.meter.createGauge("outbox_lag_seconds", {
    description: "Age of the oldest unpublished outbox message",
  });
  private readonly duration = this.meter.createHistogram(DURATION_NAME, {
    description: "Time to process a wager transaction",
  });
  private readonly walletsNotFound = this.meter.createCounter("wager_wallet_not_found_total", {
    description: "Transactions submitted for a wallet that does not exist",
  });
  private readonly divergences = this.meter.createCounter("wallet_reconciliation_divergences_total", {
    description: "Reconciliations where the stored balance differs from the ledger",
  });

  constructor() {
    for (const counter of [this.duplicates, this.dlq, this.lockConflicts, this.walletsNotFound, this.divergences]) {
      counter.add(0);
    }
    for (const status of ANSWERED_STATUSES) {
      this.transactions.add(0, { status });
    }
    for (const kind of RETRY_KINDS) {
      this.retries.add(0, { kind });
    }
    this.outboxLagGauge.record(0);
  }

  async scrape(): Promise<string> {
    const { resourceMetrics } = await this.reader.collect();
    return this.serializer.serialize(resourceMetrics);
  }

  transactionResult(status: string, replay: boolean): void {
    this.transactions.add(1, { status });
    if (replay) {
      this.duplicates.add(1);
    }
  }

  processingDuration(seconds: number): void {
    this.duration.record(seconds);
  }

  walletNotFound(): void {
    this.walletsNotFound.add(1);
  }

  lockConflict(): void {
    this.lockConflicts.add(1);
  }

  retry(kind: RetryKind): void {
    this.retries.add(1, { kind });
  }

  dlqMessage(): void {
    this.dlq.add(1);
  }

  outboxLag(seconds: number): void {
    this.outboxLagGauge.record(seconds);
  }

  reconciliationDivergence(): void {
    this.divergences.add(1);
  }
}
