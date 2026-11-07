import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../errors";
import type { Money } from "../money";
import { LedgerDirection } from "../wallet/ledger-direction";
import { FailureCode } from "./failure-code";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const transaction = WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
    if (transaction.requiresReference() && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference transaction`);
    }
    if (transaction.affectsBalance() && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError("amount must be positive");
    }
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertOpen();
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidWagerTransactionError(`${this.kind} needs the reference transaction id`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, observedBalance: Money): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertOpen();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError("ROLLBACK needs its reference to find the direction");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      default:
        throw new InvalidWagerTransactionError(`${this.kind} has no ledger entry`);
    }
  }

  private assertOpen(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction is already ${this._status}`);
    }
  }
}
