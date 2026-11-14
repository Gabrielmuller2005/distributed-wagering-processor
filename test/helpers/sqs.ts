import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/wagering/infrastructure/sqs/sqs-client";
import { testAppConfig } from "./http-app";

export interface TemporaryQueue {
  readonly name: string;
  readonly url: string;
  readonly sqs: SQSClient;
  /**
   * Recebe (e apaga) mensagens até chegar a `expected` ou estourar o prazo. Com `settleMs`,
   * continua escutando mais um pouco depois disso, para flagrar mensagens a mais (duplicatas).
   */
  receive(
    expected: number,
    options?: { timeoutMs?: number; settleMs?: number },
  ): Promise<Message[]>;
  /** Envia uma mensagem FIFO; o id de deduplicação padrão é único (envio novo, não repetição). */
  send(body: string, options: { groupId: string; deduplicationId?: string }): Promise<void>;
  destroy(): Promise<void>;
}

/** Fila FIFO exclusiva do teste no MiniStack: nada de outro teste aparece nela. */
export async function createTemporaryQueue(prefix: string): Promise<TemporaryQueue> {
  const sqs = createSqsClient(testAppConfig().aws);
  const name = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.fifo`;
  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true" } }),
  );
  const url = created.QueueUrl;
  if (!url) throw new Error(`queue ${name} has no url`);

  async function receiveOnce(waitSeconds: number): Promise<Message[]> {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
      }),
    );
    const messages = result.Messages ?? [];
    if (messages.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: url,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
          })),
        }),
      );
    }
    return messages;
  }

  return {
    name,
    url,
    sqs,
    async receive(expected, { timeoutMs = 10_000, settleMs = 0 } = {}) {
      const received: Message[] = [];
      const deadline = Date.now() + timeoutMs;
      while (received.length < expected && Date.now() < deadline) {
        received.push(...(await receiveOnce(1)));
      }
      const settleUntil = Date.now() + settleMs;
      while (Date.now() < settleUntil) {
        received.push(...(await receiveOnce(1)));
      }
      return received;
    },
    async send(body, { groupId, deduplicationId }) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: body,
          MessageGroupId: groupId,
          MessageDeduplicationId:
            deduplicationId ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        }),
      );
    },
    async destroy() {
      try {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      } finally {
        sqs.destroy();
      }
    },
  };
}

/** Espera a condição virar verdadeira, consultando a cada `intervalMs`, até o prazo. */
export async function waitFor(
  condition: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(intervalMs);
  }
}
