/** Aceito só o que é seguro de repassar para logs e eventos; o resto é descartado e gerado de novo. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Regra comum às bordas (header HTTP e envelope SQS). */
export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === "string" && VALID_CORRELATION_ID.test(value);
}
