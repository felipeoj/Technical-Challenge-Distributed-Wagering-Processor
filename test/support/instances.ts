const root = new URL("../..", import.meta.url).pathname;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Instances {
  private readonly processes = new Map<number, ReturnType<typeof Bun.spawn>>();

  constructor(
    readonly ports: number[],
    private readonly env: Record<string, string>,
  ) {}

  start(): void {
    for (const port of this.ports) {
      this.processes.set(
        port,
        Bun.spawn(["bun", "src/main.ts"], {
          cwd: root,
          env: { ...Bun.env, ...this.env, PORT: String(port), LOG_LEVEL: "error" },
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
    }
  }

  async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const port of this.ports) {
      for (;;) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
          if (response.status === 200) break;
        } catch {}
        if (Date.now() > deadline) throw new Error(`instance on port ${port} did not become ready`);
        await wait(250);
      }
    }
  }

  async metrics(): Promise<string[]> {
    return Promise.all(
      this.ports.map(async (port) => (await fetch(`http://127.0.0.1:${port}/metrics`)).text()),
    );
  }

  async stop(): Promise<void> {
    for (const child of this.processes.values()) child.kill("SIGTERM");
    await Promise.race([Promise.all([...this.processes.values()].map((child) => child.exited)), wait(20_000)]);
    for (const child of this.processes.values()) child.kill("SIGKILL");
  }
}

export function metricValue(text: string, name: string): number {
  const line = text.split("\n").find((entry) => entry.startsWith(`${name} `) || entry.startsWith(`${name}{`));
  return line ? Number(line.split(" ").pop()) : 0;
}
