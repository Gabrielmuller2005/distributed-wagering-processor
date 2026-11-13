import { DomainError } from "../../../shared/domain/domain-error";
import type { WagerTransactionStatus } from "./wager-transaction-status";

/**
 * Transição de estado não permitida (ex.: tentar processar uma transação já terminal).
 * É erro de programação, não caminho de negócio: o fluxo correto nunca chega aqui.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly to: WagerTransactionStatus,
  ) {
    super(`Transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

export type InvalidWagerTransactionReason =
  | "MISSING_FIELD"
  | "INVALID_AMOUNT"
  | "REFERENCE_REQUIRED"
  | "REFERENCE_NOT_ALLOWED"
  | "SELF_REFERENCE";

/** Dados de criação que violam as regras estruturais da transação. */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";

  constructor(
    readonly reason: InvalidWagerTransactionReason,
    message: string,
  ) {
    super(message);
  }
}
