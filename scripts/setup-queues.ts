// Cria no emulador local (MiniStack/LocalStack) a fila FIFO de entrada, a DLQ dela e a fila FIFO
// de eventos de integração publicados pela outbox.
// CreateQueue é idempotente quando os atributos são idênticos, então o script pode rodar mais de uma vez.
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const region = process.env.AWS_REGION ?? "us-east-1";
const mainName = process.env.SQS_QUEUE_NAME ?? "wager-transactions.fifo";
const dlqName = process.env.SQS_DLQ_NAME ?? "wager-transactions-dlq.fifo";
const eventsName = process.env.SQS_EVENTS_QUEUE_NAME ?? "wager-events.fifo";
const maxReceiveCount = parsePositiveInt(
  "SQS_MAX_RECEIVE_COUNT",
  process.env.SQS_MAX_RECEIVE_COUNT ?? "5",
);
const visibilityTimeout = parsePositiveInt(
  "SQS_VISIBILITY_TIMEOUT_SECONDS",
  process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? "30",
);

const sqs = new SQSClient({
  region,
  endpoint,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
  },
});

function parsePositiveInt(name: string, raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} deve ser um inteiro positivo, recebido: "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
  const result = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  if (!result.QueueUrl) throw new Error(`Fila ${name} sem QueueUrl`);
  return result.QueueUrl;
}

async function getQueueArn(queueUrl: string): Promise<string> {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["QueueArn"],
    }),
  );
  const arn = result.Attributes?.QueueArn;
  if (!arn) throw new Error(`Fila ${queueUrl} sem QueueArn`);
  return arn;
}

async function main(): Promise<void> {
  const dlqUrl = await createQueue(dlqName, { FifoQueue: "true" });
  const dlqArn = await getQueueArn(dlqUrl);

  const mainUrl = await createQueue(mainName, {
    FifoQueue: "true",
    VisibilityTimeout: String(visibilityTimeout),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount,
    }),
  });

  const mainAttrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: mainUrl,
      AttributeNames: ["RedrivePolicy", "VisibilityTimeout", "FifoQueue"],
    }),
  );

  // Deduplicação explícita pelo eventId (MessageDeduplicationId), não pelo conteúdo.
  const eventsUrl = await createQueue(eventsName, { FifoQueue: "true" });

  log(`DLQ    : ${dlqUrl}`);
  log(`Fila   : ${mainUrl}`);
  log(`Atributos: ${JSON.stringify(mainAttrs.Attributes ?? {})}`);
  log(`Eventos: ${eventsUrl}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Falha ao criar filas: ${String(error)}\n`);
  process.exit(1);
});
