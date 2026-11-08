import { ResourceNotFoundError } from "../../domain/errors";
import { assertUuid } from "../commands/ids";
import type { UnitOfWork } from "../unit-of-work";
import { toWalletView, type WalletView } from "../wallet-view";

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    assertUuid(walletId, "walletId");
    const wallet = await this.uow.run((repositories) => repositories.wallets.findById(walletId));
    if (!wallet) {
      throw new ResourceNotFoundError("wallet not found");
    }
    return toWalletView(wallet);
  }
}
