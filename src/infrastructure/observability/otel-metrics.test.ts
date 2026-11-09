import { describe, expect, test } from "bun:test";
import { OpenTelemetryMetrics } from "./otel-metrics";

const lines = async (metrics: OpenTelemetryMetrics) => (await metrics.scrape()).split("\n");

describe("OpenTelemetryMetrics", () => {
  test("every counter and the outbox lag exist with zero before the first event", async () => {
    const scraped = await lines(new OpenTelemetryMetrics());
    for (const series of [
      'wager_transactions_total{status="PROCESSED"} 0',
      'wager_transactions_total{status="REJECTED"} 0',
      'wager_transactions_total{status="PENDING_REFERENCE"} 0',
      'wager_transactions_total{status="FAILED"} 0',
      "wager_duplicates_total 0",
      'wager_retries_total{kind="pending_reference"} 0',
      'wager_retries_total{kind="sqs"} 0',
      'wager_retries_total{kind="outbox"} 0',
      "wager_dlq_messages_total 0",
      "wager_lock_conflicts_total 0",
      "outbox_lag_seconds 0",
      "wager_wallet_not_found_total 0",
      "wallet_reconciliation_divergences_total 0",
    ]) {
      expect(scraped).toContain(series);
    }
  });

  test("records results, replays and the outbox lag", async () => {
    const metrics = new OpenTelemetryMetrics();
    metrics.transactionResult("PROCESSED", false);
    metrics.transactionResult("PROCESSED", true);
    metrics.retry("sqs");
    metrics.outboxLag(2.5);
    const scraped = await lines(metrics);
    expect(scraped).toContain('wager_transactions_total{status="PROCESSED"} 2');
    expect(scraped).toContain("wager_duplicates_total 1");
    expect(scraped).toContain('wager_retries_total{kind="sqs"} 1');
    expect(scraped).toContain("outbox_lag_seconds 2.5");
  });

  test("the latency histogram appears with the first measurement and uses the configured buckets", async () => {
    const metrics = new OpenTelemetryMetrics();
    expect((await metrics.scrape()).includes("wager_processing_duration_seconds")).toBe(false);
    metrics.processingDuration(0.02);
    const scraped = await lines(metrics);
    expect(scraped).toContain('wager_processing_duration_seconds_bucket{le="0.01"} 0');
    expect(scraped).toContain('wager_processing_duration_seconds_bucket{le="0.025"} 1');
    expect(scraped).toContain('wager_processing_duration_seconds_bucket{le="5"} 1');
    expect(scraped).toContain('wager_processing_duration_seconds_bucket{le="+Inf"} 1');
    expect(scraped).toContain("wager_processing_duration_seconds_count 1");
  });
});
