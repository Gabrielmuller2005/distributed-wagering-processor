import { z } from "zod";

/**
 * Flags booleanas aceitam apenas "true" ou "false". Valores como "1" ou "yes" são rejeitados
 * de propósito: um papel ligado por engano numa instância é um problema operacional real.
 */
const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const FIFO_QUEUE_NAME = /^[A-Za-z0-9_-]{1,75}\.fifo$/;

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    ENABLE_HTTP: booleanFlag.default(true),
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
  })
  .refine((env) => env.ENABLE_HTTP, {
    message: "at least one role must be enabled (ENABLE_HTTP)",
    path: ["ENABLE_HTTP"],
  });

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
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
    }),
  });
}
