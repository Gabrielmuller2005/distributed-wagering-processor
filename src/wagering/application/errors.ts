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

export type ValidationErrorCode =
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "INVALID_KIND"
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "REFERENCE_REQUIRED"
  | "REFERENCE_NOT_ALLOWED"
  | "SELF_REFERENCE";

/** Entrada inválida: nada foi persistido. O provedor precisa corrigir a requisição. */
export class ValidationError extends ApplicationError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    readonly reason: ValidationErrorCode,
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

export type IdempotencyConflictReason =
  /** Mesma idempotency key, conteúdo diferente: não é replay. */
  | "PAYLOAD_MISMATCH"
  /** O mesmo (provider, externalTransactionId) já foi usado com outra idempotency key. */
  | "EXTERNAL_ID_REUSED";

export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(
    readonly reason: IdempotencyConflictReason,
    readonly existingTransactionId: string,
  ) {
    super(
      reason === "PAYLOAD_MISMATCH"
        ? "Idempotency key already used with a different payload"
        : "externalTransactionId already used by this provider with another idempotency key",
    );
  }
}

/** A wallet informada não existe. Nada é persistido: não há wallet para vincular a transação. */
export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

/** Mesmo messageId já processado com outro conteúdo: produtor reutilizando ids. */
export class InboxConflictError extends ApplicationError {
  readonly code = "INBOX_MESSAGE_CONFLICT";

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Message ${messageId} was already processed by ${consumerName} with another payload`);
  }
}

/** A transação consultada não existe. */
export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";

  constructor(readonly lookup: string) {
    super(`Transaction ${lookup} not found`);
  }
}
