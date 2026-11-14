import { ConnectionException } from "@mikro-orm/core";
import { ConcurrentModificationError } from "../../application/errors";

/**
 * Por que uma falha é transitória: a operação foi desfeita por inteiro e repetir é seguro.
 * O HTTP responde 503 com Retry-After; o consumidor SQS deixa a mensagem voltar à fila.
 */
export type TransientReason =
  | "LOCK_TIMEOUT"
  | "DEADLOCK"
  | "SERIALIZATION_FAILURE"
  | "DATABASE_UNAVAILABLE"
  | "CONCURRENT_MODIFICATION";

/** SQLSTATE do PostgreSQL (apêndice A da documentação) que indicam falha transitória. */
const TRANSIENT_SQLSTATE: Readonly<Record<string, TransientReason>> = {
  "55P03": "LOCK_TIMEOUT", // lock_not_available (lock_timeout estourou)
  "40P01": "DEADLOCK", // deadlock_detected
  "40001": "SERIALIZATION_FAILURE", // serialization_failure
  "57P01": "DATABASE_UNAVAILABLE", // admin_shutdown
  "57P02": "DATABASE_UNAVAILABLE", // crash_shutdown
  "57P03": "DATABASE_UNAVAILABLE", // cannot_connect_now
  "53300": "DATABASE_UNAVAILABLE", // too_many_connections
};

/** Erros de rede do Node que indicam banco inalcançável. */
const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);

export function transientReasonOf(error: unknown): TransientReason | undefined {
  if (error instanceof ConcurrentModificationError) return "CONCURRENT_MODIFICATION";
  if (error instanceof ConnectionException) return "DATABASE_UNAVAILABLE";
  if (!(error instanceof Error)) return undefined;

  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  if (code in TRANSIENT_SQLSTATE) return TRANSIENT_SQLSTATE[code];
  // Classe 08 = connection exception.
  if (code.startsWith("08") || NETWORK_ERROR_CODES.has(code)) return "DATABASE_UNAVAILABLE";
  return undefined;
}
