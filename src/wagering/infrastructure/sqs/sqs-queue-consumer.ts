import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { type BackoffPolicy, backoffDelayMs } from "../../../shared/domain/backoff";
import { runWithLogContext } from "../../../shared/observability/log-context";

/**
 * O que fazer com uma mensagem depois de processada.
 *
 * - `ack`: o resultado está confirmado no banco (inclusive rejeição de negócio). Apaga da fila.
 * - `retry`: falha transitória, nada foi confirmado. A mensagem volta à fila depois de um
 *   backoff; esgotadas as tentativas, vai para a DLQ.
 * - `dead-letter`: falha permanente (payload inválido, wallet inexistente...). Repetir não
 *   adianta: vai direto para a DLQ.
 */
export type MessageDisposition =
  | { readonly kind: "ack" }
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "dead-letter"; readonly reason: string };

export interface ReceivedMessage {
  readonly body: string;
  /** MessageId do SQS (não o messageId do envelope). */
  readonly sqsMessageId: string;
  /** Quantas vezes o SQS já entregou esta mensagem, incluindo a atual. */
  readonly receiveCount: number;
}

export type MessageHandler = (message: ReceivedMessage) => Promise<MessageDisposition>;

export interface QueueConsumerOptions {
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly batchSize: number;
  readonly waitTimeSeconds: number;
  /** Entregas de uma mensagem com falha transitória antes de mandá-la à DLQ. */
  readonly maxReceiveCount: number;
  /** Backoff entre entregas de uma mensagem com falha transitória. */
  readonly retryBackoff: BackoffPolicy;
}

export interface ConsumerLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Ganchos para métricas: o consumidor não conhece o Prometheus. */
export interface ConsumerObserver {
  retryScheduled(reason: string): void;
  deadLettered(reason: string): void;
}

export interface ConsumeBatchResult {
  readonly received: number;
  readonly acked: number;
  readonly retried: number;
  readonly deadLettered: number;
  /** Recebidas e devolvidas sem processar (encerramento ou grupo bloqueado por retry). */
  readonly released: number;
}

type Outcome = "acked" | "retried" | "deadLettered" | "released";

/** Visibilidade máxima permitida pelo SQS (12 h). */
const MAX_VISIBILITY_SECONDS = 12 * 60 * 60;

/**
 * Consumidor genérico de uma fila SQS FIFO. Não conhece o domínio: recebe um handler que devolve
 * a disposição de cada mensagem e aplica-a na fila.
 *
 * Garantias:
 * - **Ack só depois do commit.** O handler só devolve depois que a transação SQL confirmou;
 *   a exclusão da fila vem depois. Se o processo morrer entre os dois, o SQS reentrega e a
 *   inbox/idempotência transformam a reentrega em replay, sem efeito duplicado.
 * - **Ordem por grupo.** Mensagens do mesmo `MessageGroupId` são processadas em sequência;
 *   grupos diferentes, em paralelo. Se uma mensagem do grupo vai para retry, as seguintes do
 *   lote são devolvidas sem processar: o SQS FIFO só as entrega de novo depois dela.
 * - **Limite de tentativas.** Uma falha transitória na entrega `maxReceiveCount` manda a
 *   mensagem para a DLQ pela própria aplicação. A RedrivePolicy da fila, com o mesmo limite,
 *   continua como rede de segurança (ex.: mensagem que derruba o processo antes da disposição).
 * - **Encerramento.** Com `shouldContinue` falso, a mensagem em processamento termina e as
 *   recebidas e ainda não iniciadas voltam para a fila (visibilidade 0). O `signal` aborta a
 *   chamada do lado do cliente, mas a chamada continua no servidor: quem encerra deve preferir
 *   esperar o long polling acabar (ver SqsConsumerWorker).
 */
export class SqsQueueConsumer {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: MessageHandler,
    private readonly options: QueueConsumerOptions,
    private readonly logger: ConsumerLogger,
    private readonly random: () => number = Math.random,
    private readonly observer?: ConsumerObserver,
  ) {}

  /**
   * Um ciclo: recebe um lote (long polling) e processa. `shouldContinue` é consultado antes de
   * cada mensagem; quando vira false, o resto do lote é devolvido à fila.
   */
  async consumeBatch(
    signal: AbortSignal,
    shouldContinue: () => boolean = () => true,
  ): Promise<ConsumeBatchResult> {
    const messages = await this.receive(signal);
    const outcomes: Outcome[] = [];

    await Promise.all(
      groupInOrder(messages).map(async (group) => {
        for (const [index, message] of group.entries()) {
          if (!shouldContinue()) {
            outcomes.push(...(await this.releaseAll(group.slice(index))));
            return;
          }
          // Cada mensagem tem o seu contexto de log: o handler o enriquece (messageId,
          // transactionId...) e as linhas de retry e DLQ abaixo saem com os mesmos ids.
          const outcome = await runWithLogContext({ sqsMessageId: message.MessageId }, () =>
            this.process(message),
          );
          outcomes.push(outcome);
          if (outcome === "retried") {
            outcomes.push(...(await this.releaseAll(group.slice(index + 1))));
            return;
          }
        }
      }),
    );

    const count = (outcome: Outcome) => outcomes.filter((value) => value === outcome).length;
    return {
      received: messages.length,
      acked: count("acked"),
      retried: count("retried"),
      deadLettered: count("deadLettered"),
      released: count("released"),
    };
  }

  private async receive(signal: AbortSignal): Promise<Message[]> {
    if (signal.aborted) return [];
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: await this.queueUrl(this.options.queueName),
          MaxNumberOfMessages: this.options.batchSize,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        }),
        { abortSignal: signal },
      );
      return result.Messages ?? [];
    } catch (error: unknown) {
      // Encerramento: o long polling foi abortado de propósito.
      if (signal.aborted) return [];
      throw error;
    }
  }

  private async process(message: Message): Promise<Outcome> {
    const received: ReceivedMessage = {
      body: message.Body ?? "",
      sqsMessageId: message.MessageId ?? "",
      receiveCount: receiveCountOf(message),
    };

    let disposition: MessageDisposition;
    try {
      disposition = await this.handler(received);
    } catch (error: unknown) {
      // O handler classifica os erros esperados; o que escapa é tratado como transitório.
      disposition = { kind: "retry", reason: `UNEXPECTED_ERROR: ${describeError(error)}` };
    }

    try {
      return await this.apply(message, received, disposition);
    } catch (error: unknown) {
      // Falha ao aplicar a disposição (ex.: SQS fora do ar no delete). A mensagem volta quando a
      // visibilidade vencer, e o reprocessamento vira replay: seguro.
      this.logger.error(
        `failed to apply ${disposition.kind} to message ${received.sqsMessageId}: ${describeError(error)}`,
      );
      return "released";
    }
  }

  private async apply(
    message: Message,
    received: ReceivedMessage,
    disposition: MessageDisposition,
  ): Promise<Outcome> {
    switch (disposition.kind) {
      case "ack":
        await this.delete(message);
        return "acked";
      case "dead-letter":
        await this.deadLetter(message, received, disposition.reason);
        this.observer?.deadLettered(disposition.reason);
        return "deadLettered";
      case "retry": {
        if (received.receiveCount >= this.options.maxReceiveCount) {
          await this.deadLetter(
            message,
            received,
            `MAX_RECEIVE_COUNT_EXCEEDED (${received.receiveCount}): ${disposition.reason}`,
          );
          this.observer?.deadLettered("MAX_RECEIVE_COUNT_EXCEEDED");
          return "deadLettered";
        }
        const delayMs = backoffDelayMs(
          received.receiveCount,
          this.options.retryBackoff,
          this.random,
        );
        await this.changeVisibility(message, Math.ceil(delayMs / 1_000));
        this.observer?.retryScheduled(disposition.reason);
        this.logger.warn(
          `message ${received.sqsMessageId} will be retried (delivery ${received.receiveCount} of ${this.options.maxReceiveCount}): ${disposition.reason}`,
        );
        return "retried";
      }
    }
  }

  /**
   * Envia à DLQ antes de apagar da fila principal. Se o processo morrer entre os dois, a
   * mensagem é reentregue e reenviada; a DLQ descarta a repetição pelo MessageId original.
   */
  private async deadLetter(message: Message, received: ReceivedMessage, reason: string) {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.options.deadLetterQueueName),
        MessageBody: received.body,
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: received.sqsMessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: "String", StringValue: reason.slice(0, 1_000) },
          originalMessageId: { DataType: "String", StringValue: received.sqsMessageId },
          receiveCount: { DataType: "Number", StringValue: String(received.receiveCount) },
        },
      }),
    );
    await this.delete(message);
    this.logger.warn(`message ${received.sqsMessageId} sent to the dead-letter queue: ${reason}`);
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(this.options.queueName),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(this.options.queueName),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.min(seconds, MAX_VISIBILITY_SECONDS),
      }),
    );
  }

  /** Devolve mensagens à fila na hora (visibilidade 0), sem contar como falha. */
  private async releaseAll(messages: readonly Message[]): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    for (const message of messages) {
      try {
        await this.changeVisibility(message, 0);
      } catch (error: unknown) {
        this.logger.error(
          `failed to release message ${message.MessageId}: ${describeError(error)}`,
        );
      }
      outcomes.push("released");
    }
    return outcomes;
  }

  private queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: name })).then((output) => {
        if (!output.QueueUrl) throw new Error(`queue ${name} has no url`);
        return output.QueueUrl;
      });
      // Falhou: esquece, para a próxima chamada tentar de novo.
      url.catch(() => this.urls.delete(name));
      this.urls.set(name, url);
    }
    return url;
  }
}

/** Agrupa por MessageGroupId mantendo a ordem de chegada dentro de cada grupo. */
function groupInOrder(messages: readonly Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = message.Attributes?.MessageGroupId ?? "";
    const group = groups.get(key) ?? [];
    group.push(message);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function receiveCountOf(message: Message): number {
  const raw = message.Attributes?.ApproximateReceiveCount ?? "1";
  return /^[1-9]\d*$/.test(raw) ? Number.parseInt(raw, 10) : 1;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
