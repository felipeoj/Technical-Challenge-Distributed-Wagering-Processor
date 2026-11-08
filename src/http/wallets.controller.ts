import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { OpenWallet } from "../application/open-wallet";
import { ListLedger } from "../application/queries/list-ledger";
import { GetWallet } from "../application/queries/get-wallet";
import { ReconcileWallet } from "../application/queries/reconcile-wallet";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListLedger) private readonly listLedger: ListLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    return this.openWallet.execute(body);
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.listLedger.execute(walletId, cursor, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(@Param("walletId") walletId: string) {
    return this.reconcileWallet.execute(walletId);
  }
}
