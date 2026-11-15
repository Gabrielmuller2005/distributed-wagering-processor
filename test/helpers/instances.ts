import { join } from "node:path";
import type { Subprocess } from "bun";
import { testDatabaseConfig } from "./database";
import { TEST_EVENTS_QUEUE_NAME, TEST_QUEUE_NAME } from "./http-app";

const ROOT = join(import.meta.dir, "..", "..");

/** Porta livre no momento da chamada (o SO escolhe; o listener é fechado em seguida). */
function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/**
 * Ambiente completo de uma instância de teste. Todos os papéis vêm explícitos: nada depende do
 * `.env` local nem dos valores padrão.
 */
export function instanceEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: testDatabaseConfig().url,
    DB_POOL_MAX: "10",
    DB_LOCK_TIMEOUT_MS: "2000",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    SQS_QUEUE_NAME: TEST_QUEUE_NAME,
    SQS_EVENTS_QUEUE_NAME: TEST_EVENTS_QUEUE_NAME,
    SQS_DLQ_NAME: "wager-transactions-dlq.fifo",
    SQS_WAIT_TIME_SECONDS: "1",
    ENABLE_HTTP: "true",
    ENABLE_OUTBOX_PUBLISHER: "false",
    ENABLE_SQS_CONSUMER: "false",
    ENABLE_PENDING_REFERENCE_WORKER: "false",
    OUTBOX_POLL_INTERVAL_MS: "100",
    PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
    ...overrides,
  };
}

export interface InstanceResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

export interface AppInstance {
  readonly name: string;
  /** Ausente em instância só de workers. */
  readonly baseUrl: string | undefined;
  readonly process: Subprocess;
  /** Resolve com o código de saída quando o processo termina, por qualquer motivo. */
  readonly exited: Promise<number>;
  /** stdout + stderr acumulados (logs JSON da instância), para diagnóstico. */
  output(): string;
  request<T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<InstanceResponse<T>>;
  /** Queda abrupta (SIGKILL): nada termina, nada é liberado de forma ordenada. */
  kill(): Promise<void>;
}

/**
 * Sobe o app real (`bun src/main.ts`) como um processo separado, com o seu próprio pool de
 * conexões, e espera ficar pronto: `/health/ready` 200 (com HTTP) ou a linha de bootstrap
 * (só workers). Falha com a saída do processo se ele morrer antes.
 */
export async function spawnInstance(
  name: string,
  overrides: Record<string, string> = {},
  { readyTimeoutMs = 20_000 } = {},
): Promise<AppInstance> {
  const http = (overrides.ENABLE_HTTP ?? "true") === "true";
  const port = http ? freePort() : 0;
  const env = instanceEnvironment({ HTTP_PORT: String(port), ...overrides });
  const child = Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  const decoder = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void drain(child.stdout);
  void drain(child.stderr);
  const exited = child.exited;
  let hasExited = false;
  void exited.then(() => {
    hasExited = true;
  });

  const baseUrl = http ? `http://127.0.0.1:${port}` : undefined;
  const request = async <T>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<InstanceResponse<T>> => {
    if (!baseUrl) throw new Error(`instance ${name} has no HTTP server`);
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // /metrics devolve texto, não JSON.
    }
    return { status: response.status, body: body as T };
  };

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (hasExited) {
      throw new Error(`instance ${name} exited during startup:\n${output}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`instance ${name} not ready within ${readyTimeoutMs}ms:\n${output}`);
    }
    if (http) {
      const ready = await request("GET", "/health/ready").catch(() => undefined);
      if (ready?.status === 200) break;
    } else if (output.includes("worker instance started")) {
      break;
    }
    await Bun.sleep(100);
  }

  return {
    name,
    baseUrl,
    process: child,
    exited,
    output: () => output,
    request,
    async kill() {
      if (!hasExited) child.kill("SIGKILL");
      await exited;
    },
  };
}

/** Derruba todas as instâncias ainda vivas (afterEach/afterAll). */
export async function killAll(instances: readonly AppInstance[]): Promise<void> {
  await Promise.all(instances.map((instance) => instance.kill()));
}
