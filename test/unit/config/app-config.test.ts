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
      http: { enabled: true, port: 3000 },
      database: { url: DATABASE_URL, poolMax: 10, lockTimeoutMs: 5000 },
    });
  });

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
    expect(captureError(env({ ENABLE_HTTP: "false" })).issues).toEqual([
      "ENABLE_HTTP: at least one role must be enabled (ENABLE_HTTP)",
    ]);
  });

  test("lista todos os problemas de uma vez", () => {
    const error = captureError({ NODE_ENV: "staging", HTTP_PORT: "abc" });

    expect(error.issues).toHaveLength(3);
    expect(error.message).toContain("NODE_ENV");
    expect(error.message).toContain("HTTP_PORT");
    expect(error.message).toContain("DATABASE_URL");
  });
});
