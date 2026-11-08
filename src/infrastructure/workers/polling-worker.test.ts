import { describe, expect, test } from "bun:test";
import { silentObservability } from "../../application/ports";
import { PollingWorker } from "./polling-worker";

const logger = silentObservability.logger;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PollingWorker", () => {
  test("keeps running the task while it finds work", async () => {
    let runs = 0;
    const worker = new PollingWorker("w", async () => (++runs < 5 ? 1 : 0), 10_000, logger);
    worker.start();
    await wait(50);
    await worker.stop();
    expect(runs).toBe(5);
  });

  test("stop wakes an idle worker immediately", async () => {
    const worker = new PollingWorker("w", async () => 0, 60_000, logger);
    worker.start();
    await wait(20);
    const started = performance.now();
    await worker.stop();
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("stop waits for the task that is already running", async () => {
    let finished = false;
    const worker = new PollingWorker(
      "w",
      async () => {
        await wait(150);
        finished = true;
        return 1;
      },
      10,
      logger,
    );
    worker.start();
    await wait(30);
    await worker.stop();
    expect(finished).toBe(true);
  });

  test("a failing task does not kill the loop", async () => {
    let runs = 0;
    const worker = new PollingWorker(
      "w",
      async () => {
        runs += 1;
        if (runs === 1) throw new Error("boom");
        return 0;
      },
      10,
      logger,
    );
    worker.start();
    await wait(80);
    await worker.stop();
    expect(runs).toBeGreaterThan(1);
  });

  test("tells the task when it should stop", async () => {
    let sawStop = false;
    const worker = new PollingWorker(
      "w",
      async (shouldStop) => {
        await wait(60);
        sawStop = shouldStop();
        return 1;
      },
      10,
      logger,
    );
    worker.start();
    await wait(20);
    await worker.stop();
    expect(sawStop).toBe(true);
  });
});
