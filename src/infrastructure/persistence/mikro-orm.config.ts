import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";

// Schema is managed only by hand-written SQL migrations (triggers, partial indexes and
// CHECK constraints cannot be generated reliably), so the ORM never alters the schema.
export function buildOrmConfig(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    // Entity schemas are registered in a later step.
    entities: [],
    discovery: { warnWhenNoEntities: false },
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
