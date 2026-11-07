export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletNotFound = "WALLET_NOT_FOUND",
  PlayerMismatch = "PLAYER_MISMATCH",
  PermanentError = "PERMANENT_ERROR",
}
