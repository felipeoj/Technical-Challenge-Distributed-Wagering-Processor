import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { connectIsolatedDatabase, run } from "../support/database";

let orm: MikroORM;

beforeAll(async () => {
  ({ orm } = await connectIsolatedDatabase("wagering_migrations_test"));
});

afterAll(async () => {
  await orm.close();
});

async function schemaObjects(): Promise<string[]> {
  const rows = await run<{ item: string }>(
    orm,
    `select item from (
       select 'column ' || table_name || '.' || column_name || ' ' || data_type as item
         from information_schema.columns where table_schema = 'public'
       union all
       select 'constraint ' || c.conname
         from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
       union all
       select 'index ' || indexname from pg_indexes where schemaname = 'public'
       union all
       select 'trigger ' || t.tgname
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
       union all
       select 'function ' || p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
     ) objects
     where item not like '%mikro_orm_migrations%'
     order by item`,
  );
  return rows.map((row) => row.item);
}

describe("migrations", () => {
  test("all of them can be reverted and applied again, leaving the same schema", async () => {
    const applied = await schemaObjects();
    expect(applied).toEqual(
      expect.arrayContaining([
        "constraint wallet_balance_non_negative",
        "constraint wallet_player_currency_unique",
        "constraint wager_transaction_idempotency_unique",
        "constraint ledger_arithmetic",
        "index wager_transaction_reversed_once",
        "trigger ledger_block_update_delete",
        "trigger ledger_block_truncate",
      ]),
    );

    const reverted = await orm.migrator.down({ to: 0 });
    expect(reverted.length).toBeGreaterThan(0);
    expect(await schemaObjects()).toEqual([]);

    const reapplied = await orm.migrator.up();
    expect(reapplied.map((migration) => migration.name)).toEqual(reverted.map((migration) => migration.name).reverse());
    expect(await schemaObjects()).toEqual(applied);
  });
});
