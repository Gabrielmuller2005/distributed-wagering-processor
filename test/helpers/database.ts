import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  createOrm,
  type DatabaseConfig,
} from "../../src/wagering/infrastructure/persistence/mikro-orm";
import { MikroOrmUnitOfWork } from "../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";

/**
 * Banco PostgreSQL real, separado do de desenvolvimento (`wagering_test`).
 * Os testes de integração nunca usam mock de banco: as constraints e triggers testados são os
 * do schema de verdade, aplicado pelas mesmas migrations da aplicação.
 */
export function testDatabaseConfig(): DatabaseConfig {
  const base = process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering";
  const url = process.env.TEST_DATABASE_URL ?? base.replace(/\/[^/?]+(\?|$)/, "/wagering_test$1");
  return { url, poolMax: 20, lockTimeoutMs: 2_000 };
}

export interface TestDatabase {
  readonly orm: MikroORM;
  readonly unitOfWork: MikroOrmUnitOfWork;
  /** Executa SQL cru fora do domínio, para tentar violar as regras de propósito. */
  sql<T = unknown[]>(query: string, params?: unknown[]): Promise<T>;
  /**
   * Executa SQL com os triggers desligados só nesta transação (`session_replication_role`).
   * Serve para provar que um CHECK ou índice segura a regra sozinho, sem depender do trigger
   * que normalmente dispararia antes.
   */
  sqlWithoutTriggers(query: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

/** Cria o banco de teste se preciso e recria o schema do zero (down de tudo + up). */
export async function openTestDatabase(
  config: DatabaseConfig = testDatabaseConfig(),
): Promise<TestDatabase> {
  const orm = await createOrm(config);
  await orm.schema.ensureDatabase();
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();

  return {
    orm,
    unitOfWork: new MikroOrmUnitOfWork(orm, config.lockTimeoutMs),
    sql: <T>(query: string, params: unknown[] = []) => orm.em.fork().execute(query, params) as T,
    sqlWithoutTriggers: (query: string, params: unknown[] = []) =>
      orm.em.fork().transactional(async (em) => {
        await em.execute("set local session_replication_role = replica");
        return em.execute(query, params);
      }),
    close: () => orm.close(true),
  };
}

/** Espera que a operação falhe no banco com o SQLSTATE indicado (e, opcionalmente, a mensagem). */
export async function expectDatabaseError(
  operation: Promise<unknown>,
  sqlState: string,
  messagePart?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe(sqlState);
  if (messagePart) expect((caught as Error).message).toContain(messagePart);
}

/** SQLSTATE usados nos testes (PostgreSQL, apêndice A). */
export const SqlState = {
  UniqueViolation: "23505",
  CheckViolation: "23514",
  RestrictViolation: "23001",
  ForeignKeyViolation: "23503",
  LockNotAvailable: "55P03",
} as const;
