import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from "../errors";
import type { Money } from "../money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Movement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError("initial balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: Movement): WalletLedgerEntry {
    this.assertValid(movement.money);
    const after = this._balance.subtract(movement.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError("debit would make the balance negative");
    }
    return this.apply(LedgerDirection.Debit, movement, after);
  }

  credit(movement: Movement): WalletLedgerEntry {
    this.assertValid(movement.money);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  private apply(direction: LedgerDirection, movement: Movement, after: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertValid(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError("operation currency differs from the wallet currency");
    }
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError("amount must be positive");
    }
  }
}
