import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../../src/infrastructure/persistence/mikro-orm.config";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5433/wagering_test";

export async function connectTestDatabase(): Promise<MikroORM> {
  const orm = await MikroORM.init(buildOrmConfig(TEST_DATABASE_URL));
  await orm.migrator.up();
  return orm;
}

function urlFor(database: string): string {
  return TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${database}`);
}

export async function connectIsolatedDatabase(name: string): Promise<{ orm: MikroORM; url: string }> {
  if (!/^[a-z_]+$/.test(name)) {
    throw new Error("invalid database name");
  }
  const admin = await MikroORM.init(buildOrmConfig(urlFor("wagering")));
  const connection = admin.em.getConnection();
  await connection.execute(`drop database if exists ${name} with (force)`);
  await connection.execute(`create database ${name}`);
  await admin.close();

  const url = urlFor(name);
  const orm = await MikroORM.init(buildOrmConfig(url));
  await orm.migrator.up();
  return { orm, url };
}

export async function run<T = Record<string, unknown>>(
  orm: MikroORM,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await orm.em.getConnection().execute(sql, params)) as T[];
}
