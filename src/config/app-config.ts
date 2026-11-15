import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "../shared/observability/logger";

/**
 * Flags booleanas aceitam apenas "true" ou "false". Valores como "1" ou "yes" são rejeitados
 * de propósito: um papel ligado por engano numa instância é um problema operacional real.
 */
const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const FIFO_QUEUE_NAME = /^[A-Za-z0-9_-]{1,75}\.fifo$/;

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    ENABLE_HTTP: booleanFlag.default(true),
    ENABLE_OUTBOX_PUBLISHER: booleanFlag.default(true),
    ENABLE_SQS_CONSUMER: booleanFlag.default(true),
    ENABLE_PENDING_REFERENCE_WORKER: booleanFlag.default(true),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(5_000),
    AWS_REGION: z.string().min(1).default("us-east-1"),
    // Ausente em produção (endpoint real da AWS); no ambiente local aponta para o MiniStack.
    AWS_ENDPOINT_URL: z.url().optional(),
    AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    // Nome de fila FIFO da AWS: até 80 caracteres, letras, dígitos, - e _, terminando em .fifo.
    SQS_QUEUE_NAME: z.string().regex(FIFO_QUEUE_NAME).default("wager-transactions.fifo"),
    SQS_DLQ_NAME: z.string().regex(FIFO_QUEUE_NAME).default("wager-transactions-dlq.fifo"),
    SQS_EVENTS_QUEUE_NAME: z.string().regex(FIFO_QUEUE_NAME).default("wager-events.fifo"),
    // Mesmo valor do maxReceiveCount da RedrivePolicy (scripts/setup-queues.ts).
    SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).max(1_000).default(5),
    // ReceiveMessage devolve no máximo 10 mensagens por chamada.
    SQS_CONSUMER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
    // Long polling: de 1 a 20 s (limite da AWS).
    SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(1).max(20).default(10),
    // SendMessageBatch aceita no máximo 10 mensagens por chamada.
    // Prazo para a referência chegar (padrão 15 min; justificativa no ARCHITECTURE.md).
    PENDING_REFERENCE_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(7 * 24 * 3_600_000)
      .default(900_000),
    PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(500),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
    OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(10_000),
  })
  .refine(
    (env) =>
      env.ENABLE_HTTP ||
      env.ENABLE_OUTBOX_PUBLISHER ||
      env.ENABLE_SQS_CONSUMER ||
      env.ENABLE_PENDING_REFERENCE_WORKER,
    {
      message:
        "at least one role must be enabled (ENABLE_HTTP, ENABLE_OUTBOX_PUBLISHER, ENABLE_SQS_CONSUMER, ENABLE_PENDING_REFERENCE_WORKER)",
      path: ["ENABLE_HTTP"],
    },
  )
  // A reserva precisa durar mais que a publicação: senão outra instância reassume o lote
  // enquanto a primeira ainda está publicando, e todo lote lento sai duplicado.
  .refine((env) => env.OUTBOX_LEASE_MS > env.OUTBOX_PUBLISH_TIMEOUT_MS, {
    message: "must be greater than OUTBOX_PUBLISH_TIMEOUT_MS",
    path: ["OUTBOX_LEASE_MS"],
  });

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: LogLevel;
  readonly http: {
    readonly enabled: boolean;
    readonly port: number;
  };
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    /** Espera máxima por um lock de linha (SET LOCAL lock_timeout) em cada transação. */
    readonly lockTimeoutMs: number;
  };
  readonly aws: {
    readonly region: string;
    readonly endpoint: string | undefined;
    /** Ausentes: o SDK usa a cadeia padrão de credenciais (variáveis, perfil, IAM role). */
    readonly credentials:
      | { readonly accessKeyId: string; readonly secretAccessKey: string }
      | undefined;
  };
  readonly sqs: {
    readonly queueName: string;
    readonly deadLetterQueueName: string;
    /** Fila FIFO onde o publisher da outbox entrega os eventos de integração. */
    readonly eventsQueueName: string;
  };
  readonly consumer: {
    readonly enabled: boolean;
    /** Tentativas por mensagem antes da DLQ (falhas transitórias). */
    readonly maxReceiveCount: number;
    /** Mensagens por ReceiveMessage. */
    readonly batchSize: number;
    /** Long polling do ReceiveMessage, em segundos. */
    readonly waitTimeSeconds: number;
  };
  readonly pendingReference: {
    readonly workerEnabled: boolean;
    /** Prazo para a referência chegar, contado da aceitação da transação. */
    readonly ttlMs: number;
    readonly batchSize: number;
    readonly pollIntervalMs: number;
  };
  readonly outbox: {
    readonly publisherEnabled: boolean;
    /** Mensagens por ciclo (uma chamada SendMessageBatch). */
    readonly batchSize: number;
    /** Espera entre ciclos quando não há nada a publicar. */
    readonly pollIntervalMs: number;
    /** Por quanto tempo um lote reservado fica invisível aos outros publishers. */
    readonly leaseMs: number;
    /** Tempo máximo de uma chamada de publicação ao SQS. */
    readonly publishTimeoutMs: number;
  };
}

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigValidationError";
  }
}

/**
 * Valida as variáveis de ambiente e devolve uma configuração tipada e imutável.
 * Falha rápido: qualquer valor inválido impede a aplicação de subir, com todos os problemas listados.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  const parsed = result.data;
  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    http: Object.freeze({ enabled: parsed.ENABLE_HTTP, port: parsed.HTTP_PORT }),
    database: Object.freeze({
      url: parsed.DATABASE_URL,
      poolMax: parsed.DB_POOL_MAX,
      lockTimeoutMs: parsed.DB_LOCK_TIMEOUT_MS,
    }),
    aws: Object.freeze({
      region: parsed.AWS_REGION,
      endpoint: parsed.AWS_ENDPOINT_URL,
      credentials:
        parsed.AWS_ACCESS_KEY_ID && parsed.AWS_SECRET_ACCESS_KEY
          ? Object.freeze({
              accessKeyId: parsed.AWS_ACCESS_KEY_ID,
              secretAccessKey: parsed.AWS_SECRET_ACCESS_KEY,
            })
          : undefined,
    }),
    sqs: Object.freeze({
      queueName: parsed.SQS_QUEUE_NAME,
      deadLetterQueueName: parsed.SQS_DLQ_NAME,
      eventsQueueName: parsed.SQS_EVENTS_QUEUE_NAME,
    }),
    consumer: Object.freeze({
      enabled: parsed.ENABLE_SQS_CONSUMER,
      maxReceiveCount: parsed.SQS_MAX_RECEIVE_COUNT,
      batchSize: parsed.SQS_CONSUMER_BATCH_SIZE,
      waitTimeSeconds: parsed.SQS_WAIT_TIME_SECONDS,
    }),
    pendingReference: Object.freeze({
      workerEnabled: parsed.ENABLE_PENDING_REFERENCE_WORKER,
      ttlMs: parsed.PENDING_REFERENCE_TTL_MS,
      batchSize: parsed.PENDING_REFERENCE_BATCH_SIZE,
      pollIntervalMs: parsed.PENDING_REFERENCE_POLL_INTERVAL_MS,
    }),
    outbox: Object.freeze({
      publisherEnabled: parsed.ENABLE_OUTBOX_PUBLISHER,
      batchSize: parsed.OUTBOX_BATCH_SIZE,
      pollIntervalMs: parsed.OUTBOX_POLL_INTERVAL_MS,
      leaseMs: parsed.OUTBOX_LEASE_MS,
      publishTimeoutMs: parsed.OUTBOX_PUBLISH_TIMEOUT_MS,
    }),
  });
}
