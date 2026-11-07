// Base class for every domain rule violation. The stable `code` lets outer layers
// (HTTP, SQS consumer) classify an error without parsing its message.
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// Messages never echo the offending input: it may be huge or sensitive, and logs must stay clean.
export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = "INVALID_WALLET_OPERATION";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}

export class InvalidMessageStateError extends DomainError {
  readonly code = "INVALID_MESSAGE_STATE";
}
