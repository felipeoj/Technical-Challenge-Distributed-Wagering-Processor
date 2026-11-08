import { v7 as uuidv7 } from "uuid";
import { WalletBalanceChanged } from "../domain/messaging/events/wallet-balance-changed";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import { Money } from "../domain/money";
import { WagerTransaction } from "../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../domain/wagering/wager-transaction-kind";
import { LedgerDirection } from "../domain/wallet/ledger-direction";
import { Wallet } from "../domain/wallet/wallet";
import { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";
import { parseOpenWalletCommand } from "./commands/open-wallet-command";
import type { Clock } from "./ports";
import type { UnitOfWork } from "./unit-of-work";
import { toWalletView, type WalletView } from "./wallet-view";

export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(rawCommand: unknown): Promise<WalletView> {
    const command = parseOpenWalletCommand(rawCommand);
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const wallet = Wallet.open({
      id: uuidv7(),
      playerId: command.playerId,
      initialBalance,
      at: now,
    });

    await this.uow.run(async (repositories) => {
      await repositories.wallets.insert(wallet);
      if (!initialBalance.isPositive()) {
        return;
      }
      const opening = WagerTransaction.create({
        id: uuidv7(),
        providerId: "INTERNAL",
        externalTransactionId: wallet.id,
        idempotencyKey: `OPENING:${wallet.id}`,
        payloadHash: "opening",
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "opening",
        gameId: "opening",
        kind: WagerTransactionKind.Opening,
        money: initialBalance,
        createdAt: now,
      });
      opening.markProcessed(undefined, initialBalance, now);
      await repositories.transactions.insertIfAbsent(opening);
      const entry = WalletLedgerEntry.create({
        id: uuidv7(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(initialBalance.currency),
        balanceAfter: initialBalance,
        createdAt: now,
      });
      await repositories.ledger.insert(entry);
      await repositories.outbox.add(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            eventId: uuidv7(),
            correlationId: uuidv7(),
            causationId: opening.id,
            occurredAt: now,
          }),
        ),
      );
    });

    return toWalletView(wallet);
  }
}
