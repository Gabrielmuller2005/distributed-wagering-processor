import type { BackoffPolicy } from "../../shared/domain/backoff";

/**
 * Reprocessamento de transações PENDING_REFERENCE: a primeira nova tentativa sai em ~2 s e os
 * intervalos dobram até 1 min. Não há limite de tentativas: quem encerra a espera é o prazo
 * (`PENDING_REFERENCE_TTL_MS`, contado da aceitação), aplicado pelo RetryPendingReferences.
 */
export const PENDING_REFERENCE_RETRY_POLICY: BackoffPolicy = Object.freeze({
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
});
