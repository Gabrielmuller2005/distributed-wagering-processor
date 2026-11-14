import "reflect-metadata";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import type { INestApplication } from "@nestjs/common";
import { createHttpApp } from "../../src/app";
import { type AppConfig, loadConfig } from "../../src/config/app-config";
import { createSqsClient } from "../../src/wagering/infrastructure/sqs/sqs-client";
import { testDatabaseConfig } from "./database";

export const TEST_QUEUE_NAME = "wager-transactions-test.fifo";
export const TEST_EVENTS_QUEUE_NAME = "wager-events-test.fifo";

/** Configuração da aplicação apontando para o banco de teste e o MiniStack local. */
export function testAppConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: testDatabaseConfig().url,
    DB_POOL_MAX: "20",
    DB_LOCK_TIMEOUT_MS: "2000",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    SQS_QUEUE_NAME: TEST_QUEUE_NAME,
    SQS_EVENTS_QUEUE_NAME: TEST_EVENTS_QUEUE_NAME,
    // Os testes de HTTP não publicam: os de outbox ligam o publisher de forma controlada.
    ENABLE_OUTBOX_PUBLISHER: "false",
    ENABLE_SQS_CONSUMER: "false",
    ENABLE_PENDING_REFERENCE_WORKER: "false",
    ...overrides,
  });
}

/** Garante a fila usada pelo readiness check (CreateQueue é idempotente). */
export async function ensureTestQueue(config: AppConfig): Promise<void> {
  const sqs = createSqsClient(config.aws);
  try {
    await sqs.send(
      new CreateQueueCommand({
        QueueName: config.sqs.queueName,
        Attributes: { FifoQueue: "true" },
      }),
    );
  } finally {
    sqs.destroy();
  }
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface TestHttpApp {
  readonly app: INestApplication;
  readonly baseUrl: string;
  request<T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown; rawBody?: string; headers?: Record<string, string> },
  ): Promise<HttpResponse<T>>;
  close(): Promise<void>;
}

/** Sobe a aplicação HTTP real numa porta livre, sem logs. */
export async function startTestApp(config: AppConfig = testAppConfig()): Promise<TestHttpApp> {
  const app = await createHttpApp(config);
  app.useLogger(false);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
    async request<T>(
      method: string,
      path: string,
      options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
    ): Promise<HttpResponse<T>> {
      const hasBody = options.body !== undefined || options.rawBody !== undefined;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...options.headers },
        body:
          options.rawBody ??
          (options.body === undefined ? undefined : JSON.stringify(options.body)),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: (text ? JSON.parse(text) : undefined) as T,
      };
    },
    close: () => app.close(),
  };
}
