import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

/** Resultado por mensagem de um lote: o broker pode aceitar parte do lote e recusar o resto. */
export interface PublishBatchResult {
  /** Ids das mensagens que o broker confirmou. */
  readonly published: readonly string[];
  /** Mensagens recusadas pelo broker, com o motivo. */
  readonly failed: ReadonlyMap<string, string>;
}

/**
 * Destino dos eventos de integração (no projeto, uma fila SQS FIFO).
 *
 * Contrato: publicar a mesma mensagem duas vezes é seguro. A implementação usa o id da
 * mensagem (o eventId) como chave de deduplicação do broker, e o consumidor deduplica pelo
 * eventId. Uma falha da chamada inteira (rede, fila inexistente, timeout) é lançada como
 * exceção; quem chama trata todas as mensagens do lote como não publicadas.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishBatchResult>;
}
