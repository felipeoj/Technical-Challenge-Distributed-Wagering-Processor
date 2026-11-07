import { Migration } from "@mikro-orm/migrations";

// Baseline: proves the migration runner works end to end (up and down).
// The real schema arrives in the next migration.
export class Migration20261107000000_baseline extends Migration {
  override async up(): Promise<void> {
    this.addSql("select 1");
  }

  override async down(): Promise<void> {
    this.addSql("select 1");
  }
}
