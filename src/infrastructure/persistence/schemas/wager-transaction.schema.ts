import { EntitySchema } from "@mikro-orm/postgresql";

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalance?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transaction",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id" },
    gameId: { type: "string", fieldName: "game_id" },
    kind: { type: "string" },
    amount: { type: "decimal", precision: 19, scale: 2, runtimeType: "string" },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: { type: "uuid", fieldName: "reference_transaction_id", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    observedBalance: {
      type: "decimal",
      precision: 19,
      scale: 2,
      runtimeType: "string",
      fieldName: "observed_balance",
      nullable: true,
    },
    referenceAttempts: { type: "integer", fieldName: "reference_attempts" },
    nextReferenceAttemptAt: { type: "Date", fieldName: "next_reference_attempt_at", nullable: true },
    createdAt: { type: "Date", fieldName: "created_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});
