# Wagering Processor

A distributed financial service that applies betting transactions (BET, WIN, LOSS, REFUND and ROLLBACK) coming from several game providers, over HTTP and over an SQS queue. It keeps each wallet balance equal to the sum of its ledger, and it stays correct when messages are duplicated, arrive out of order or are processed at the same time by several instances.

The design decisions, trade-offs and known limits are in [ARCHITECTURE.md](ARCHITECTURE.md).

Stack: Bun, TypeScript (strict), NestJS, MikroORM, PostgreSQL 16, AWS SQS on LocalStack, Docker Compose.

## Run it

You only need Docker with Compose v2.

```bash
docker compose up --build -d --wait
```

This starts PostgreSQL, LocalStack (with the queues), the migrations, the API and a small gateway. The API answers at `http://localhost:3000`.

To run several instances behind the same URL:

```bash
docker compose up --build -d --wait --scale app=3
```

Stop everything with `docker compose down`.

## Try it

```bash
# create a wallet with 1000.00 BRL
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# place a bet (use the wallet id returned above)
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<wallet id>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Sending the same request again returns the same transaction with `"idempotentReplay": true`. Then:

```bash
curl -s 'localhost:3000/wallets/<wallet id>/ledger?limit=50'
curl -s -X POST localhost:3000/wallets/<wallet id>/reconciliation
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

With several instances, the `X-Upstream` response header shows which one answered.

### Endpoints

| Method and path | Purpose |
|---|---|
| `POST /wallets` | open a wallet |
| `GET /wallets/:walletId` | read a wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | list the ledger with an opaque cursor |
| `POST /wallets/:walletId/reconciliation` | compare the stored balance with the ledger |
| `POST /wagering/transactions` | submit a transaction (header `Idempotency-Key` required) |
| `GET /wagering/transactions/:transactionId` | read a transaction |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | read a transaction by the provider reference |
| `GET /health/live`, `GET /health/ready` | liveness and readiness (PostgreSQL and SQS) |
| `GET /metrics` | metrics in the Prometheus text format |

Transactions can also be sent to the queue `wager-transactions.fifo` with the message format of the challenge statement.

HTTP status codes: 400 invalid payload or header, 404 missing resource, 409 idempotency conflict or duplicate wallet, 422 rejected by a business rule (with a `failureCode`), unknown wallet or permanent failure, 202 accepted and waiting for its reference, 503 with `Retry-After` for a transient infrastructure failure.

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

The multi-instance test starts real processes of the application, sends mixed HTTP and SQS traffic with duplicates and out of order messages, kills one instance, restarts it and checks that every wallet balance equals the balance rebuilt from its ledger.

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

## Project layout

```
src/domain          Money, wallet, ledger entry, wager transaction, inbox, outbox and events
src/application     use cases, commands, ports and queries
src/infrastructure  PostgreSQL persistence, SQS publisher and consumer, workers, health, logs and metrics
src/http            controllers, error mapping and the authentication extension point
migrations          hand-written SQL migrations, each one reversible
test                integration, concurrency and crash tests
```
