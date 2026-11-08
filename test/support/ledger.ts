import type { MikroORM } from "@mikro-orm/postgresql";
import { run } from "./database";

export async function ledgerBalance(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await run<{ total: string }>(
    orm,
    "select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as total from wallet_ledger_entry where wallet_id = ?",
    [walletId],
  );
  return row?.total ?? "0.00";
}

export async function storedBalance(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await run<{ balance: string }>(orm, "select balance::text as balance from wallet where id = ?", [
    walletId,
  ]);
  return row?.balance ?? "";
}
