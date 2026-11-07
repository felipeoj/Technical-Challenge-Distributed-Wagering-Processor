import { Money } from "../../../domain/money";
import type { LedgerDirection } from "../../../domain/wallet/ledger-direction";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import type { LedgerEntryRecord } from "../schemas/ledger-entry.schema";

export function ledgerEntryToRecordData(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    balanceBefore: Money.from({ amount: record.balanceBefore, currency: record.currency }),
    balanceAfter: Money.from({ amount: record.balanceAfter, currency: record.currency }),
    createdAt: record.createdAt,
  });
}
