import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from "./schemas";

// Schema is managed only by hand-written SQL migrations (triggers, partial indexes and
// CHECK constraints cannot be generated reliably), so the ORM never alters the schema.
export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      LedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      path: "migrations",
      glob: "!(*.d).{js,ts}",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
