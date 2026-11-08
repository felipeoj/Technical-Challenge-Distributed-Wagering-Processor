# Architecture

This document explains how the service is built, why, and where it stops. The sections follow the topics the challenge asks to justify: the ORM and the money mapping, the concurrency strategy, idempotency, the state model, the failure codes, authentication, and the interpretations I had to make.

## Overview

One bounded context, four layers:

- `domain`: `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage` and the integration events. Plain TypeScript. The only external dependency is `decimal.js`, through `Money`.
- `application`: the use cases (open a wallet, process a transaction, retry pending references, record a permanent failure, the read queries) and the ports they need (repositories, unit of work, clock, logger, metrics).
- `infrastructure`: PostgreSQL persistence with MikroORM, the SQS publisher and consumer, the background workers, health checks, logs and metrics.
- `http`: controllers, the error mapper and the authentication extension point.

The application layer has no port for publishing messages. Only the outbox publisher in `infrastructure/sqs` talks to SQS, so a use case cannot publish an event before its transaction commits, even by mistake.

The same use case serves HTTP and SQS. The consumer only adds the inbox record and the error classification around it.

A wallet is the unit of concurrency. A transaction is applied inside one SQL transaction that touches the wallet, the transaction row, the ledger, the inbox and the outbox.

## Money

`Money` is an immutable value object around a `Decimal`. The amount enters and leaves as a string with exactly two decimals, and the currency is three uppercase letters.

Input is validated with a strict pattern before any `Decimal` is created, so `NaN`, `Infinity`, scientific notation, an empty string, a comma, a sign, a space, digits of other alphabets and more than two decimals are all rejected. There is no rounding anywhere: an amount that needs rounding is rejected instead of silently losing a cent. An amount accepts at most 17 integer digits, which is what `numeric(19,2)` can store, so the domain never accepts something the database cannot hold.

The results of `add`, `subtract` and `negate` can be negative (a reconciliation difference is an example), so only `Money.from`, the door for external data, rejects negatives. A wallet never holds a negative balance: that is enforced by the wallet and, independently, by a `CHECK` in the database.

Operations between different currencies throw a domain error. The model is multi-currency, but in practice the tests use BRL, plus USD where a currency conflict has to be shown.

In the database an amount is `numeric(19,2)` and a currency is a separate `char(3)` column. MikroORM reads `numeric` back as a string and the mappers hand that string to `Money.from`, so a money value never passes through a JavaScript `number`. A test (`money-guard.test.ts`) fails if a number conversion (`parseFloat`, `parseInt`, `Number(`) appears in production code outside two known cases (a page size and a receive count), if the money classes declare a `number`, or if a migration uses a floating point type.

## ORM and persistence

I used MikroORM, as the statement prefers. The records are `EntitySchema` definitions (no decorators), kept apart from the domain classes. Mappers convert in both directions, and the domain classes are rebuilt with `rehydrate`, which does not revalidate transitions. The domain therefore knows nothing about the ORM.

A unit of work wraps `em.fork().transactional(...)`. It hands the use case repositories that are already bound to the transaction, so wallet, transaction, ledger, inbox and outbox commit together or not at all. It also sets `SET LOCAL lock_timeout` (5 seconds) so a long wait becomes a transient error instead of hanging. Lock timeouts, deadlocks, serialization failures and connection errors are translated into a transient infrastructure error, which HTTP maps to 503 and the consumer retries.

Schema changes are hand-written SQL migrations, because triggers, partial indexes and check constraints cannot be generated reliably. Each migration has a `down`.

## Concurrency

Strategy: pessimistic locking per wallet. A use case reads the wallet with `SELECT ... FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`) and keeps the lock until the transaction ends. Different wallets never block each other, and there is no global lock. The lock lives in PostgreSQL, so it holds across any number of application instances.

The wallet `version` is a second barrier. The update is `WHERE id = ? AND version = ?`, and zero updated rows is a transient error. The row lock should make that impossible, so it only guards against a bug.

Why not the alternatives:

- Optimistic locking with retries needs a retry loop, and under a hot wallet it wastes work and can starve. The pessimistic version is deterministic and easy to prove.
- A conditional atomic `UPDATE wallet SET balance = balance - x WHERE balance >= x` is simple, but each ledger entry stores `balance_before` and `balance_after`, so the balance has to be read in the same step.

Lock order inside a transaction is fixed: lock the wallet, then insert the idempotency row, then resolve the reference. I first did it the other way, and a test with ten parallel bets deadlocked. Inserting the transaction row takes a `FOR KEY SHARE` lock on the wallet row because of the foreign key, and two concurrent transactions then both asked for `FOR UPDATE`, each waiting for the other. Locking the wallet first removes the cycle. A side effect is that a request for a wallet that does not exist is detected at the lock.

## Idempotency

`Idempotency-Key` is required, and it is the source of truth. The usual value is `{providerId}:{externalTransactionId}`. Queue messages carry their own key, with the same default.

Everything lives in the database, so any instance sees the same answer:

- `UNIQUE (idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)` on `wager_transaction`.
- The transaction row is inserted with `INSERT ... ON CONFLICT DO NOTHING`. If it was not inserted, the existing row is read. The same payload hash returns the stored result with `idempotentReplay: true`. Another payload hash is a conflict (409), not a replay.
- A business rejection is committed as a `REJECTED` row with the balance observed at that moment, so its replay is stable. A technical failure rolls everything back, key included, and the provider can send the same request again.
- A replay returns the balance observed when the transaction was first applied, not the current one.

`payloadHash` is the SHA-256 (hex) of a canonical JSON of the business fields: provider id, external transaction id, player id, wallet id, round id, game id, kind, money (normalized by `Money`) and the reference id when there is one. The canonical JSON sorts the keys at every level and drops undefined values. The idempotency key, headers and transport metadata are not part of it.

## Schema guarantees

The invariants live in the database, not only in the code:

- `wallet`: `CHECK (balance >= 0)`, `CHECK (version >= 1)`, `UNIQUE (player_id, currency)`.
- `wager_transaction`: the two unique constraints above, checks for the allowed kinds and statuses, a reversal must carry a reference, a `REJECTED` or `FAILED` row must carry a failure code, a `PROCESSED` row must carry its time. A partial unique index allows only one `PROCESSED` reversal (REFUND or ROLLBACK) per referenced transaction.
- `wallet_ledger_entry`: positive amount, non-negative balances, a check that `balance_before` plus or minus the amount equals `balance_after` according to the direction, and `UNIQUE (transaction_id, wallet_id)`. A row trigger rejects `UPDATE` and `DELETE`, and a statement trigger rejects `TRUNCATE`, so the ledger is append-only.
- `inbox_message`: primary key `(consumer_name, message_id)`.
- `outbox_message`: a partial index over the unpublished rows.

## Transaction states

`PENDING` is where every transaction starts. `PROCESSED`, `REJECTED` and `FAILED` are terminal, and any transition out of them throws `InvalidTransactionStateError`, because it would be a programming error and not a business path.

| From | To | When |
|---|---|---|
| `PENDING` | `PROCESSED` | the rule was applied |
| `PENDING` | `REJECTED` | a business rule was violated |
| `PENDING` | `PENDING_REFERENCE` | the referenced transaction does not exist yet |
| `PENDING` | `FAILED` | a permanent infrastructure failure was recorded |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | another retry, the reference is still missing |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED` or `FAILED` | the reference showed up, or the limit was reached |

`OPENING` is a kind used only internally for the initial balance of a wallet. The API and the queue reject it.

## Failure codes

Every rejection carries a stable, machine readable code. This is what the provider should do with each one.

| Code | Meaning | Provider should |
|---|---|---|
| `INSUFFICIENT_FUNDS` | a bet needs more than the balance | stop, or retry later with a new transaction |
| `REVERSAL_WOULD_OVERDRAW` | undoing the reference would make the balance negative | do not retry, it needs a human |
| `REFERENCE_NOT_FOUND` | the reference never arrived within the retry limit | check the reference id, then send a new transaction |
| `REFERENCE_NOT_PROCESSED` | the reference exists but was rejected or failed | give up, there is nothing to revert |
| `REFERENCE_MISMATCH` | the reference belongs to another player, wallet, round or currency | fix the payload |
| `INVALID_REFERENCE_KIND` | the reference has a kind this operation cannot point to | fix the payload |
| `REFERENCE_ALREADY_REVERSED` | the reference already has a processed reversal | give up |
| `AMOUNT_MISMATCH` | the reversal amount differs from the reference amount | fix the payload |
| `CURRENCY_MISMATCH` | the currency differs from the wallet currency | fix the payload |
| `PLAYER_MISMATCH` | the player does not own the wallet | fix the payload |
| `PERMANENT_ERROR` | the transaction was recorded as `FAILED` after infrastructure retries ran out | send a new transaction with another id |

A rejection after the key was used cannot be retried with the same key: the replay returns the same rejection. To try again the provider sends a new external transaction id.

## References and out of order delivery

REFUND and ROLLBACK need a reference. A WIN may carry one. The reference is looked up by provider and reference id, and it has to belong to the same player, wallet, currency and round. A REFUND points only to a BET. A ROLLBACK points to a BET, a WIN or a REFUND, and a WIN points only to a BET.

If the reference is missing, or it is itself still waiting, the transaction is stored as `PENDING_REFERENCE`, a `WagerTransactionPendingReference` event is published once, and a worker retries it. The delay doubles from 1 second up to 5 minutes. After 10 attempts, about 13 and a half minutes, it becomes `REJECTED` with `REFERENCE_NOT_FOUND` and a `WagerTransactionRejected` event. A provider that sends a reversal before its bet normally only disagrees by seconds, so the window is generous and still bounded.

Two workers can pick the same pending row. Each one locks the wallet first and reads the row again, so the second finds it already resolved and skips it.

Reversal amount must equal the reference amount. A reversal that would make the balance negative is rejected with its own code, different from a bet without funds. A ROLLBACK applies the inverse direction of what it reverts and keeps the amount positive.

### One reversal per reference

The statement forbids reverting a reference twice with the same kind. I made it stricter: a reference accepts one processed reversal of any kind. Read literally, a bet could receive a REFUND and then a ROLLBACK, and the player would be credited twice for one bet. The price is that a refund that was itself rolled back cannot be redone. It is enforced in the use case and, independently, by a unique index, and a schema test shows the index rejecting a second processed reversal on its own.

## Outbox and publishing

Events are written to `outbox_message` in the same SQL transaction as the change that caused them. Four events exist: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (only when the balance moves) and `WagerTransactionPendingReference`. Each one is a class with its type and version in the type, and its data carries money as strings.

A publisher claims due rows with `FOR UPDATE SKIP LOCKED`, sends them to `wager-events.fifo` (the group id is the wallet id and the deduplication id is the event id) and marks them published before committing. Several publishers get different rows. It only sees rows that were already committed, so nothing is published before the financial commit.

If the process dies before sending, the transaction of the publisher is rolled back and another instance takes the rows. If it dies after sending and before committing, the row is sent again later. The event id is stable and FIFO deduplication drops the second copy inside its window, and consumers must deduplicate by event id anyway. A failed send keeps the row with `attempts + 1` and a delay that doubles.

## SQS consumer

The consumer reads `wager-transactions.fifo`, runs the same use case as HTTP and registers the message in the inbox inside the same transaction. It deletes the message only after the use case returns, which is after the commit. A redelivery therefore finds the stored result and changes nothing.

It sorts errors in three kinds:

- Business errors (unknown wallet, idempotency conflict) are acknowledged, because retrying cannot change the outcome.
- Permanent errors (invalid JSON, wrong type, an invalid amount or field) go straight to the dead-letter queue with a `failureReason`.
- Anything else keeps the message in the queue with a visibility delay of 2^n seconds (at most 60). The retry limit is the queue's own redrive after 5 receives.

When the limit is reached, the cause decides what happens. If it was an infrastructure failure, the transaction is recorded as `FAILED` and the queue moves the message to the dead-letter queue. If it was an unexpected error, which is probably a bug, the message goes to the dead-letter queue without a `FAILED` record, so it can be sent back to the main queue once the bug is fixed.

On shutdown the consumer finishes the message it is processing and gives back the others of the batch.

`FAILED` is never created by the HTTP path, where a technical failure rolls everything back and the provider retries, and not for invalid payloads, which have nothing valid to store.

## HTTP API

The paths are the ones in the statement, with no version prefix. A single error mapper serves every endpoint:

| Status | Meaning |
|---|---|
| 200 | processed, or the replay of a processed transaction |
| 202 | accepted, waiting for its reference |
| 400 | invalid payload or header |
| 404 | a read for something that does not exist |
| 409 | idempotency conflict, or a wallet that already exists for that player and currency |
| 422 | rejected by a business rule (with the failure code), unknown wallet on submit, or a permanent failure |
| 503 with `Retry-After` | transient infrastructure failure, send the same request again |
| 500 | anything unexpected, with a generic body |

Ledger pages are ordered by an identity column and use an opaque cursor that holds the last sequence. A page is read with one extra row to know whether another page exists, and new entries land at the end, so a cursor never repeats or skips an entry.

Reconciliation locks the wallet briefly, so the stored balance and the ledger sum come from the same moment. A difference is logged as an error, counted in a metric and returned in the response, and nothing is corrected silently.

## Observability

Logs are JSON, one event per line, with `correlationId`, `transactionId`, `walletId`, `providerId` and `messageId` where they apply, and never an amount or a payload. A request for a wallet that does not exist is logged with the provider, the wallet asked for and the idempotency key, and counted.

Metrics are served at `/metrics` in the Prometheus text format, one registry per instance: transactions by status, duplicates detected, retries by kind, messages sent to the dead-letter queue, lock conflicts, outbox lag, processing latency, unknown wallets and reconciliation divergences. The statement does not ask for a particular format, and I picked this one because it needs no extra infrastructure.

`/health/live` answers as long as the process is up. `/health/ready` checks PostgreSQL and SQS and returns 503 if either is down. Both are open.

## Authentication

Not implemented, as the statement allows. The extension point is explicit: a global `NoopAuthGuard`, which can be replaced without touching a controller. Health and metrics would stay open, and queue messages are treated as a trusted internal channel, with the same domain validations as HTTP.

The design I would adopt: an external identity provider (Keycloak or Zitadel) with OpenID Connect and the client credentials flow, one client per game provider. The guard validates the signed token and takes the provider identity from a claim, and a `ProviderIdentityPort` compares that identity with the `providerId` in the body, so one provider cannot act for another. Wallet endpoints used by operators would need a role claim.

## Testing

Everything that matters runs against a real PostgreSQL and a real LocalStack, in containers. The only test double is a stub of the processing use case in the single test that needs an unexpected error. Failures are provoked with real means: a row lock held by another connection, a dead SQS endpoint, a process killed with `process.exit` at an exact point, and a process killed with `SIGKILL`.

- Unit tests: money, wallet, ledger entry, transaction transitions, outbox and inbox, events, the payload hash, the error mapper, the cursor, the message parsing and the worker loop.
- Integration tests: constraints and triggers, atomicity, idempotency, all the rules, reversals and pending references, the HTTP API (the whole application on a random port), the publisher, the consumer.
- Concurrency tests: the same bet 50 times in parallel, two bets of 80.00 on a 100.00 wallet, ten parallel bets on one wallet, wallets in parallel, a reversal racing with its own bet, several publishers and consumers, a worker killed after the commit and before the ack, and a publisher killed before and after sending.
- The multi-instance test starts three real processes of the application (the size is configurable, and it also passes with 12), sends mixed HTTP and SQS traffic with duplicates in shuffled order, kills one instance with `SIGKILL`, restarts it and waits for the system to settle. Then it checks that each transaction exists once, that every wallet balance equals the balance rebuilt from its ledger, that the outbox is fully published and that the dead-letter queue is empty.

Every test ends by checking that the stored balance equals the balance rebuilt from the ledger. The tests use their own databases and queues, so a running application never interferes.

## Interpretations and decisions

- An amount needs exactly two decimals: `"25"` and `"25.5"` are rejected.
- One processed reversal per reference, of any kind.
- A WIN with a reference follows the same checks as a reversal, but its amount does not have to match the bet and several WINs may point to one bet.
- A request for a wallet that does not exist answers 422 and stores nothing, to keep the foreign key strict. The attempt is logged and counted.
- A `FAILED` transaction answers 422 with `PERMANENT_ERROR`: the provider must not resend it with the same id.
- A third queue, `wager-events.fifo`, carries the outbox events. Otherwise the consumer would read its own events. The tests use their own copies of the queues so they can run while an instance is consuming the real ones.
- LocalStack is pinned to 3.8.1, because newer images refuse to start without an account token, and a reviewer would not have one.
- Instances are exposed behind a small nginx gateway, because the statement says nothing about it and a port range gave unpredictable ports.
- The metrics library, `prom-client`, is flagged as deprecated in favour of a newer client. I kept it because it is widely used and works, rather than adopt a new library right before delivery.

## Limits and trade-offs

- A very hot wallet serializes: every operation on it queues on one lock. That is the price of the simple, provable strategy.
- The order of the events of one wallet is not guaranteed with concurrent publishers. Events carry `occurredAt` and, for balance changes, `walletVersion`, so a consumer can order them.
- The publisher calls SQS while it holds the row locks. Batches are small to keep that short.
- A long database outage would exhaust the retries of messages that are fine and send them to the dead-letter queue, recording them as `FAILED`. A circuit breaker that pauses consumption while the database is down would avoid that, and I did not build it.
- There is no tool to send dead-letter messages back to the main queue. The idempotency would make it safe, and it is the natural next step.
- The ledger triggers do not stop the owner of the table, who can disable them. The application should connect with a role that can only `SELECT` and `INSERT` on the ledger. I did not do that.
- Currencies are only checked for the pattern of three uppercase letters, not against the ISO list.
- The ledger is single-entry. A double-entry ledger is an optional extra that I left out, because it changes the constraints that sustain the financial guarantees.
- There is no load test, and no OpenTelemetry or dashboard.
