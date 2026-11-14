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
 * Publica os eventos da outbox numa fila SQS FIFO, um SendMessageBatch por lote.
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

  async publish(
    messages: readonly OutboxMessage[],
    signal: AbortSignal,
  ): Promise<PublishBatchResult> {
    if (messages.length === 0) return { published: [], failed: new Map() };
    if (messages.length > SQS_MAX_BATCH_SIZE) {
      throw new RangeError(`at most ${SQS_MAX_BATCH_SIZE} messages per batch`);
    }

    const result = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.resolveQueueUrl(signal),
        Entries: messages.map(toEntry),
      }),
      { abortSignal: signal },
    );

    const published = (result.Successful ?? []).flatMap((entry) => (entry.Id ? [entry.Id] : []));
    const failed = new Map<string, string>();
    for (const entry of result.Failed ?? []) {
      if (entry.Id) failed.set(entry.Id, `${entry.Code ?? "Unknown"}: ${entry.Message ?? ""}`);
    }
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
