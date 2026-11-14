import type { Clock } from "../../../shared/application/clock";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { EventPublisher, PublishBatchResult } from "../ports/event-publisher";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface OutboxPublishingOptions {
  /** Mensagens reservadas por ciclo. */
  readonly batchSize: number;
  /** Duração da reserva: precisa superar o timeout de publicação. */
  readonly leaseMs: number;
  /** Tempo máximo da chamada ao broker. */
  readonly publishTimeoutMs: number;
}

export interface PublishOutboxBatchResult {
  /** Mensagens reservadas neste ciclo. */
  readonly claimed: number;
  readonly published: number;
  /** Recusadas pelo broker ou com a chamada inteira falhando: ficam com retry agendado. */
  readonly retried: number;
  /** Já marcadas como publicadas por outro publisher (reserva vencida e reassumida). */
  readonly alreadyPublished: number;
}

const NOT_ACKNOWLEDGED = "message not acknowledged by the broker";

/**
 * Um ciclo do publisher da outbox, em três passos:
 *
 * 1. **Reserva** (transação curta): busca as mensagens pendentes e vencidas com
 *    `FOR UPDATE SKIP LOCKED` e empurra o `nextAttemptAt` para o fim da reserva. Publishers em
 *    paralelo pegam lotes disjuntos, e nenhuma transação fica aberta durante a chamada de rede.
 * 2. **Publicação** fora de transação, com timeout.
 * 3. **Resultado** (transação curta): publicadas são marcadas; as demais ganham retry com
 *    backoff exponencial.
 *
 * Se o processo morrer entre 1 e 3, a reserva vence e outra instância publica a mensagem.
 * Se morrer depois de publicar e antes de 3, a mensagem sai de novo: duplicata segura, porque o
 * eventId é a chave de deduplicação no broker e no consumidor. Nada se perde (o evento só sai
 * da outbox depois de confirmado pelo broker) e nada se duplica indefinidamente (o resultado é
 * gravado assim que o broker responde).
 */
export class PublishOutboxBatch {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: OutboxPublishingOptions,
    private readonly random: () => number = Math.random,
  ) {}

  async execute(): Promise<PublishOutboxBatchResult> {
    const batch = await this.reserve();
    if (batch.length === 0) {
      return { claimed: 0, published: 0, retried: 0, alreadyPublished: 0 };
    }

    const outcome = await this.publish(batch);
    return this.record(batch, outcome);
  }

  private reserve(): Promise<OutboxMessage[]> {
    return this.unitOfWork.run(async ({ outbox }) => {
      const now = this.clock.now();
      const due = await outbox.claimDue(now, this.options.batchSize);
      const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
      for (const message of due) {
        message.reserveUntil(leaseUntil);
        await outbox.save(message);
      }
      return due;
    });
  }

  private async publish(batch: readonly OutboxMessage[]): Promise<PublishBatchResult> {
    try {
      return await this.publisher.publish(
        batch,
        AbortSignal.timeout(this.options.publishTimeoutMs),
      );
    } catch (error: unknown) {
      const reason = describeError(error);
      return { published: [], failed: new Map(batch.map((message) => [message.id, reason])) };
    }
  }

  private record(
    batch: readonly OutboxMessage[],
    outcome: PublishBatchResult,
  ): Promise<PublishOutboxBatchResult> {
    const published = new Set(outcome.published);
    return this.unitOfWork.run(async ({ outbox }) => {
      const now = this.clock.now();
      let publishedCount = 0;
      let retried = 0;
      let alreadyPublished = 0;
      for (const message of batch) {
        const acknowledged = published.has(message.id);
        if (acknowledged) {
          message.markPublished(now);
        } else {
          const reason = outcome.failed.get(message.id) ?? NOT_ACKNOWLEDGED;
          message.scheduleRetry(now, reason, this.random);
        }
        if (!(await outbox.save(message))) alreadyPublished += 1;
        else if (acknowledged) publishedCount += 1;
        else retried += 1;
      }
      return { claimed: batch.length, published: publishedCount, retried, alreadyPublished };
    });
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
