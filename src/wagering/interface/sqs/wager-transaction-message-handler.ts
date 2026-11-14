import { isValidCorrelationId } from "../../../shared/interface/correlation-id";
import {
  IdempotencyConflictError,
  InboxConflictError,
  ValidationError,
  WalletNotFoundError,
} from "../../application/errors";
import { canonicalJson, sha256Hex } from "../../application/payload-hash";
import type {
  SubmitWagerTransaction,
  WagerTransactionInput,
} from "../../application/use-cases/submit-wager-transaction";
import type { WagerTransactionResult } from "../../application/views";
import { transientReasonOf } from "../../infrastructure/persistence/transient-errors";
import type {
  MessageDisposition,
  ReceivedMessage,
} from "../../infrastructure/sqs/sqs-queue-consumer";

/** Nome do consumidor na inbox: a chave de deduplicação é (consumerName, messageId). */
export const WAGER_TRANSACTIONS_CONSUMER = "wager-transactions-consumer";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/** Limite do messageId do envelope (é parte da chave da inbox). */
const MAX_MESSAGE_ID_LENGTH = 255;

/** Envelope da seção 10 do enunciado, depois de validado. */
interface WagerTransactionRequested {
  readonly messageId: string;
  readonly correlationId: string;
  readonly data: Record<string, unknown>;
  readonly payloadHash: string;
}

export interface HandledMessage {
  readonly disposition: MessageDisposition;
  /** Presente quando o caso de uso chegou a um resultado (inclusive replay). */
  readonly result?: WagerTransactionResult;
}

class InvalidEnvelopeError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Traduz uma mensagem `WagerTransactionRequested` da fila para o **mesmo caso de uso** da
 * entrada HTTP, com o registro na inbox, e classifica o desfecho:
 *
 * | Desfecho | Disposição |
 * |---|---|
 * | PROCESSED, REJECTED, PENDING_REFERENCE, FAILED (gravados no banco), inclusive replay | ack |
 * | Lock timeout, deadlock, banco fora, erro inesperado | retry (nada foi confirmado) |
 * | Envelope inválido, payload inválido, wallet inexistente, conflito de idempotência ou de inbox | DLQ |
 *
 * Rejeição de negócio (ex.: saldo insuficiente) é resultado confirmado, não erro: ack. Repetir a
 * mensagem daria o mesmo resultado, e o provedor fica sabendo pelo evento `WagerTransactionRejected`.
 */
export class WagerTransactionMessageHandler {
  constructor(private readonly submit: SubmitWagerTransaction) {}

  /** Disposição para o consumidor genérico. */
  readonly handle = async (message: ReceivedMessage): Promise<MessageDisposition> =>
    (await this.handleDetailed(message)).disposition;

  async handleDetailed(message: ReceivedMessage): Promise<HandledMessage> {
    let envelope: WagerTransactionRequested;
    try {
      envelope = parseEnvelope(message.body);
    } catch (error: unknown) {
      if (error instanceof InvalidEnvelopeError) {
        return {
          disposition: { kind: "dead-letter", reason: `INVALID_ENVELOPE: ${error.reason}` },
        };
      }
      throw error;
    }

    try {
      const data = envelope.data;
      const result = await this.submit.execute({
        idempotencyKey: data.idempotencyKey,
        transaction: transactionInput(data),
        correlationId: envelope.correlationId,
        inbox: {
          consumerName: WAGER_TRANSACTIONS_CONSUMER,
          messageId: envelope.messageId,
          payloadHash: envelope.payloadHash,
        },
      });
      return { disposition: { kind: "ack" }, result };
    } catch (error: unknown) {
      return { disposition: classify(error) };
    }
  }
}

function classify(error: unknown): MessageDisposition {
  const transient = transientReasonOf(error);
  if (transient) return { kind: "retry", reason: transient };

  if (error instanceof ValidationError) {
    return { kind: "dead-letter", reason: `VALIDATION_ERROR: ${error.reason} (${error.field})` };
  }
  if (error instanceof IdempotencyConflictError) {
    return { kind: "dead-letter", reason: `IDEMPOTENCY_CONFLICT: ${error.reason}` };
  }
  if (error instanceof WalletNotFoundError || error instanceof InboxConflictError) {
    return { kind: "dead-letter", reason: error.code };
  }
  // Desconhecido (bug, falha de infraestrutura não mapeada): tenta de novo até o limite, e a
  // mensagem acaba na DLQ se persistir. Nenhuma mensagem some por um erro não previsto.
  const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { kind: "retry", reason: `UNEXPECTED_ERROR: ${description}` };
}

function parseEnvelope(body: string): WagerTransactionRequested {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidEnvelopeError("body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new InvalidEnvelopeError("body must be a JSON object");

  const { messageId, type, occurredAt, data, correlationId } = parsed;
  if (typeof messageId !== "string" || messageId.trim() === "") {
    throw new InvalidEnvelopeError("messageId is required");
  }
  if (messageId.length > MAX_MESSAGE_ID_LENGTH) {
    throw new InvalidEnvelopeError(
      `messageId must have at most ${MAX_MESSAGE_ID_LENGTH} characters`,
    );
  }
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidEnvelopeError(`type must be ${WAGER_TRANSACTION_REQUESTED}`);
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidEnvelopeError("occurredAt must be an ISO-8601 date");
  }
  if (!isRecord(data)) throw new InvalidEnvelopeError("data must be an object");

  return {
    messageId,
    // Sem correlationId válido no envelope, o messageId correlaciona os logs e eventos.
    correlationId: isValidCorrelationId(correlationId) ? correlationId : safeCorrelation(messageId),
    data,
    // Hash do envelope inteiro, em JSON canônico: mesma mensagem com chaves em outra ordem
    // tem o mesmo hash; mesmo messageId com qualquer conteúdo diferente, não.
    payloadHash: sha256Hex(canonicalJson(parsed as Parameters<typeof canonicalJson>[0])),
  };
}

function transactionInput(data: Record<string, unknown>): WagerTransactionInput {
  return {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: data.money,
    referenceExternalTransactionId: data.referenceExternalTransactionId,
  };
}

/** O messageId vira correlationId só se for seguro para logs; senão, uma versão saneada. */
function safeCorrelation(messageId: string): string {
  if (isValidCorrelationId(messageId)) return messageId;
  return `msg-${sha256Hex(messageId).slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
