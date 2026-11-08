import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../..", import.meta.url).pathname;

function filesUnder(directory: string, extensions: string[]): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (entry === "node_modules") return [];
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

const production = filesUnder(join(root, "src"), [".ts"]).filter((file) => !file.endsWith(".test.ts"));
const schemaFiles = [
  ...filesUnder(join(root, "migrations"), [".ts"]),
  ...filesUnder(join(root, "scripts"), [".ts", ".sql"]),
];

const relativeName = (file: string) => relative(root, file);

const ALLOWED_NON_MONEY_CONVERSIONS = [
  "src/application/queries/list-ledger.ts",
  "src/infrastructure/sqs/wager-consumer.ts",
];

describe("money is never a JavaScript number", () => {
  test("production code has no number conversion except two known non-money cases", () => {
    const offenders = production
      .filter((file) => /parseFloat|parseInt|toNumber\(|Number\(/.test(readFileSync(file, "utf8")))
      .map(relativeName);
    for (const offender of offenders) {
      expect(ALLOWED_NON_MONEY_CONVERSIONS).toContain(offender);
    }
  });

  test("the allowed conversions are a page size and a receive count, one each", () => {
    const expected: Record<string, string> = {
      "src/application/queries/list-ledger.ts": "const parsed = Number(limit)",
      "src/infrastructure/sqs/wager-consumer.ts": "Number(message.Attributes?.ApproximateReceiveCount",
    };
    for (const [name, snippet] of Object.entries(expected)) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf8");
      expect(content.match(/Number\(/g)).toHaveLength(1);
      expect(content).toContain(snippet);
    }
  });

  test("the Money class and the money mappers hold no number type", () => {
    const moneyFiles = production.filter((file) => /domain\/money\.ts$|persistence\/mappers\//.test(file));
    expect(moneyFiles.length).toBeGreaterThan(0);
    for (const file of moneyFiles) {
      expect(readFileSync(file, "utf8")).not.toMatch(/:\s*number|as number|<number>/);
    }
  });

  test("the schema has no floating point column or cast", () => {
    for (const file of schemaFiles) {
      const withoutComments = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/--.*$/gm, "");
      expect(withoutComments).not.toMatch(/\bfloat\d?\b|double precision|::real|\sreal[\s,)]/i);
    }
  });

  test("every money column is numeric(19,2)", () => {
    const migration = readFileSync(join(root, "migrations/Migration20261107010000_initial_schema.ts"), "utf8");
    const moneyColumns = migration.match(/^\s*(balance|amount|balance_before|balance_after|observed_balance)\s+\S+/gm) ?? [];
    expect(moneyColumns.length).toBeGreaterThanOrEqual(5);
    for (const column of moneyColumns) {
      expect(column).toMatch(/numeric\(19,2\)/);
    }
  });
});
