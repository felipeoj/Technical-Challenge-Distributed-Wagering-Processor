import { ResourceNotFoundError } from "../../domain/errors";
import { assertUuid } from "../commands/ids";
import { parseProviderReference } from "../commands/wager-command";
import { toTransactionView, type TransactionView } from "../transaction-view";
import type { UnitOfWork } from "../unit-of-work";

export class GetTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<TransactionView> {
    assertUuid(transactionId, "transactionId");
    const transaction = await this.uow.run((repositories) => repositories.transactions.findById(transactionId));
    if (!transaction) {
      throw new ResourceNotFoundError("transaction not found");
    }
    return toTransactionView(transaction);
  }

  async byProviderReference(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const reference = parseProviderReference(providerId, externalTransactionId);
    const transaction = await this.uow.run((repositories) =>
      repositories.transactions.findByProviderAndExternalId(reference.providerId, reference.externalTransactionId),
    );
    if (!transaction) {
      throw new ResourceNotFoundError("transaction not found");
    }
    return toTransactionView(transaction);
  }
}
