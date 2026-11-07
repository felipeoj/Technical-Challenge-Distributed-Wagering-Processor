import { v7 as uuidv7 } from "uuid";
import { InsufficientFundsError } from "../domain/errors";
import type { EventContext } from "../domain/messaging/events/integration-event";
import { WagerTransactionProcessed } from "../domain/messaging/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/messaging/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../domain/messaging/events/wallet-balance-changed";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { FailureCode } from "../domain/wagering/failure-code";
import type { WagerTransaction } from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { Repositories } from "./repositories";

export interface SettlementContext {
  repositories: Repositories;
  wallet: Wallet;
  transaction: WagerTransaction;
  now: Date;
  correlationId: string;
}

export interface MovementOptions {
  referenceTransactionId?: string;
  insufficientFundsCode?: FailureCode;
}

export function eventContext({ transaction, now, correlationId }: SettlementContext): EventContext {
  return { eventId: uuidv7(), correlationId, causationId: transaction.id, occurredAt: now };
}

export async function applyMovement(
  context: SettlementContext,
  type: "debit" | "credit",
  options: MovementOptions = {},
): Promise<void> {
  const { repositories, wallet, transaction, now } = context;
  const readVersion = wallet.version;
  const movement = {
    entryId: uuidv7(),
    transactionId: transaction.id,
    money: transaction.money,
    at: now,
  };
  let entry;
  try {
    entry = type === "debit" ? wallet.debit(movement) : wallet.credit(movement);
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      return reject(context, options.insufficientFundsCode ?? FailureCode.InsufficientFunds);
    }
    throw error;
  }
  await repositories.ledger.insert(entry);
  await repositories.wallets.save(wallet, readVersion);
  transaction.markProcessed(options.referenceTransactionId, wallet.balance, now);
  await repositories.transactions.save(transaction);
  await repositories.outbox.add(
    OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext(context))),
  );
  await repositories.outbox.add(
    OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, eventContext(context))),
  );
}

export async function recordWithoutMovement(context: SettlementContext): Promise<void> {
  const { repositories, wallet, transaction, now } = context;
  transaction.markProcessed(undefined, wallet.balance, now);
  await repositories.transactions.save(transaction);
  await repositories.outbox.add(
    OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext(context))),
  );
}

export async function reject(context: SettlementContext, code: FailureCode): Promise<void> {
  const { repositories, wallet, transaction } = context;
  transaction.reject(code, wallet.balance);
  await repositories.transactions.save(transaction);
  await repositories.outbox.add(
    OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, eventContext(context))),
  );
}
