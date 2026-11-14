import { type BackoffPolicy, backoffDelayMs } from "../../../shared/domain/backoff";
import { deepFreeze } from "../../../shared/domain/deep-freeze";
import type { IntegrationEvent } from "../events/integration-event";
import { InvalidMessageStateError } from "./messaging.errors";

/**
 * Política de retry da publicação: 1 s, 2 s, 4 s... até no máximo 5 min entre tentativas.
 * Não há limite de tentativas: a entrega é at-least-once, e um evento confirmado no banco nunca
 * é descartado. Se o destino ficar fora do ar por muito tempo, o atraso fica preso no teto e o
 * problema aparece na métrica de outbox lag, em vez de o evento sumir.
 */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
});

/** Tamanho máximo guardado do último erro, para não inflar a linha da outbox. */
const MAX_ERROR_LENGTH = 1_000;

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly publishedAt?: Date | undefined;
  readonly lastError?: string | undefined;
}

/**
 * Evento à espera de publicação, gravado na mesma transação SQL da mudança financeira.
 * O publisher só lê o que já foi confirmado, então nenhum evento sai antes do commit.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /**
   * Enfileira um evento. O id da mensagem é o eventId, que também vira o
   * MessageDeduplicationId no SQS: publicar duas vezes o mesmo evento é seguro.
   * Fica disponível na hora (nextAttemptAt = occurredAt).
   */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = deepFreeze(
      JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>,
    );
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  /**
   * Reserva a mensagem para um publisher até `until`: até lá, ela não aparece na busca dos
   * outros. Se o publisher morrer no meio da publicação, a reserva vence e outra instância
   * assume a mensagem. Não conta como tentativa: nada falhou ainda.
   */
  reserveUntil(until: Date): void {
    this.assertPending("reserve");
    this._nextAttemptAt = until;
  }

  markPublished(at: Date): void {
    this.assertPending("mark as published");
    this._publishedAt = at;
  }

  /** Registra uma falha de publicação: incrementa attempts e agenda a próxima tentativa. */
  scheduleRetry(now: Date, error?: string, random: () => number = Math.random): void {
    this.assertPending("schedule a retry for");
    this._attempts += 1;
    const delay = backoffDelayMs(this._attempts, OUTBOX_RETRY_POLICY, random);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error?.slice(0, MAX_ERROR_LENGTH);
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(
        `cannot ${action} outbox message ${this.id}: already published`,
      );
    }
  }
}
