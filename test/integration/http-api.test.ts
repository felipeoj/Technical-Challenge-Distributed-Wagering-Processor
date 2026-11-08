import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { FailWagerTransaction } from "../../src/application/fail-wager-transaction";
import { createApp } from "../../src/create-app";
import { TEST_DATABASE_URL, connectTestDatabase, run } from "../support/database";

let app: INestApplication;
let orm: MikroORM;
let baseUrl: string;

beforeAll(async () => {
  orm = await connectTestDatabase();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LOG_LEVEL = "fatal";
  app = await createApp({ quiet: true });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await orm.close();
});

interface Reply {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

const money = (amount: string) => ({ amount, currency: "BRL" });

async function createWallet(amount = "1000.00") {
  const reply = await call("POST", "/wallets", { body: { playerId: randomUUID(), initialBalance: money(amount) } });
  expect(reply.status).toBe(201);
  return { walletId: reply.json.id as string, playerId: reply.json.playerId as string };
}

function wager(wallet: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: money("25.00"),
    ...overrides,
  };
}

const keyOf = (body: { providerId: unknown; externalTransactionId: unknown }) =>
  `${body.providerId}:${body.externalTransactionId}`;

const submit = (body: ReturnType<typeof wager>, key = keyOf(body), headers: Record<string, string> = {}) =>
  call("POST", "/wagering/transactions", { body, headers: { "idempotency-key": key, ...headers } });

describe("health and metrics", () => {
  test("liveness and readiness are open", async () => {
    const live = await call("GET", "/health/live");
    expect(live.status).toBe(200);
    expect(live.json.status).toBe("ok");
    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual({ status: "ready", checks: { postgres: "up", sqs: "up" } });
  });

  test("readiness is 503 when SQS cannot be reached", async () => {
    const previous = process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ENDPOINT_URL = "http://127.0.0.1:1";
    const broken = await createApp({ quiet: true });
    await broken.listen(0, "127.0.0.1");
    try {
      const port = (broken.getHttpServer().address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable", checks: { postgres: "up", sqs: "down" } });
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(live.status).toBe(200);
    } finally {
      await broken.close();
      process.env.AWS_ENDPOINT_URL = previous;
    }
  });

  test("an unknown route is a 404 in the common error shape", async () => {
    const reply = await call("GET", "/nope");
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe("HTTP_404");
  });

  test("a body that is not JSON is a 400", async () => {
    const reply = await call("POST", "/wallets", { rawBody: "{not json" });
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBeDefined();
  });
});

describe("wallets", () => {
  test("creates a wallet with the initial balance and version 1", async () => {
    const playerId = randomUUID();
    const reply = await call("POST", "/wallets", { body: { playerId, initialBalance: money("1000.00") } });
    expect(reply.status).toBe(201);
    expect(reply.json).toEqual({
      id: expect.any(String),
      playerId,
      balance: money("1000.00"),
      version: 1,
    });
  });

  test("a second wallet for the same player and currency is a 409", async () => {
    const playerId = randomUUID();
    await call("POST", "/wallets", { body: { playerId, initialBalance: money("1.00") } });
    const again = await call("POST", "/wallets", { body: { playerId, initialBalance: money("1.00") } });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("invalid input is a 400", async () => {
    const badMoney = await call("POST", "/wallets", { body: { playerId: "p", initialBalance: money("10") } });
    expect(badMoney.status).toBe(400);
    expect(badMoney.json.error.code).toBe("INVALID_MONEY");
    const numeric = await call("POST", "/wallets", { body: { playerId: "p", initialBalance: { amount: 10, currency: "BRL" } } });
    expect(numeric.status).toBe(400);
    expect(numeric.json.error.code).toBe("INVALID_COMMAND");
  });

  test("reads a wallet, 404 when unknown, 400 for a malformed id", async () => {
    const wallet = await createWallet("20.00");
    const found = await call("GET", `/wallets/${wallet.walletId}`);
    expect(found.status).toBe(200);
    expect(found.json.balance).toEqual(money("20.00"));
    expect((await call("GET", `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/wallets/not-a-uuid")).status).toBe(400);
  });
});

describe("submitting transactions", () => {
  test("a BET is processed and the response matches the contract", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const reply = await submit(body);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: money("975.00"),
      idempotentReplay: false,
    });
  });

  test("the same request again is a replay with the same transaction", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const first = await submit(body);
    const second = await submit(body);
    expect(second.status).toBe(200);
    expect(second.json.idempotentReplay).toBe(true);
    expect(second.json.transactionId).toBe(first.json.transactionId);
    expect(second.json.balance).toEqual(first.json.balance);
  });

  test("the Idempotency-Key header is required", async () => {
    const wallet = await createWallet();
    const reply = await call("POST", "/wagering/transactions", { body: wager(wallet) });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe("INVALID_COMMAND");
  });

  test("the same key with a different payload is a 409", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    await submit(body);
    const conflict = await submit({ ...body, money: money("26.00") }, keyOf(body));
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("a bet without funds is a 422 with its failure code", async () => {
    const wallet = await createWallet("10.00");
    const reply = await submit(wager(wallet, { money: money("80.00") }));
    expect(reply.status).toBe(422);
    expect(reply.json.status).toBe("REJECTED");
    expect(reply.json.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(reply.json.balance).toEqual(money("10.00"));
  });

  test("a rejected request replays as the same 422", async () => {
    const wallet = await createWallet("10.00");
    const body = wager(wallet, { money: money("80.00") });
    await submit(body);
    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.json.idempotentReplay).toBe(true);
  });

  test("an unknown wallet is a 422 and nothing is stored", async () => {
    const body = wager({ walletId: randomUUID(), playerId: "p" });
    const reply = await submit(body);
    expect(reply.status).toBe(422);
    expect(reply.json.error.code).toBe("WALLET_NOT_FOUND");
    expect((await call("GET", `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`)).status).toBe(404);
  });

  test("invalid payloads are 400", async () => {
    const wallet = await createWallet();
    expect((await submit(wager(wallet, { money: money("25") }))).status).toBe(400);
    expect((await submit(wager(wallet, { kind: "OPENING" }))).status).toBe(400);
    expect((await submit(wager(wallet, { walletId: "wallet-1" }))).status).toBe(400);
  });

  test("a reversal that arrives before its reference is a 202", async () => {
    const wallet = await createWallet();
    const bet = wager(wallet);
    const refund = wager(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId,
      money: bet.money,
    });
    const reply = await submit(refund);
    expect(reply.status).toBe(202);
    expect(reply.json.status).toBe("PENDING_REFERENCE");
    expect(reply.json.balance).toBeUndefined();
  });

  test("the correlation id is echoed or generated", async () => {
    const wallet = await createWallet();
    const echoed = await submit(wager(wallet), undefined, { "x-correlation-id": "corr-123" });
    expect(echoed.headers.get("x-correlation-id")).toBe("corr-123");
    const generated = await submit(wager(wallet));
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("a transaction that failed permanently", () => {
  test("replays as a 422 and can be read, and the wallet is untouched", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    await app.get(FailWagerTransaction).execute(body, { idempotencyKey: keyOf(body) });

    const replay = await submit(body);
    expect(replay.status).toBe(422);
    expect(replay.json).toMatchObject({ status: "FAILED", failureCode: "PERMANENT_ERROR", idempotentReplay: true });
    const read = await call("GET", `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ status: "FAILED", failureCode: "PERMANENT_ERROR" });
    expect((await call("GET", `/wallets/${wallet.walletId}`)).json.balance).toEqual(money("1000.00"));
  });
});

describe("reading transactions", () => {
  test("by id and by provider reference", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const created = await submit(body);
    const byId = await call("GET", `/wagering/transactions/${created.json.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.json).toMatchObject({
      transactionId: created.json.transactionId,
      status: "PROCESSED",
      kind: "BET",
      walletId: wallet.walletId,
      money: money("25.00"),
      balance: money("975.00"),
    });
    const byReference = await call("GET", `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byReference.status).toBe(200);
    expect(byReference.json.transactionId).toBe(created.json.transactionId);
  });

  test("unknown ids are 404 and malformed ids are 400", async () => {
    expect((await call("GET", `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/wagering/transactions/abc")).status).toBe(400);
    expect((await call("GET", "/providers/provider-a/wagering/transactions/nope")).status).toBe(404);
  });
});

describe("ledger pagination", () => {
  test("walks the ledger with an opaque cursor and never repeats or skips", async () => {
    const wallet = await createWallet();
    for (let index = 0; index < 4; index += 1) {
      await submit(wager(wallet, { money: money("10.00") }));
    }

    const first = await call("GET", `/wallets/${wallet.walletId}/ledger?limit=2`);
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    expect(first.json.items[0].direction).toBe("CREDIT");

    await submit(wager(wallet, { money: money("5.00") }));

    const seen: string[] = first.json.items.map((item: { id: string }) => item.id);
    let cursor: string | null = first.json.nextCursor;
    while (cursor) {
      const page = await call("GET", `/wallets/${wallet.walletId}/ledger?limit=2&cursor=${cursor}`);
      expect(page.status).toBe(200);
      seen.push(...page.json.items.map((item: { id: string }) => item.id));
      cursor = page.json.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    const whole = await call("GET", `/wallets/${wallet.walletId}/ledger`);
    expect(whole.json.items.map((item: { id: string }) => item.id)).toEqual(seen);
    expect(whole.json.nextCursor).toBeNull();
    const last = whole.json.items[5];
    expect(last.balanceAfter).toEqual(money("955.00"));
  });

  test("rejects a bad cursor and a bad limit, and 404s an unknown wallet", async () => {
    const wallet = await createWallet();
    expect((await call("GET", `/wallets/${wallet.walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await call("GET", `/wallets/${wallet.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call("GET", `/wallets/${wallet.walletId}/ledger?limit=201`)).status).toBe(400);
    expect((await call("GET", `/wallets/${wallet.walletId}/ledger?limit=abc`)).status).toBe(400);
    expect((await call("GET", `/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe("reconciliation", () => {
  test("a consistent wallet reports zero difference", async () => {
    const wallet = await createWallet();
    await submit(wager(wallet));
    const reply = await call("POST", `/wallets/${wallet.walletId}/reconciliation`);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      walletId: wallet.walletId,
      storedBalance: money("975.00"),
      calculatedBalance: money("975.00"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("a divergence is flagged, counted and never silently fixed", async () => {
    const wallet = await createWallet();
    await run(orm, "update wallet set balance = balance + 5 where id = ?", [wallet.walletId]);
    const reply = await call("POST", `/wallets/${wallet.walletId}/reconciliation`);
    expect(reply.status).toBe(200);
    expect(reply.json.consistent).toBe(false);
    expect(reply.json.storedBalance).toEqual(money("1005.00"));
    expect(reply.json.calculatedBalance).toEqual(money("1000.00"));
    expect(reply.json.difference).toEqual(money("5.00"));
    const [row] = await run<{ balance: string }>(orm, "select balance::text as balance from wallet where id = ?", [
      wallet.walletId,
    ]);
    expect(row?.balance).toBe("1005.00");
    const metrics = await call("GET", "/metrics");
    expect(metrics.text).toMatch(/wallet_reconciliation_divergences_total [1-9]/);
  });

  test("an unknown wallet is a 404", async () => {
    expect((await call("POST", `/wallets/${randomUUID()}/reconciliation`)).status).toBe(404);
  });
});

describe("metrics endpoint", () => {
  test("exposes the counters required by the statement", async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    await submit(body);
    await submit(body);
    await submit(wager({ walletId: randomUUID(), playerId: "p" }));
    const metrics = await call("GET", "/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toMatch(/wager_transactions_total\{status="PROCESSED"\} [1-9]/);
    expect(metrics.text).toMatch(/wager_duplicates_total [1-9]/);
    expect(metrics.text).toMatch(/wager_wallet_not_found_total [1-9]/);
    expect(metrics.text).toContain("wager_processing_duration_seconds_bucket");
    expect(metrics.text).toContain("wager_lock_conflicts_total");
    expect(metrics.text).toContain("outbox_lag_seconds");
    expect(metrics.text).toContain("wager_dlq_messages_total");
    expect(metrics.text).toContain("wager_retries_total");
  });
});
