import { LockMode, type SqlEntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import type { WalletRepository } from "../../../application/repositories";
import { ConcurrentModificationError, DuplicateWalletError } from "../../../domain/errors";
import type { Wallet } from "../../../domain/wallet/wallet";
import { walletToDomain, walletToRecordData } from "../mappers/wallet.mapper";
import { WalletRecord } from "../schemas/wallet.schema";

export class MikroWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, walletToRecordData(wallet));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new DuplicateWalletError("a wallet already exists for this player and currency");
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { refresh: true });
    return record ? walletToDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? walletToDomain(record) : undefined;
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (updated !== 1) {
      throw new ConcurrentModificationError(`wallet ${wallet.id} changed since it was read`);
    }
  }
}
