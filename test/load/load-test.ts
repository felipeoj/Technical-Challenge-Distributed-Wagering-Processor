import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { cpus, platform, release, totalmem } from "node:os";
import { connectIsolatedDatabase, run } from "../support/database";
import { Instances, metricValue } from "../support/instances";
import { purgeAll, queueEnv, queues, sqs } from "../support/queues";

const INSTANCES = Math.max(1, Number(Bun.env.INSTANCES ?? 3));
const CONCURRENCY = Math.max(1, Number(Bun.env.CONCURRENCY ?? 64));
const SPREAD_WALLETS = Math.max(1, Number(Bun.env.SPREAD_WALLETS ?? 200));
const SPREAD_REQUESTS = Math.max(1, Number(Bun.env.SPREAD_REQUESTS ?? 20_000));
const HOT_REQUESTS = Math.max(1, Number(Bun.env.HOT_REQUESTS ?? 5_000));
const DUPLICATE_KEYS = 50;
const DUPLICATE_WALLETS = 10;
const DUPLICATE_REQUESTS = Math.max(DUPLICATE_KEYS, Number(Bun.env.DUPLICATE_REQUESTS ?? 5_000));
const INITIAL_BALANCE = "100000.00";
const MAX_RESENDS = 3;

type Body = Record<string, unknown>;
type Wallet = { walletId: string; playerId: string };
type Outcome = { status: number; replay: boolean; millis: number; resends: number };
type Row = {
  name: string;
  requests: number;
  created: number;
  replays: number;
  rejected: number;
  errors: number;
  resent: number;
  seconds: number;
  p50: number;
  p95: number;
  p99: number;
  lockConflicts: number;
  maxLag: number;
  drainSeconds: number;
  consistent: boolean;
  details: string[];
};

const ports = Array.from({ length: INSTANCES }, (_, index) => 3201 + index);
const money = (amount: string) => ({ amount, currency: "BRL" });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pool<T>(items: T[], size: number, task: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await task(items[index] as T, index);
      }
    }),
  );
}

async function send(path: string, body: unknown, key: string): Promise<Outcome> {
  const started = performance.now();
  for (let resends = 0; ; resends += 1) {
    const target = ports[Math.floor(Math.random() * ports.length)] as number;
    try {
      const response = await fetch(`http://127.0.0.1:${target}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
      const reply = (await response.json().catch(() => ({}))) as { idempotentReplay?: boolean };
      if (response.status >= 500) console.error(`request answered ${response.status}: ${JSON.stringify(reply)}`);
      return { status: response.status, replay: reply.idempotentReplay === true, millis: performance.now() - started, resends };
    } catch (error) {
      console.error(`request got no answer (attempt ${resends + 1} of ${MAX_RESENDS + 1}): ${(error as Error).message}`);
      if (resends === MAX_RESENDS) return { status: 0, replay: false, millis: performance.now() - started, resends };
    }
  }
}

async function createWallets(count: number): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  await pool(Array.from({ length: count }), 16, async () => {
    const response = await fetch(`http://127.0.0.1:${ports[0]}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId: randomUUID(), initialBalance: money(INITIAL_BALANCE) }),
    });
    if (response.status !== 201) throw new Error(`wallet creation answered ${response.status}`);
    const created = (await response.json()) as { id: string; playerId: string };
    wallets.push({ walletId: created.id, playerId: created.playerId });
  });
  return wallets;
}

function wager(scenario: string, wallet: Wallet, externalTransactionId: string, kind: string): Body {
  return {
    providerId: scenario,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "game",
    kind,
    money: money("1.00"),
  };
}

function mixedRequests(scenario: string, wallets: Wallet[], count: number): Body[] {
  return Array.from({ length: count }, (_, index) => {
    const wallet = wallets[Math.floor(Math.random() * wallets.length)] as Wallet;
    const kind = index % 10 < 6 ? "BET" : index % 10 < 9 ? "WIN" : "LOSS";
    return wager(scenario, wallet, `${scenario}-${index}`, kind);
  });
}

function duplicateRequests(scenario: string, wallets: Wallet[]): Body[] {
  const copies = Math.floor(DUPLICATE_REQUESTS / DUPLICATE_KEYS);
  const requests = Array.from({ length: DUPLICATE_KEYS * copies }, (_, index) => {
    const key = index % DUPLICATE_KEYS;
    return wager(scenario, wallets[key % wallets.length] as Wallet, `${scenario}-${key}`, "BET");
  });
  return requests.sort(() => Math.random() - 0.5);
}

const keyOf = (body: Body) => `${body.providerId}:${body.externalTransactionId}`;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] as number;
}

async function sampleLag(instances: Instances, state: { max: number; stop: boolean }) {
  while (!state.stop) {
    for (const text of await instances.metrics()) {
      state.max = Math.max(state.max, metricValue(text, "outbox_lag_seconds"));
    }
    await wait(500);
  }
}

async function waitForLagReset(instances: Instances): Promise<boolean> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const lags = (await instances.metrics()).map((text) => metricValue(text, "outbox_lag_seconds"));
    if (lags.every((value) => value === 0)) return true;
    await wait(250);
  }
  return false;
}

async function outboxPending(orm: Parameters<typeof run>[0]): Promise<number> {
  const [row] = await run<{ pending: string }>(
    orm,
    "select count(*)::text as pending from outbox_message where published_at is null",
  );
  return Number(row?.pending);
}

async function checkConsistency(
  orm: Parameters<typeof run>[0],
  scenario: string,
  expectedProcessed: number,
  expectedDebits: number | null,
): Promise<string[]> {
  const problems: string[] = [];
  const [balances] = await run<{ wallets: string; wrong: string; negative: string }>(
    orm,
    `select count(*)::text as wallets,
            count(*) filter (where t.balance <> t.rebuilt)::text as wrong,
            count(*) filter (where t.balance < 0)::text as negative
       from (select w.balance,
                    coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0) as rebuilt
               from wallet w left join wallet_ledger_entry e on e.wallet_id = w.id
              group by w.id, w.balance) t`,
  );
  if (balances?.wrong !== "0") problems.push(`${balances?.wrong} wallets differ from their ledger`);
  if (balances?.negative !== "0") problems.push(`${balances?.negative} negative balances`);

  const [duplicated] = await run<{ duplicated: string }>(
    orm,
    "select (count(*) - count(distinct (transaction_id, wallet_id)))::text as duplicated from wallet_ledger_entry",
  );
  if (duplicated?.duplicated !== "0") problems.push(`${duplicated?.duplicated} duplicated ledger entries`);

  const [transactions] = await run<{ total: string; processed: string; open: string }>(
    orm,
    `select count(*)::text as total,
            count(*) filter (where status = 'PROCESSED')::text as processed,
            count(*) filter (where status in ('PENDING', 'PENDING_REFERENCE'))::text as open
       from wager_transaction where provider_id = ?`,
    [scenario],
  );
  if (Number(transactions?.total) !== expectedProcessed) {
    problems.push(`expected ${expectedProcessed} transactions, found ${transactions?.total}`);
  }
  if (Number(transactions?.processed) !== expectedProcessed) {
    problems.push(`expected ${expectedProcessed} processed, found ${transactions?.processed}`);
  }
  if (transactions?.open !== "0") problems.push(`${transactions?.open} transactions still open`);

  if (expectedDebits !== null) {
    const [debits] = await run<{ debits: string }>(
      orm,
      `select count(*)::text as debits from wallet_ledger_entry e
         join wager_transaction t on t.id = e.transaction_id
        where t.provider_id = ? and e.direction = 'DEBIT'`,
      [scenario],
    );
    if (Number(debits?.debits) !== expectedDebits) {
      problems.push(`expected ${expectedDebits} debits, found ${debits?.debits}`);
    }
  }
  return problems;
}

async function scenario(
  name: string,
  instances: Instances,
  orm: Parameters<typeof run>[0],
  requests: Body[],
  expectedProcessed: number,
  expectedDebits: number | null,
): Promise<Row> {
  const conflictsBefore = (await instances.metrics()).reduce((sum, text) => sum + metricValue(text, "wager_lock_conflicts_total"), 0);
  const lag = { max: 0, stop: false };
  const sampler = sampleLag(instances, lag);

  const outcomes: Outcome[] = [];
  const started = performance.now();
  await pool(requests, CONCURRENCY, async (body) => {
    outcomes.push(await send("/wagering/transactions", body, keyOf(body)));
  });
  const seconds = (performance.now() - started) / 1000;

  const drainStarted = performance.now();
  while ((await outboxPending(orm)) > 0 && performance.now() - drainStarted < 120_000) await wait(250);
  const drainSeconds = (performance.now() - drainStarted) / 1000;
  const lagReset = await waitForLagReset(instances);
  lag.stop = true;
  await sampler;

  const conflictsAfter = (await instances.metrics()).reduce((sum, text) => sum + metricValue(text, "wager_lock_conflicts_total"), 0);
  const latencies = outcomes.map((outcome) => outcome.millis).sort((a, b) => a - b);
  const details = await checkConsistency(orm, name, expectedProcessed, expectedDebits);
  if ((await outboxPending(orm)) > 0) details.push("outbox did not drain within 120 s");
  if (!lagReset) details.push("outbox_lag_seconds did not return to 0 within 10 s after the drain");

  return {
    name,
    requests: requests.length,
    created: outcomes.filter((outcome) => (outcome.status === 200 || outcome.status === 201) && !outcome.replay).length,
    replays: outcomes.filter((outcome) => outcome.replay).length,
    rejected: outcomes.filter((outcome) => outcome.status === 422).length,
    errors: outcomes.filter((outcome) => outcome.status === 0 || outcome.status >= 500).length,
    resent: outcomes.filter((outcome) => outcome.resends > 0).length,
    seconds,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    lockConflicts: conflictsAfter - conflictsBefore,
    maxLag: lag.max,
    drainSeconds,
    consistent: details.length === 0,
    details,
  };
}

async function dlqSize(): Promise<number> {
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queues.dlq, AttributeNames: ["ApproximateNumberOfMessages"] }),
  );
  return Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0);
}

function report(rows: Row[], postgres: string, dlq: number): string {
  const processor = cpus();
  const fixed = (value: number, digits = 1) => value.toFixed(digits);
  const lines = [
    "# Load test results",
    "",
    "## Environment",
    "",
    `- Host: ${platform()} ${release()}, ${processor.length} logical CPUs (${processor[0]?.model}), ${fixed(totalmem() / 1024 ** 3)} GiB RAM`,
    `- Bun ${Bun.version}; ${postgres}`,
    `- Everything runs on this one machine: ${INSTANCES} application processes, PostgreSQL and LocalStack in Docker, and the load generator`,
    `- Load generator: ${CONCURRENCY} concurrent HTTP clients, requests spread randomly over the instances`,
    "",
    "## Method",
    "",
    "- A new database and dedicated test queues are created for each run, then the instances are started as real processes",
    "- Latency is measured by the client for each request, from sending it to reading the response body",
    `- A request that gets no HTTP answer (a connection error) is sent again with the same Idempotency-Key, up to ${MAX_RESENDS} times, as a provider would; Resent counts those requests, and Errors counts 5xx answers and requests that never got an answer`,
    "- Lock conflicts are the growth of `wager_lock_conflicts_total` summed over the instances; max lag is the highest `outbox_lag_seconds` sampled every 500 ms, and a scenario only ends once every instance reports a lag of 0 again",
    "- Outbox drain is the time after the last response until no outbox row is left unpublished",
    "- After each scenario: stored balance equals the balance rebuilt from the ledger for every wallet, no negative balance, no duplicated ledger entry, every transaction processed",
    "",
    "## Results",
    "",
    "| Scenario | Requests | New | Replays | 422 | Errors | Error rate | Resent | Seconds | Req/s | p50 ms | p95 ms | p99 ms | Lock conflicts | Max outbox lag s | Outbox drain s | Consistent |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.name} | ${row.requests} | ${row.created} | ${row.replays} | ${row.rejected} | ${row.errors} | ${fixed((row.errors / row.requests) * 100, 2)}% | ${row.resent} | ${fixed(row.seconds)} | ${fixed(row.requests / row.seconds, 0)} | ${fixed(row.p50)} | ${fixed(row.p95)} | ${fixed(row.p99)} | ${row.lockConflicts} | ${fixed(row.maxLag)} | ${fixed(row.drainSeconds)} | ${row.consistent ? "yes" : "NO"} |`,
    ),
    "",
    `Messages in the dead-letter queue after the run: ${dlq}`,
  ];
  for (const row of rows.filter((entry) => !entry.consistent)) {
    lines.push("", `Problems in ${row.name}:`, ...row.details.map((detail) => `- ${detail}`));
  }
  return `${lines.join("\n")}\n`;
}

const { orm, url } = await connectIsolatedDatabase("wagering_load");
await purgeAll();
const instances = new Instances(ports, { ...queueEnv, DATABASE_URL: url });
const rows: Row[] = [];

try {
  instances.start();
  await instances.waitReady();
  console.log(`${INSTANCES} instances ready`);

  const spread = await createWallets(SPREAD_WALLETS);
  console.log(`spread: ${SPREAD_REQUESTS} requests over ${SPREAD_WALLETS} wallets`);
  rows.push(await scenario("spread", instances, orm, mixedRequests("spread", spread, SPREAD_REQUESTS), SPREAD_REQUESTS, null));

  const hot = await createWallets(1);
  console.log(`hot wallet: ${HOT_REQUESTS} requests on one wallet`);
  rows.push(await scenario("hot-wallet", instances, orm, mixedRequests("hot-wallet", hot, HOT_REQUESTS), HOT_REQUESTS, null));

  const duplicateWallets = await createWallets(DUPLICATE_WALLETS);
  console.log(`duplicate storm: ${DUPLICATE_REQUESTS} requests for ${DUPLICATE_KEYS} distinct keys`);
  rows.push(
    await scenario("duplicate-storm", instances, orm, duplicateRequests("duplicate-storm", duplicateWallets), DUPLICATE_KEYS, DUPLICATE_KEYS),
  );

  const [version] = await run<{ version: string }>(orm, "select version()");
  const text = report(rows, (version?.version ?? "").split(" on ")[0] ?? "PostgreSQL", await dlqSize());
  console.log(`\n${text}`);
} finally {
  await instances.stop();
  await orm.close();
}

process.exit(rows.every((row) => row.consistent && row.errors === 0) ? 0 : 1);
