import type { InboxMessage } from "../domain/messaging/inbox-message";
import type { Money } from "../domain/money";
import type { OutboxMessage } from "../domain/messaging/outbox-message";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  findDueForReferenceRetry(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageItem {
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerSummary {
  credits: Money;
  debits: Money;
  count: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPageItem[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  receive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  oldestPendingAt(): Promise<Date | undefined>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}
