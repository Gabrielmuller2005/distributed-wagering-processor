import { describe, expect, test } from "bun:test";
import { ConfigValidationError, loadConfig } from "../../../src/config/app-config";

function captureError(env: Record<string, string>): ConfigValidationError {
  try {
    loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("aplica os valores padrão quando as variáveis não são informadas", () => {
    expect(loadConfig({})).toEqual({
      nodeEnv: "development",
      http: { enabled: true, port: 3000 },
    });
  });

  test("lê os valores informados", () => {
    const config = loadConfig({ NODE_ENV: "production", HTTP_PORT: "8080", ENABLE_HTTP: "true" });

    expect(config.nodeEnv).toBe("production");
    expect(config.http.port).toBe(8080);
  });

  test("devolve uma configuração imutável", () => {
    const config = loadConfig({});

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
  });

  test.each(["abc", "-1", "70000", "30.5"])("rejeita HTTP_PORT inválida: %p", (port) => {
    expect(captureError({ HTTP_PORT: port }).issues[0]).toStartWith("HTTP_PORT:");
  });

  test.each(["1", "yes", "TRUE", ""])("rejeita flag booleana fora de true/false: %p", (flag) => {
    expect(captureError({ ENABLE_HTTP: flag }).issues[0]).toStartWith("ENABLE_HTTP:");
  });

  test("rejeita instância sem nenhum papel habilitado", () => {
    expect(captureError({ ENABLE_HTTP: "false" }).issues).toEqual([
      "ENABLE_HTTP: at least one role must be enabled (ENABLE_HTTP)",
    ]);
  });

  test("lista todos os problemas de uma vez", () => {
    const error = captureError({ NODE_ENV: "staging", HTTP_PORT: "abc" });

    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain("NODE_ENV");
    expect(error.message).toContain("HTTP_PORT");
  });
});
