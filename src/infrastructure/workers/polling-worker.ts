import type { Logger } from "../../application/ports";

type Task = (shouldStop: () => boolean) => Promise<number>;

export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    readonly name: string,
    private readonly task: Task,
    private readonly idleMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    const shouldStop = () => !this.running;
    while (this.running) {
      let worked = 0;
      try {
        worked = await this.task(shouldStop);
      } catch (error) {
        this.logger.error("worker_error", {
          worker: this.name,
          reason: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
        });
      }
      if (this.running && worked === 0) {
        await this.sleep();
      }
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.idleMs);
      this.wake = done;
    });
  }
}
