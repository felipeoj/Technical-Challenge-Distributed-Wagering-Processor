import { EntitySchema } from "@mikro-orm/postgresql";

export class LedgerEntryRecord {
  seq?: string;
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entry",
  properties: {
    seq: { type: "bigint", runtimeType: "string", nullable: true },
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string" },
    amount: { type: "decimal", precision: 19, scale: 2, runtimeType: "string" },
    currency: { type: "string", length: 3 },
    balanceBefore: {
      type: "decimal",
      precision: 19,
      scale: 2,
      runtimeType: "string",
      fieldName: "balance_before",
    },
    balanceAfter: {
      type: "decimal",
      precision: 19,
      scale: 2,
      runtimeType: "string",
      fieldName: "balance_after",
    },
    createdAt: { type: "Date", fieldName: "created_at" },
  },
});
