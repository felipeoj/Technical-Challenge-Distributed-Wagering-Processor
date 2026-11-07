import { Migration } from "@mikro-orm/migrations";

export class Migration20261107010000_initial_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallet (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(19,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallet_balance_non_negative check (balance >= 0),
        constraint wallet_version_positive check (version >= 1),
        constraint wallet_player_currency_unique unique (player_id, currency)
      )
    `);

    this.addSql(`
      create table wager_transaction (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallet (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transaction (id),
        status text not null,
        failure_code text,
        observed_balance numeric(19,2),
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transaction_idempotency_unique unique (idempotency_key),
        constraint wager_transaction_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transaction_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transaction_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transaction_amount_non_negative check (amount >= 0),
        constraint wager_transaction_reversal_has_reference
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transaction_rejected_has_code
          check (status not in ('REJECTED', 'FAILED') or failure_code is not null),
        constraint wager_transaction_processed_has_time
          check (status <> 'PROCESSED' or processed_at is not null)
      )
    `);

    this.addSql(`
      create unique index wager_transaction_reversed_once
        on wager_transaction (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);

    this.addSql(`
      create index wager_transaction_pending_reference_due
        on wager_transaction (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create index wager_transaction_wallet on wager_transaction (wallet_id)
    `);

    this.addSql(`
      create table wallet_ledger_entry (
        seq bigint generated always as identity,
        id uuid primary key,
        wallet_id uuid not null references wallet (id),
        transaction_id uuid not null references wager_transaction (id),
        direction text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,
        constraint ledger_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_before + amount = balance_after)
          or (direction = 'DEBIT' and balance_before - amount = balance_after)
        ),
        constraint ledger_one_entry_per_transaction unique (transaction_id, wallet_id)
      )
    `);

    this.addSql(`
      create index ledger_wallet_seq on wallet_ledger_entry (wallet_id, seq)
    `);

    this.addSql(`
      create function reject_ledger_change() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entry is append-only (% not allowed)', tg_op;
      end
      $$
    `);

    this.addSql(`
      create trigger ledger_block_update_delete
        before update or delete on wallet_ledger_entry
        for each row execute function reject_ledger_change()
    `);

    this.addSql(`
      create trigger ledger_block_truncate
        before truncate on wallet_ledger_entry
        for each statement execute function reject_ledger_change()
    `);

    this.addSql(`
      create table inbox_message (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_message (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz
      )
    `);

    this.addSql(`
      create index outbox_message_pending on outbox_message (occurred_at)
        where published_at is null
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop table if exists outbox_message");
    this.addSql("drop table if exists inbox_message");
    this.addSql("drop table if exists wallet_ledger_entry");
    this.addSql("drop function if exists reject_ledger_change()");
    this.addSql("drop table if exists wager_transaction");
    this.addSql("drop table if exists wallet");
  }
}
