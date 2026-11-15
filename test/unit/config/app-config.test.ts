import { describe, expect, test } from "bun:test";
import { ConfigValidationError, loadConfig } from "../../../src/config/app-config";

const DATABASE_URL = "postgres://wagering:wagering@localhost:5432/wagering";

/** Variáveis mínimas obrigatórias, mais as do caso de teste. */
const env = (overrides: Record<string, string> = {}) => ({ DATABASE_URL, ...overrides });

function captureError(variables: Record<string, string>): ConfigValidationError {
  try {
    loadConfig(variables);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("aplica os valores padrão quando só o obrigatório é informado", () => {
    expect(loadConfig(env())).toEqual({
      nodeEnv: "development",
      logLevel: "info",
      http: { enabled: true, port: 3000 },
      database: { url: DATABASE_URL, poolMax: 10, lockTimeoutMs: 5000 },
      aws: { region: "us-east-1", endpoint: undefined, credentials: undefined },
      sqs: {
        queueName: "wager-transactions.fifo",
        deadLetterQueueName: "wager-transactions-dlq.fifo",
        eventsQueueName: "wager-events.fifo",
      },
      consumer: { enabled: true, maxReceiveCount: 5, batchSize: 10, waitTimeSeconds: 10 },
      pendingReference: {
        workerEnabled: true,
        ttlMs: 900_000,
        batchSize: 20,
        pollIntervalMs: 1_000,
      },
      outbox: {
        publisherEnabled: true,
        batchSize: 10,
        pollIntervalMs: 500,
        leaseMs: 30_000,
        publishTimeoutMs: 10_000,
      },
    });
  });

  test("lê endpoint e credenciais da AWS quando informados", () => {
    const config = loadConfig(
      env({
        AWS_ENDPOINT_URL: "http://localhost:4566",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    );

    expect(config.aws).toEqual({
      region: "us-east-1",
      endpoint: "http://localhost:4566",
      credentials: { accessKeyId: "test", secretAccessKey: "secret" },
    });
  });

  test("credencial pela metade é ignorada: o SDK usa a cadeia padrão", () => {
    expect(loadConfig(env({ AWS_ACCESS_KEY_ID: "only-id" })).aws.credentials).toBeUndefined();
  });

  test.each(["wager-transactions", "fila com espaço.fifo", ".fifo"])(
    "rejeita SQS_QUEUE_NAME que não é FIFO válida: %p",
    (name) => {
      expect(captureError(env({ SQS_QUEUE_NAME: name })).issues[0]).toStartWith("SQS_QUEUE_NAME:");
    },
  );

  test("lê os valores informados", () => {
    const config = loadConfig(
      env({
        NODE_ENV: "production",
        HTTP_PORT: "8080",
        ENABLE_HTTP: "true",
        DB_POOL_MAX: "20",
        DB_LOCK_TIMEOUT_MS: "2000",
      }),
    );

    expect(config.nodeEnv).toBe("production");
    expect(config.http.port).toBe(8080);
    expect(config.database.poolMax).toBe(20);
    expect(config.database.lockTimeoutMs).toBe(2000);
  });

  test("devolve uma configuração imutável", () => {
    const config = loadConfig(env());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  test("DATABASE_URL é obrigatória", () => {
    expect(captureError({}).issues[0]).toStartWith("DATABASE_URL:");
  });

  test.each(["not-a-url", "mysql://user@localhost/db", "http://localhost:5432/db"])(
    "rejeita DATABASE_URL que não é PostgreSQL: %p",
    (url) => {
      expect(captureError({ DATABASE_URL: url }).issues[0]).toStartWith("DATABASE_URL:");
    },
  );

  test("aceita os esquemas postgres:// e postgresql://", () => {
    const url = "postgresql://user:pass@db:5432/wagering";

    expect(loadConfig({ DATABASE_URL: url }).database.url).toBe(url);
  });

  test.each(["0", "-1", "60001", "abc"])("rejeita DB_LOCK_TIMEOUT_MS inválido: %p", (value) => {
    expect(captureError(env({ DB_LOCK_TIMEOUT_MS: value })).issues[0]).toStartWith(
      "DB_LOCK_TIMEOUT_MS:",
    );
  });

  test.each(["abc", "-1", "70000", "30.5"])("rejeita HTTP_PORT inválida: %p", (port) => {
    expect(captureError(env({ HTTP_PORT: port })).issues[0]).toStartWith("HTTP_PORT:");
  });

  test.each(["1", "yes", "TRUE", ""])("rejeita flag booleana fora de true/false: %p", (flag) => {
    expect(captureError(env({ ENABLE_HTTP: flag })).issues[0]).toStartWith("ENABLE_HTTP:");
  });

  test("rejeita instância sem nenhum papel habilitado", () => {
    const noRoles = env({
      ENABLE_HTTP: "false",
      ENABLE_OUTBOX_PUBLISHER: "false",
      ENABLE_SQS_CONSUMER: "false",
      ENABLE_PENDING_REFERENCE_WORKER: "false",
    });

    expect(captureError(noRoles).issues).toEqual([
      "ENABLE_HTTP: at least one role must be enabled (ENABLE_HTTP, ENABLE_OUTBOX_PUBLISHER, ENABLE_SQS_CONSUMER, ENABLE_PENDING_REFERENCE_WORKER)",
    ]);
  });

  test("aceita instância só de publisher, sem HTTP", () => {
    const config = loadConfig(env({ ENABLE_HTTP: "false", ENABLE_OUTBOX_PUBLISHER: "true" }));

    expect(config.http.enabled).toBe(false);
    expect(config.outbox.publisherEnabled).toBe(true);
  });

  test("aceita instância só de consumidor SQS", () => {
    const config = loadConfig(
      env({ ENABLE_HTTP: "false", ENABLE_OUTBOX_PUBLISHER: "false", ENABLE_SQS_CONSUMER: "true" }),
    );

    expect(config.consumer.enabled).toBe(true);
  });

  test.each(["999", "abc"])("rejeita PENDING_REFERENCE_TTL_MS inválido: %p", (value) => {
    expect(captureError(env({ PENDING_REFERENCE_TTL_MS: value })).issues[0]).toStartWith(
      "PENDING_REFERENCE_TTL_MS:",
    );
  });

  test.each(["0", "21"])("rejeita SQS_WAIT_TIME_SECONDS fora de 1..20: %p", (value) => {
    expect(captureError(env({ SQS_WAIT_TIME_SECONDS: value })).issues[0]).toStartWith(
      "SQS_WAIT_TIME_SECONDS:",
    );
  });

  test.each(["0", "11", "abc"])("rejeita OUTBOX_BATCH_SIZE fora de 1..10: %p", (value) => {
    expect(captureError(env({ OUTBOX_BATCH_SIZE: value })).issues[0]).toStartWith(
      "OUTBOX_BATCH_SIZE:",
    );
  });

  test("rejeita reserva da outbox que não supera o timeout de publicação", () => {
    expect(
      captureError(env({ OUTBOX_LEASE_MS: "5000", OUTBOX_PUBLISH_TIMEOUT_MS: "5000" })).issues,
    ).toEqual(["OUTBOX_LEASE_MS: must be greater than OUTBOX_PUBLISH_TIMEOUT_MS"]);
  });

  test("lista todos os problemas de uma vez", () => {
    const error = captureError({ NODE_ENV: "staging", HTTP_PORT: "abc" });

    expect(error.issues).toHaveLength(3);
    expect(error.message).toContain("NODE_ENV");
    expect(error.message).toContain("HTTP_PORT");
    expect(error.message).toContain("DATABASE_URL");
  });
});
