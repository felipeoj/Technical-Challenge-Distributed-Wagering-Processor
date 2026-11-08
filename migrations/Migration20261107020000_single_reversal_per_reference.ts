import { Migration } from "@mikro-orm/migrations";

export class Migration20261107020000_single_reversal_per_reference extends Migration {
  override async up(): Promise<void> {
    this.addSql("drop index wager_transaction_reversed_once");
    this.addSql(`
      create unique index wager_transaction_reversed_once
        on wager_transaction (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop index wager_transaction_reversed_once");
    this.addSql(`
      create unique index wager_transaction_reversed_once
        on wager_transaction (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
    `);
  }
}
