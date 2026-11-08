import { v7 as uuidv7 } from "uuid";
import { IdempotencyConflictError, WalletNotFoundError } from "../domain/errors";
import { InboxMessage } from "../domain/messaging/inbox-message";
import { Money } from "../domain/money";
import { WagerTransaction } from "../domain/wagering/wager-transaction";
import { parseWagerCommand } from "./commands/wager-command";
import { payloadHash } from "./payload-hash";
import { type Clock, type Observability, silentObservability } from "./ports";
import type { Repositories } from "./repositories";
import type { UnitOfWork } from "./unit-of-work";
import { settle } from "./wager-settlement";
import { toWagerResult, type WagerResult } from "./wager-result";

export interface ProcessOptions {
  idempotencyKey: string;
  correlationId?: string;
  inbox?: { messageId: string; consumerName: string };
}

export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly observability: Observability = silentObservability,
  ) {}

  async execute(rawCommand: unknown, options: ProcessOptions): Promise<WagerResult> {
    const startedAt = performance.now();
    const command = parseWagerCommand(rawCommand);
    const money = Money.from(command.money);
    const hash = payloadHash(command);
    const correlationId = options.correlationId ?? uuidv7();

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
        this.observability.metrics.walletNotFound();
        this.observability.logger.warn("wallet_not_found", {
          correlationId,
          providerId: command.providerId,
          walletId: command.walletId,
          idempotencyKey: options.idempotencyKey,
          messageId: options.inbox?.messageId,
        });
        throw new WalletNotFoundError("wallet does not exist");
      }

      let outcome = await this.findReplay(repositories, options.idempotencyKey, hash);
      if (!outcome) {
        const transaction = WagerTransaction.create({
          id: uuidv7(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: options.idempotencyKey,
          payloadHash: hash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: now,
        });
        const inserted = await repositories.transactions.insertIfAbsent(transaction);
        if (!inserted) {
          outcome = await this.findReplay(repositories, options.idempotencyKey, hash);
          if (!outcome) {
            throw new IdempotencyConflictError("transaction already exists under another idempotency key");
          }
        } else {
          await settle({ repositories, wallet, transaction, now, correlationId });
          outcome = toWagerResult(transaction, false);
        }
      }

      if (inbox) {
        inbox.markProcessed(now);
        await repositories.inbox.markProcessed(inbox);
      }
      return outcome;
    });

    this.observability.metrics.transactionResult(result.status, result.idempotentReplay);
    this.observability.metrics.processingDuration((performance.now() - startedAt) / 1000);
    this.observability.logger.info("transaction_result", {
      correlationId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      messageId: options.inbox?.messageId,
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode,
      replay: result.idempotentReplay,
    });
    return result;
  }

  private async findReplay(
    repositories: Repositories,
    idempotencyKey: string,
    hash: string,
  ): Promise<WagerResult | undefined> {
    const existing = await repositories.transactions.findByIdempotencyKey(idempotencyKey);
    if (!existing) {
      return undefined;
    }
    if (!existing.matchesPayload(hash)) {
      throw new IdempotencyConflictError("idempotency key already used with a different payload");
    }
    return toWagerResult(existing, true);
  }
}
