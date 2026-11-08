import { ResourceNotFoundError } from "../../domain/errors";
import type { MoneyProps } from "../../domain/money";
import { assertUuid } from "../commands/ids";
import { type Observability, silentObservability } from "../ports";
import type { UnitOfWork } from "../unit-of-work";

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly observability: Observability = silentObservability,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    assertUuid(walletId, "walletId");
    const view = await this.uow.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      if (!wallet) {
        throw new ResourceNotFoundError("wallet not found");
      }
      const summary = await repositories.ledger.summarize(walletId, wallet.currency);
      const calculated = summary.credits.subtract(summary.debits);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.count,
      };
    });
    if (!view.consistent) {
      this.observability.metrics.reconciliationDivergence();
      this.observability.logger.error("reconciliation_divergence", {
        walletId,
        difference: view.difference.amount,
        checkedEntries: view.checkedEntries,
      });
    }
    return view;
  }
}
