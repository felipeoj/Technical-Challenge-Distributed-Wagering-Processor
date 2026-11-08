import type { SqlEntityManager } from "@mikro-orm/postgresql";
import type { LedgerPageItem, LedgerRepository, LedgerSummary } from "../../../application/repositories";
import { Money } from "../../../domain/money";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { ledgerEntryToDomain, ledgerEntryToRecordData } from "../mappers/ledger-entry.mapper";
import { LedgerEntryRecord } from "../schemas/ledger-entry.schema";

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerEntryToRecordData(entry));
  }

  async listByWallet(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      afterSeq ? { walletId, seq: { $gt: afterSeq } } : { walletId },
      { orderBy: { seq: "asc" }, limit, refresh: true },
    );
    return records.map((record) => ({ seq: String(record.seq), entry: ledgerEntryToDomain(record) }));
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = (await this.em.execute(
      `select
         coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(19,2)::text as credits,
         coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::numeric(19,2)::text as debits,
         count(*)::int as total
       from wallet_ledger_entry where wallet_id = ?`,
      [walletId],
    )) as Array<{ credits: string; debits: string; total: number }>;
    return {
      credits: Money.from({ amount: row?.credits ?? "0.00", currency }),
      debits: Money.from({ amount: row?.debits ?? "0.00", currency }),
      count: row?.total ?? 0,
    };
  }
}
