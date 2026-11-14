import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../../src/wagering/infrastructure/persistence/migrations";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";

const APP_TABLES = [
  "inbox_messages",
  "outbox_messages",
  "wager_transactions",
  "wallet_ledger_entries",
  "wallets",
];

let db: TestDatabase;

async function publicTables(): Promise<string[]> {
  const rows = await db.sql<{ table_name: string }[]>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
     order by table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function publicFunctions(): Promise<number> {
  const [row] = await db.sql<{ total: number }[]>(
    `select count(*)::int as total from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
  );
  return row?.total ?? 0;
}

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe("migrations", () => {
  test("todas as migrations estão aplicadas e criam as tabelas da aplicação", async () => {
    expect((await db.orm.migrator.getPending()).length).toBe(0);
    expect((await db.orm.migrator.getExecuted()).map((m) => m.name)).toEqual(
      MIGRATIONS.map((m) => m.name),
    );
    expect(await publicTables()).toEqual(APP_TABLES);
  });

  test("são reversíveis: down de todas remove tabelas, funções e triggers; up recria", async () => {
    await db.orm.migrator.down({ to: 0 });

    expect(await publicTables()).toEqual([]);
    expect(await publicFunctions()).toBe(0);

    await db.orm.migrator.up();

    expect(await publicTables()).toEqual(APP_TABLES);
    expect(await publicFunctions()).toBeGreaterThan(0);
  });

  test("cada migration desce e sobe individualmente", async () => {
    for (let i = 0; i < MIGRATIONS.length; i++) await db.orm.migrator.down();
    expect(await publicTables()).toEqual([]);

    for (let i = 0; i < MIGRATIONS.length; i++)
      await db.orm.migrator.up({ to: MIGRATIONS[i]?.name });
    expect(await publicTables()).toEqual(APP_TABLES);
  });

  test("rodar up de novo não faz nada", async () => {
    expect(await db.orm.migrator.up()).toEqual([]);
  });
});
