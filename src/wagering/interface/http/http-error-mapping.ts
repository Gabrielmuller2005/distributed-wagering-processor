import { HttpException } from "@nestjs/common";
import {
  IdempotencyConflictError,
  InboxConflictError,
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../application/errors";
import { transientReasonOf } from "../../infrastructure/persistence/transient-errors";

/** Corpo padrão de erro em todos os endpoints. */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers?: Readonly<Record<string, string>>;
  /** Erro inesperado: deve ser logado com stack, e a mensagem interna não vai para o cliente. */
  readonly unexpected?: boolean;
}

/** Segundos sugeridos ao cliente antes de tentar de novo uma falha transitória. */
export const RETRY_AFTER_SECONDS = 1;

/**
 * Tradução de erros em resposta HTTP, igual para todos os endpoints. O provedor decide pelo
 * **status e pelo `code`**, nunca pelo texto:
 *
 * | Situação                                   | Status | code                              |
 * |--------------------------------------------|--------|-----------------------------------|
 * | Payload inválido                           | 400    | VALIDATION_ERROR / IDEMPOTENCY_KEY_REQUIRED |
 * | Recurso inexistente                        | 404    | WALLET_NOT_FOUND / TRANSACTION_NOT_FOUND / NOT_FOUND |
 * | Conflito de idempotência / wallet duplicada | 409    | IDEMPOTENCY_CONFLICT / WALLET_ALREADY_EXISTS |
 * | Falha transitória de infraestrutura         | 503    | TEMPORARILY_UNAVAILABLE (+ Retry-After) |
 * | Erro inesperado                            | 500    | INTERNAL_ERROR                    |
 *
 * Os resultados de negócio (200 PROCESSED, 202 PENDING_REFERENCE, 422 REJECTED) não são erros:
 * são respostas normais do endpoint de submissão.
 */
export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof ValidationError) {
    const code =
      error.reason === "IDEMPOTENCY_KEY_REQUIRED" ? "IDEMPOTENCY_KEY_REQUIRED" : "VALIDATION_ERROR";
    return {
      status: 400,
      body: { code, message: error.message, details: { reason: error.reason, field: error.field } },
    };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 404, body: { code: error.code, message: error.message } };
  }
  if (error instanceof TransactionNotFoundError) {
    return { status: 404, body: { code: error.code, message: error.message } };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: {
        code: error.code,
        message: error.message,
        details: { reason: error.reason, existingTransactionId: error.existingTransactionId },
      },
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return {
      status: 409,
      body: {
        code: error.code,
        message: error.message,
        details: { playerId: error.playerId, currency: error.currency },
      },
    };
  }
  if (error instanceof InboxConflictError) {
    return { status: 409, body: { code: error.code, message: error.message } };
  }

  const transient = transientReasonOf(error);
  if (transient) {
    return {
      status: 503,
      body: {
        code: "TEMPORARILY_UNAVAILABLE",
        message: "The operation was not applied; it is safe to retry",
        details: { reason: transient },
      },
      headers: { "Retry-After": String(RETRY_AFTER_SECONDS) },
    };
  }

  if (error instanceof HttpException) return fromFrameworkException(error);

  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: "Unexpected error" },
    unexpected: true,
  };
}

/** Exceções do próprio Nest/Express: rota inexistente, JSON malformado, corpo grande demais. */
function fromFrameworkException(error: HttpException): HttpErrorResponse {
  const status = error.getStatus();
  switch (status) {
    case 400:
      return {
        status,
        body: {
          code: "VALIDATION_ERROR",
          message: "Malformed request body",
          details: { reason: "INVALID_JSON" },
        },
      };
    case 404:
      return { status, body: { code: "NOT_FOUND", message: "Route not found" } };
    case 413:
      return { status, body: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } };
    default:
      return {
        status,
        body: { code: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR", message: error.message },
        unexpected: status >= 500,
      };
  }
}
