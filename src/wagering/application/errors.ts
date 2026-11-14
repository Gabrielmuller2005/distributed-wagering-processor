import { ApplicationError } from "../../shared/application/application-error";

/** Já existe uma wallet para o mesmo player e moeda. */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Wallet already exists for player ${playerId} in ${currency}`);
  }
}

/**
 * A linha mudou entre a leitura e a escrita (UPDATE ... WHERE version = :esperada não afetou
 * nenhuma linha). Com o lock por wallet isso não deveria acontecer; se acontecer, a transação
 * SQL é desfeita e o processamento pode ser repetido com segurança.
 */
export class ConcurrentModificationError extends ApplicationError {
  readonly code = "CONCURRENT_MODIFICATION";

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} was modified concurrently`);
  }
}
