# Technical-Challenge-Distributed-Wagering-Processor

Distributed financial service that processes betting transactions
(BET, WIN, LOSS, REFUND, ROLLBACK) with persistent idempotency,
multi-instance concurrency safety and a transactional outbox.

Transactions arrive from several game providers, over HTTP and over an SQS queue. Each wallet balance always equals the sum of its ledger, and the service stays correct when messages are duplicated, arrive out of order or are processed at the same time by several instances.

Stack: Bun, TypeScript (strict), NestJS, MikroORM, PostgreSQL 16, AWS SQS on LocalStack, Docker Compose.

## Documentation

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | architecture style, diagrams, concurrency, idempotency, schema guarantees, failure codes, the tests that prove each guarantee, interpretations of the statement and known limits |
| This README | how to run the project, try the API, run the tests and configure it |

## Run it

You only need Docker with Compose v2.

```bash
docker compose up --build -d --wait
```

This starts PostgreSQL, LocalStack (with the queues), the migrations, the API, a small gateway and Jaeger. The API answers at `http://localhost:3000` and the traces are at `http://localhost:16686`.

To run several instances behind the same URL:

```bash
docker compose up --build -d --wait --scale app=3
```

Stop everything with `docker compose down`. Nothing is kept on disk, so the next start is a clean database.

## Container security

The containers built from the application image (`migrate`, `app` and `tests`) do not run as root. They use the unprivileged `bun` user, have no Linux capabilities, cannot gain new privileges and have a read-only filesystem (only `/tmp` is writable). The test container has the same restrictions, so the test run below also proves that the service works under them. The measures, how each one was checked and what is not covered are in [ARCHITECTURE.md](ARCHITECTURE.md#security-and-container-hardening).

## Try the API

Each `curl` below can be copied and pasted, or imported into Postman (Import, Raw text).

```bash
# 1. open a wallet (copy the "id" of the answer)
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'

# 2. place a BET (replace <wallet-id> with the id from step 1)
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: jungle-gaming:chimp-mines-bet-1' \
  -d '{
    "providerId": "jungle-gaming",
    "externalTransactionId": "chimp-mines-bet-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<wallet-id>",
    "roundId": "r1",
    "gameId": "chimp-mines",
    "kind": "BET",
    "money": { "amount": "50.00", "currency": "BRL" }
  }'
```

The answer is `200` with `"status": "PROCESSED"` and the balance `950.00`:

```json
{"transactionId":"01a1bd30-...","status":"PROCESSED","balance":{"amount":"950.00","currency":"BRL"},"idempotentReplay":false}
```

`providerId`, `externalTransactionId` and `gameId` are only examples. Use any ids you like, and put the `Idempotency-Key` in the form `{providerId}:{externalTransactionId}`. The same key with the same payload is a replay, so use a new `externalTransactionId` and a new key for each new bet.

Then try these:

- Send the same BET again. The answer is the same transaction with `"idempotentReplay": true`, and the balance is not debited twice.
- Send it again with another `amount` and the same `Idempotency-Key`. The answer is `409` (`IDEMPOTENCY_CONFLICT`).
- Send a BET of `5000.00`. The answer is `422` with `"status": "REJECTED"` and `"failureCode": "INSUFFICIENT_FUNDS"`.

```bash
# the wallet, its ledger, and a reconciliation of the balance against the ledger
curl http://localhost:3000/wallets/<wallet-id>
curl 'http://localhost:3000/wallets/<wallet-id>/ledger?limit=50'
curl -X POST http://localhost:3000/wallets/<wallet-id>/reconciliation

# liveness, readiness and metrics
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3000/metrics
```

With several instances, the `X-Upstream` response header shows which one answered.

### Traces

Send a bet and open Jaeger at `http://localhost:16686`. Pick the service `wagering-processor` and click Find Traces. A bet shows a span for the HTTP request with the database transaction inside it. A message from the queue shows `sqs.consume`, and each batch of events sent to the events queue shows `outbox.publish`. Health checks and `/metrics` are not traced. Traces are kept in memory, so they are lost when Jaeger stops, and the API works the same without it. More in [ARCHITECTURE.md](ARCHITECTURE.md#observability).

### Endpoints

| Method and path | Purpose | Statuses |
|---|---|---|
| `POST /wallets` | open a wallet | 201, 400, 409 (the player already has a wallet in that currency) |
| `GET /wallets/:walletId` | read a wallet | 200, 400, 404 |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | list the ledger with an opaque cursor | 200, 400, 404 |
| `POST /wallets/:walletId/reconciliation` | compare the stored balance with the ledger, never fixing it | 200, 400, 404 |
| `POST /wagering/transactions` | submit a transaction (header `Idempotency-Key` required) | 200, 202, 400, 409, 422, 503 |
| `GET /wagering/transactions/:transactionId` | read a transaction | 200, 400, 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | read a transaction by the provider reference | 200, 400, 404 |
| `GET /health/live`, `GET /health/ready` | liveness and readiness (PostgreSQL and SQS) | 200, 503 |
| `GET /metrics` | metrics in the Prometheus text format | 200 |

Every error has the same JSON shape, `{"error": {"code": ..., "message": ...}}`. A request body above 100 kB is a `413`, and an unexpected error is a `500` with a generic message.

What each status means on `POST /wagering/transactions`:

| Status | Meaning |
|---|---|
| 200 | processed, or a replay of a processed request |
| 202 | accepted and waiting for the transaction it references |
| 400 | invalid payload, or a missing or invalid `Idempotency-Key` |
| 409 | idempotency conflict: the same key with another payload |
| 422 | rejected by a business rule, with a `failureCode` |
| 503 | transient infrastructure failure, with `Retry-After` |

Transactions can also be sent to the queue `wager-transactions.fifo`, with the message format of the challenge statement. The failure codes, the reasons for each status and the rules of each kind are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Tests

All of them run against a real PostgreSQL and a real LocalStack, with no mocks of either.

```bash
docker compose --profile test run --rm tests
```

This runs the unit tests, the integration tests and the multi-instance test inside a container, with its own database and its own queues, so it can run while the application is up. It takes a few minutes.

On the host (needs Bun 1.4):

```bash
docker compose up -d --wait postgres localstack
cp .env.example .env
bun install
bun test src                     # unit tests
bun run test:integration         # integration and concurrency cases against the real services
bun run test:concurrency         # three real application processes, one killed with SIGKILL
INSTANCES=10 WALLETS=60 bun run test:concurrency   # a bigger run
```

The multi-instance test starts real processes of the application, sends mixed HTTP and SQS traffic with duplicates and out of order messages, kills one instance, restarts it and checks that every wallet balance equals the balance rebuilt from its ledger. [ARCHITECTURE.md](ARCHITECTURE.md) maps each scenario of the statement to the test that proves it.

### Load test

Optional in the statement. It runs on the host, with the same setup as above:

```bash
bun run test:load
```

It starts three application processes on a database of its own, runs three scenarios (traffic spread over 200 wallets, one hot wallet, a storm of duplicates), checks every balance against the ledger after each one and prints a Markdown report. `INSTANCES`, `CONCURRENCY`, `SPREAD_REQUESTS`, `HOT_REQUESTS` and `DUPLICATE_REQUESTS` change its size. It uses the test queues, so do not run it at the same time as the other suites. The results and what they show are in [ARCHITECTURE.md](ARCHITECTURE.md#load-test).

## Run without Docker for the app

```bash
docker compose up -d --wait postgres localstack
cp .env.example .env
bun install
bun run migration:up
bun run start                    # or: bun run dev
```

`bun run migration:down` reverts the last migration.

## Configuration

Environment variables (see `.env.example`):

| Variable | Meaning |
|---|---|
| `PORT` | HTTP port, 3000 by default |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error` or `fatal` |
| `DATABASE_URL` | PostgreSQL connection string |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | SQS client settings (LocalStack here) |
| `SQS_TRANSACTIONS_QUEUE_URL`, `SQS_TRANSACTIONS_DLQ_URL` | input queue and its dead-letter queue |
| `SQS_EVENTS_QUEUE_URL` | queue where the outbox publishes integration events |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional, where to send traces (OTLP over HTTP, for example `http://localhost:4318`). Without it nothing is traced. Docker Compose sets it for `app` |

## Project layout

```
src/domain          Money, wallet, ledger entry, wager transaction, inbox, outbox and events
src/application     use cases, commands, ports and queries
src/infrastructure  PostgreSQL persistence, SQS publisher and consumer, workers, health, logs, metrics and traces
src/http            controllers, error mapping and the authentication extension point
migrations          hand-written SQL migrations, each one reversible
test                integration, concurrency and crash tests
```
