export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada (terminal). */
  Processed = "PROCESSED",
  /** Violação de regra de negócio (terminal). */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = "FAILED",
}

/**
 * Transições válidas. Estados terminais não têm saída.
 *
 *   PENDING ──────────┬──> PROCESSED
 *      │              ├──> REJECTED
 *      │              └──> FAILED
 *      └──> PENDING_REFERENCE ──┬──> PROCESSED
 *                               ├──> REJECTED
 *                               └──> FAILED
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
