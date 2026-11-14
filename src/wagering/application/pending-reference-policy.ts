import type { BackoffPolicy } from "../../shared/domain/backoff";

/**
 * Reprocessamento de transações PENDING_REFERENCE: a primeira nova tentativa sai em ~2 s e os
 * intervalos dobram até 1 min. O limite de tentativas e o seu motivo ficam com o worker
 * (Etapa 12).
 */
export const PENDING_REFERENCE_RETRY_POLICY: BackoffPolicy = Object.freeze({
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
});
