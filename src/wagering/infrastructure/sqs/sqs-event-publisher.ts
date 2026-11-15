import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishBatchResult } from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

/** Limite do SendMessageBatch da AWS. */
export const SQS_MAX_BATCH_SIZE = 10;

/**
 * Publica os eventos da outbox numa fila SQS FIFO, em SendMessageBatch de até 10.
 *
 * - `MessageDeduplicationId = eventId`: o SQS descarta a repetição dentro da janela de
 *   deduplicação (5 min). Fora dela, quem garante é o consumidor, deduplicando pelo eventId.
 * - `MessageGroupId = aggregateId` (a walletId): eventos de uma mesma wallet saem em ordem no
 *   grupo, e wallets diferentes são consumidas em paralelo. A ordem do broker é otimização; o
 *   consumidor ordena de fato pelo `walletVersion` do evento.
 * - `eventType` e `version` vão também como atributos, para filtrar sem abrir o corpo.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  /**
   * Publica um lote de qualquer tamanho em SendMessageBatch de até 10 (limite da AWS).
   *
   * Os eventos são distribuídos em faixas **por wallet**: todos os eventos de uma mesma wallet
   * caem na mesma faixa e saem em sequência, na ordem do lote; faixas diferentes vão em
   * paralelo. Assim o paralelismo não inverte a ordem dentro de um MessageGroupId.
   *
   * A falha de uma chamada afeta só as mensagens dela (e as seguintes da mesma faixa, que nem
   * chegam a ser enviadas, para não passarem à frente): o resto do lote é aproveitado.
   */
  async publish(
    messages: readonly OutboxMessage[],
    signal: AbortSignal,
  ): Promise<PublishBatchResult> {
    if (messages.length === 0) return { published: [], failed: new Map() };
    const queueUrl = await this.resolveQueueUrl(signal);

    const published: string[] = [];
    const failed = new Map<string, string>();
    await Promise.all(
      lanesByAggregate(messages).map(async (lane) => {
        for (let start = 0; start < lane.length; start += SQS_MAX_BATCH_SIZE) {
          const chunk = lane.slice(start, start + SQS_MAX_BATCH_SIZE);
          try {
            const result = await this.sqs.send(
              new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: chunk.map(toEntry) }),
              { abortSignal: signal },
            );
            for (const entry of result.Successful ?? []) if (entry.Id) published.push(entry.Id);
            for (const entry of result.Failed ?? []) {
              if (entry.Id) {
                failed.set(entry.Id, `${entry.Code ?? "Unknown"}: ${entry.Message ?? ""}`);
              }
            }
          } catch (error: unknown) {
            const reason =
              error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            for (const message of lane.slice(start)) failed.set(message.id, reason);
            return;
          }
        }
      }),
    );
    return { published, failed };
  }

  /** A URL é resolvida uma vez e reaproveitada; se a resolução falhar, a próxima chamada tenta de novo. */
  private resolveQueueUrl(signal: AbortSignal): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal: signal })
      .then((output) => {
        if (!output.QueueUrl) throw new Error(`queue ${this.queueName} has no url`);
        return output.QueueUrl;
      });
    const pending = this.queueUrl;
    pending.catch(() => {
      if (this.queueUrl === pending) this.queueUrl = undefined;
    });
    return pending;
  }
}

function toEntry(message: OutboxMessage): SendMessageBatchRequestEntry {
  return {
    // Id do lote: aceita letras, dígitos, - e _ (até 80); o UUID do evento serve.
    Id: message.id,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.aggregateId,
    MessageDeduplicationId: message.id,
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: message.eventType },
      eventVersion: { DataType: "Number", StringValue: String(message.payload.version ?? 1) },
    },
  };
}

/**
 * Faixas de envio: no máximo uma por pedaço de 10 do lote, com cada wallet inteira numa faixa só.
 * Cada wallet vai para a faixa menos cheia no momento, na ordem em que aparece no lote.
 */
function lanesByAggregate(messages: readonly OutboxMessage[]): OutboxMessage[][] {
  const byAggregate = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    const group = byAggregate.get(message.aggregateId) ?? [];
    group.push(message);
    byAggregate.set(message.aggregateId, group);
  }
  const laneCount = Math.min(byAggregate.size, Math.ceil(messages.length / SQS_MAX_BATCH_SIZE));
  const lanes: OutboxMessage[][] = Array.from({ length: laneCount }, () => []);
  for (const group of byAggregate.values()) {
    const lightest = lanes.reduce((best, lane) => (lane.length < best.length ? lane : best));
    lightest.push(...group);
  }
  return lanes;
}
