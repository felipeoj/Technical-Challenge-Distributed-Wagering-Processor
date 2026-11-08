import type { BeforeApplicationShutdown } from "@nestjs/common";
import type { Logger } from "../../application/ports";
import type { PollingWorker } from "./polling-worker";

export class WorkerRegistry implements BeforeApplicationShutdown {
  private readonly workers: PollingWorker[] = [];

  constructor(private readonly logger?: Logger) {}

  start(worker: PollingWorker): void {
    this.workers.push(worker);
    worker.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
    this.logger?.info("workers_stopped", { count: this.workers.length, signal });
  }
}
