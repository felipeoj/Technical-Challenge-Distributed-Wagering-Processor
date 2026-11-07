import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5433/wagering_test";

export async function connectTestDatabase(): Promise<MikroORM> {
  const orm = await MikroORM.init(buildOrmConfig(TEST_DATABASE_URL));
  await orm.migrator.up();
  return orm;
}

export async function run<T = Record<string, unknown>>(
  orm: MikroORM,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await orm.em.getConnection().execute(sql, params)) as T[];
}
