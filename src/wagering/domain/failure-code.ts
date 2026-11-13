/**
 * Códigos de falha estáveis e legíveis por máquina, persistidos junto com a transação.
 *
 * Cada código tem uma categoria que diz ao provedor o que fazer:
 * - FIX_PAYLOAD: a requisição é inconsistente. O provedor deve corrigir os dados e enviar
 *   uma nova transação (novo externalTransactionId). Reenviar a mesma não muda o resultado.
 * - FINAL: a requisição é válida, mas foi recusada pela regra de negócio. Não adianta reenviar.
 * - RETRYABLE: nada foi aplicado por falha de infraestrutura. O provedor pode tentar de novo
 *   com uma nova transação.
 *
 * Reenviar a mesma idempotency key sempre devolve o resultado já gravado (replay), seja qual
 * for a categoria. Falhas transitórias que não chegam a ser gravadas (ex.: lock timeout) não
 * usam estes códigos: viram HTTP 503 ou retry no SQS.
 */
export enum FailureCode {
  /** BET maior que o saldo disponível. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** Reversão (ROLLBACK de WIN ou de REFUND) que deixaria o saldo negativo. */
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  /** A referência não apareceu dentro do limite de reprocessamento. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** A referência é de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** Tipo de referência não permitido (ex.: REFUND de um WIN). */
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  /** A referência existe, mas terminou REJECTED ou FAILED: não há o que reverter. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** A referência já foi revertida por um REFUND ou ROLLBACK. */
  AlreadyReversed = "ALREADY_REVERSED",
  /** Valor da reversão diferente do valor da referência (reversão parcial fora de escopo). */
  AmountMismatch = "AMOUNT_MISMATCH",
  /** Moeda da transação diferente da moeda da wallet. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** A wallet não pertence ao player informado. */
  PlayerMismatch = "PLAYER_MISMATCH",
  /** Erro permanente de infraestrutura: a transação terminou FAILED, sem efeito no saldo. */
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}

export enum FailureCategory {
  FixPayload = "FIX_PAYLOAD",
  Final = "FINAL",
  Retryable = "RETRYABLE",
}

const CATEGORY_BY_CODE: Readonly<Record<FailureCode, FailureCategory>> = {
  [FailureCode.InsufficientFunds]: FailureCategory.Final,
  [FailureCode.ReversalWouldOverdraw]: FailureCategory.Final,
  [FailureCode.ReferenceNotFound]: FailureCategory.Final,
  [FailureCode.ReferenceMismatch]: FailureCategory.FixPayload,
  [FailureCode.InvalidReferenceKind]: FailureCategory.FixPayload,
  [FailureCode.ReferenceNotProcessed]: FailureCategory.Final,
  [FailureCode.AlreadyReversed]: FailureCategory.Final,
  [FailureCode.AmountMismatch]: FailureCategory.FixPayload,
  [FailureCode.CurrencyMismatch]: FailureCategory.FixPayload,
  [FailureCode.PlayerMismatch]: FailureCategory.FixPayload,
  [FailureCode.InfrastructureFailure]: FailureCategory.Retryable,
};

export function failureCategoryOf(code: FailureCode): FailureCategory {
  return CATEGORY_BY_CODE[code];
}
