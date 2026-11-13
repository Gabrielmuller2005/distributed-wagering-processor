import { deepFreeze } from "../../../shared/domain/deep-freeze";

/** Metadados de um evento: identidade, rastreio e instante. */
export interface EventContext {
  readonly eventId: string;
  /** Liga todos os eventos de um mesmo fluxo (ex.: a requisição HTTP ou a mensagem SQS). */
  readonly correlationId: string;
  /** O que causou este evento (ex.: o messageId da mensagem SQS). */
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

/** Envelope serializado: é o que vai para o payload da outbox e para a fila. */
export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  /** ISO-8601 em UTC. */
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

/**
 * Evento de integração. Cada subclasse fixa `eventType` e `version` no próprio tipo.
 *
 * `data` é um objeto JSON puro (dinheiro como MoneyProps, datas como string ISO), congelado
 * em profundidade: o payload é estável, versionável e não muda depois de criado.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt.getTime());
    this.data = deepFreeze(props.data);
  }

  /** Ordem de chaves fixa; `causationId` só aparece quando existe. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
