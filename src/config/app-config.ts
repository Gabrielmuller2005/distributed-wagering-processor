import { z } from "zod";

/**
 * Flags booleanas aceitam apenas "true" ou "false". Valores como "1" ou "yes" são rejeitados
 * de propósito: um papel ligado por engano numa instância é um problema operacional real.
 */
const booleanFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    ENABLE_HTTP: booleanFlag.default(true),
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
  });
}
