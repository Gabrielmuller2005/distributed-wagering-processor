import type { MikroORM } from "@mikro-orm/postgresql";
import type { TransactionalRepositories } from "../../application/ports/repositories";
import type { UnitOfWork } from "../../application/ports/unit-of-work";
import { createRepositories } from "./repositories";

/**
 * Uma chamada de `run` = uma transação SQL (READ COMMITTED, padrão do PostgreSQL).
 *
 * `set_config('lock_timeout', ..., true)` equivale a `SET LOCAL`: vale só para esta transação.
 * Esperar mais que isso por um lock (ex.: a wallet travada por outra instância) lança erro
 * 55P03 (lock_not_available), que as camadas externas tratam como transitório.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute("select set_config('lock_timeout', ?, true)", [`${this.lockTimeoutMs}ms`]);
      return work(createRepositories(em));
    });
  }
}
