// Usage: bun scripts/migrate.ts up|down
import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../src/config/env";
import { buildOrmConfig } from "../src/infrastructure/persistence/mikro-orm.config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("Usage: bun scripts/migrate.ts up|down");
  process.exit(1);
}

const env = loadEnv();
const orm = await MikroORM.init(buildOrmConfig(env.DATABASE_URL));
try {
  // "down" reverts only the latest migration, like a single rollback step.
  const done = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`${direction}: ${done.map((m) => m.name).join(", ") || "nothing to do"}`);
} finally {
  await orm.close();
}
