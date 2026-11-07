export interface Clock {
  now(): Date;
}

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type RetryKind = "pending_reference" | "sqs" | "outbox";

export interface Metrics {
  transactionResult(status: string, replay: boolean): void;
  processingDuration(seconds: number): void;
  walletNotFound(): void;
  lockConflict(): void;
  retry(kind: RetryKind): void;
  dlqMessage(): void;
  outboxLag(seconds: number): void;
  reconciliationDivergence(): void;
}

export interface Observability {
  logger: Logger;
  metrics: Metrics;
}

const noop = () => {};

export const silentObservability: Observability = {
  logger: { info: noop, warn: noop, error: noop },
  metrics: {
    transactionResult: noop,
    processingDuration: noop,
    walletNotFound: noop,
    lockConflict: noop,
    retry: noop,
    dlqMessage: noop,
    outboxLag: noop,
    reconciliationDivergence: noop,
  },
};
