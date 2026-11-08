import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { connectIsolatedDatabase, run } from "../support/database";
import { purgeAll, queues, receiveAll, sendWagerMessage, sqs } from "../support/queues";

const INSTANCES = Math.max(3, Number(Bun.env.INSTANCES ?? 3));
const WALLETS = Math.max(1, Number(Bun.env.WALLETS ?? 20));
const PORTS = Array.from({ length: INSTANCES }, (_, index) => 3101 + index);
const PROVIDER = "load";
const EXPECTED_BALANCE = "1015.00";

type Body = Record<string, unknown>;
type Wallet = { walletId: string; playerId: string };

let orm: MikroORM;
let databaseUrl: string;
const processes = new Map<number, ReturnType<typeof Bun.spawn>>();

const money = (amount: string) => ({ amount, currency: "BRL" });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startInstance(port: number) {
  const child = Bun.spawn(["bun", "src/main.ts"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: { ...Bun.env, PORT: String(port), DATABASE_URL: databaseUrl, LOG_LEVEL: "error" },
    stdout: "ignore",
    stderr: "ignore",
  });
  processes.set(port, child);
  return child;
}

async function waitReady(port: number, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await wait(250);
  }
  throw new Error(`instance on port ${port} did not become ready`);
}

async function post(path: string, body: unknown, key?: string): Promise<Response> {
  const offset = Math.floor(Math.random() * PORTS.length);
  for (let attempt = 0; attempt < PORTS.length * 6; attempt += 1) {
    const port = PORTS[(offset + attempt) % PORTS.length];
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(body),
      });
      if (response.status >= 500) continue;
      return response;
    } catch {
      await wait(50);
    }
  }
  throw new Error("no instance answered");
}

function walletOperations(wallet: Wallet): Body[] {
  const base = { providerId: PROVIDER, playerId: wallet.playerId, walletId: wallet.walletId, roundId: "round-1", gameId: "game" };
  const id = (name: string) => `${wallet.walletId}-${name}`;
  const bet = (name: string): Body => ({ ...base, externalTransactionId: id(name), kind: "BET", money: money("10.00") });
  return [
    bet("b1"),
    bet("b2"),
    bet("b3"),
    bet("b4"),
    { ...base, externalTransactionId: id("win-ref"), kind: "WIN", money: money("30.00"), referenceExternalTransactionId: id("b1") },
    { ...base, externalTransactionId: id("refund"), kind: "REFUND", money: money("10.00"), referenceExternalTransactionId: id("b2") },
    { ...base, externalTransactionId: id("rollback"), kind: "ROLLBACK", money: money("10.00"), referenceExternalTransactionId: id("b3") },
    { ...base, externalTransactionId: id("win-plain"), kind: "WIN", money: money("5.00") },
    { ...base, externalTransactionId: id("loss"), kind: "LOSS", money: money("1.00") },
  ];
}

const keyOf = (body: Body) => `${body.providerId}:${body.externalTransactionId}`;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

async function runPool(tasks: Array<() => Promise<void>>, size: number, onStart: (started: number) => void) {
  let next = 0;
  const workers = Array.from({ length: size }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      onStart(index + 1);
      await (tasks[index] as () => Promise<void>)();
    }
  });
  await Promise.all(workers);
}

async function queueIsEmpty(): Promise<boolean> {
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queues.transactions,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return (
    Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) ===
    0
  );
}

beforeAll(async () => {
  ({ orm, url: databaseUrl } = await connectIsolatedDatabase("wagering_multi_test"));
  await purgeAll();
});

afterAll(async () => {
  for (const child of processes.values()) child.kill("SIGKILL");
  await orm.close();
});

describe("three real application instances", () => {
  test(
    "mixed HTTP and SQS load, one instance killed with SIGKILL and restarted, final state is consistent",
    async () => {
      for (const port of PORTS) startInstance(port);
      await Promise.all(PORTS.map((port) => waitReady(port)));

      const wallets: Wallet[] = [];
      for (let index = 0; index < WALLETS; index += 1) {
        const reply = await post("/wallets", { playerId: randomUUID(), initialBalance: money("1000.00") });
        expect(reply.status).toBe(201);
        const created = (await reply.json()) as { id: string; playerId: string };
        wallets.push({ walletId: created.id, playerId: created.playerId });
      }

      const operations = wallets.flatMap(walletOperations);
      const statuses: number[] = [];
      const tasks = shuffle(
        operations.flatMap((body, position) => {
          const copies = 2 + (position % 2);
          return Array.from({ length: copies }, (_, copy) => async () => {
            const useQueue = (position + copy) % 2 === 0;
            if (useQueue) {
              await sendWagerMessage(
                { ...body, idempotencyKey: keyOf(body) },
                { messageId: `msg-${body.externalTransactionId}`, deduplicationId: randomUUID() },
              );
              return;
            }
            const reply = await post("/wagering/transactions", body, keyOf(body));
            statuses.push(reply.status);
          });
        }),
      );

      const victims = (INSTANCES >= 6 ? [PORTS[1], PORTS[3]] : [PORTS[1]]) as number[];
      const thresholds = victims.map((_, index) => Math.floor(tasks.length * (0.35 + index * 0.25)));
      const killedPorts = new Set<number>();
      await runPool(tasks, 25, (started) => {
        victims.forEach((port, index) => {
          if (!killedPorts.has(port) && started >= (thresholds[index] as number)) {
            killedPorts.add(port);
            processes.get(port)?.kill("SIGKILL");
          }
        });
      });
      expect(killedPorts.size).toBe(victims.length);

      for (const port of victims) {
        const dead = processes.get(port);
        await dead?.exited;
        expect(dead?.signalCode).toBe("SIGKILL");
        startInstance(port);
      }
      await Promise.all(victims.map((port) => waitReady(port)));

      const deadline = Date.now() + 180_000;
      let settled = false;
      while (Date.now() < deadline && !settled) {
        const [state] = await run<{ open: string; total: string }>(
          orm,
          "select count(*) filter (where status in ('PENDING', 'PENDING_REFERENCE'))::text as open, count(*) filter (where kind <> 'OPENING')::text as total from wager_transaction",
        );
        const [outbox] = await run<{ pending: string }>(
          orm,
          "select count(*)::text as pending from outbox_message where published_at is null",
        );
        settled =
          state?.open === "0" &&
          Number(state?.total) === operations.length &&
          outbox?.pending === "0" &&
          (await queueIsEmpty());
        if (!settled) await wait(1000);
      }
      expect(settled).toBe(true);

      expect(statuses.every((status) => status === 200 || status === 202)).toBe(true);

      const [transactions] = await run<{ total: string; processed: string; distinct_keys: string }>(
        orm,
        "select count(*) filter (where kind <> 'OPENING')::text as total, count(*) filter (where kind <> 'OPENING' and status = 'PROCESSED')::text as processed, count(distinct idempotency_key) filter (where kind <> 'OPENING')::text as distinct_keys from wager_transaction",
      );
      expect(Number(transactions?.total)).toBe(operations.length);
      expect(Number(transactions?.processed)).toBe(operations.length);
      expect(Number(transactions?.distinct_keys)).toBe(operations.length);

      const balances = await run<{ id: string; stored: string; rebuilt: string }>(
        orm,
        `select w.id, w.balance::text as stored,
                coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19,2)::text as rebuilt
           from wallet w left join wallet_ledger_entry e on e.wallet_id = w.id
          group by w.id, w.balance`,
      );
      expect(balances).toHaveLength(WALLETS);
      for (const row of balances) {
        expect(row.stored).toBe(EXPECTED_BALANCE);
        expect(row.rebuilt).toBe(EXPECTED_BALANCE);
      }

      const sample = wallets[0] as Wallet;
      const reconciliation = await (await post(`/wallets/${sample.walletId}/reconciliation`, {})).json();
      expect(reconciliation).toMatchObject({ consistent: true, difference: money("0.00") });

      const [entries] = await run<{ total: string; debits: string; duplicated: string }>(
        orm,
        "select count(*)::text as total, count(*) filter (where direction = 'DEBIT')::text as debits, (count(*) - count(distinct (transaction_id, wallet_id)))::text as duplicated from wallet_ledger_entry where transaction_id in (select id from wager_transaction where kind <> 'OPENING')",
      );
      expect(entries?.duplicated).toBe("0");
      expect(Number(entries?.debits)).toBe(WALLETS * 4);
      expect(Number(entries?.total)).toBe(WALLETS * 8);

      const [outboxState] = await run<{ rows: string }>(orm, "select count(*)::text as rows from outbox_message");
      const events = await receiveAll(queues.events, { rounds: 120 });
      const eventIds = new Set(events.map((message) => JSON.parse(message.Body ?? "{}").eventId as string));
      expect(eventIds.size).toBe(Number(outboxState?.rows));

      expect(await receiveAll(queues.dlq, { rounds: 2 })).toHaveLength(0);

      for (const port of PORTS) processes.get(port)?.kill("SIGTERM");
      const exits = await Promise.race([
        Promise.all(PORTS.map((port) => processes.get(port)?.exited)),
        wait(20_000).then(() => "timeout" as const),
      ]);
      expect(exits).not.toBe("timeout");
    },
    420_000,
  );
});
