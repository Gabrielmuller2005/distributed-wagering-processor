import type { TransactionalRepositories } from "./repositories";

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

/**
 * Limite transacional. `run` abre **uma** transação SQL, entrega repositórios ligados a ela e
 * confirma no fim; qualquer exceção desfaz tudo. Tudo o que um processamento grava (wallet,
 * ledger, transação, inbox e outbox) passa por um único `run`, e por isso é atômico.
 *
 * Cada transação tem `lock_timeout`: esperar demais por um lock vira erro transitório,
 * em vez de travar a requisição indefinidamente.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}
