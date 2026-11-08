import { InboxMessage } from "../domain/messaging/inbox-message";
import { Money } from "../domain/money";
import { FailureCode } from "../domain/wagering/failure-code";
import { parseWagerCommand } from "./commands/wager-command";
import { newWagerTransaction } from "./new-wager-transaction";
import { payloadHash } from "./payload-hash";
import { type Clock, type Observability, silentObservability } from "./ports";
import type { ProcessOptions } from "./process-wager-transaction";
import type { UnitOfWork } from "./unit-of-work";
import { toWagerResult, type WagerResult } from "./wager-result";

export class FailWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly observability: Observability = silentObservability,
  ) {}

  async execute(rawCommand: unknown, options: ProcessOptions): Promise<WagerResult | undefined> {
    const command = parseWagerCommand(rawCommand);
    const money = Money.from(command.money);
    const hash = payloadHash(command);

    const result = await this.uow.run(async (repositories) => {
      const now = this.clock.now();
      const inbox = options.inbox
        ? InboxMessage.receive({ ...options.inbox, payloadHash: hash, receivedAt: now })
        : undefined;
      if (inbox) {
        await repositories.inbox.receive(inbox);
      }

      const wallet = await repositories.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) {
        return undefined;
      }

      const existing = await repositories.transactions.findByIdempotencyKey(options.idempotencyKey);
      if (existing) {
        return undefined;
      }

      const transaction = newWagerTransaction(command, money, options.idempotencyKey, hash, now);
      if (!(await repositories.transactions.insertIfAbsent(transaction))) {
        return undefined;
      }
      transaction.fail(FailureCode.PermanentError);
      await repositories.transactions.save(transaction);

      if (inbox) {
        inbox.markProcessed(now);
        await repositories.inbox.markProcessed(inbox);
      }
      return toWagerResult(transaction, false);
    });

    if (result) {
      this.observability.metrics.transactionResult(result.status, false);
      this.observability.logger.error("transaction_failed", {
        correlationId: options.correlationId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        messageId: options.inbox?.messageId,
        failureCode: result.failureCode,
      });
    }
    return result;
  }
}
