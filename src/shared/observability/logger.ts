import type { LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { currentLogContext } from "./log-context";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Campos nunca escritos nos logs, em qualquer profundidade usual. O código não loga payloads,
 * mas a redaction é a rede de segurança: se alguém passar um objeto com valores financeiros,
 * corpo de requisição ou credenciais, eles saem como "[REDACTED]".
 */
export const REDACTED_PATHS: readonly string[] = [
  "money",
  "amount",
  "balance",
  "balanceAfter",
  "balanceBefore",
  "initialBalance",
  "payload",
  "body",
  "data",
  "headers.authorization",
  "headers.cookie",
  "*.money",
  "*.amount",
  "*.balance",
  "*.balanceAfter",
  "*.balanceBefore",
  "*.initialBalance",
  "*.payload",
  "*.body",
  "*.data",
  "*.headers.authorization",
  "*.headers.cookie",
];

export const SERVICE_NAME = "distributed-wagering-processor";

/**
 * Logger raiz: uma linha JSON por evento, com horário ISO, nível por nome, nome do serviço e os
 * identificadores do contexto corrente (correlationId, messageId, transactionId, walletId,
 * providerId), acrescentados automaticamente pelo `mixin`.
 */
export function createRootLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentLogContext() }),
    redact: { paths: [...REDACTED_PATHS], censor: "[REDACTED]" },
  };
  return destination ? pino(options, destination) : pino(options);
}

/**
 * Ponte entre o `Logger` do Nest e o pino: todo `new Logger("Contexto")` do código passa a sair
 * em JSON, com o nome do contexto no campo `context`.
 *
 * Mensagem objeto vira campos da linha (`logger.log({ msg, transactionId })`); mensagem texto
 * vira o `msg`. O último parâmetro string é o contexto, como no Nest.
 */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly root: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    // Assinatura do Nest: error(message, stack?, context?).
    const context = trailingContext(params);
    const stack = params.find((param, index) => index < params.length - 1 && isString(param));
    this.root.error(
      { context, ...(stack ? { stack } : {}), ...fieldsOf(message) },
      textOf(message),
    );
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write("trace", message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write("fatal", message, params);
  }

  private write(
    level: "info" | "warn" | "debug" | "trace" | "fatal",
    message: unknown,
    params: unknown[],
  ) {
    this.root[level]({ context: trailingContext(params), ...fieldsOf(message) }, textOf(message));
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function trailingContext(params: readonly unknown[]): string | undefined {
  const last = params[params.length - 1];
  return isString(last) ? last : undefined;
}

function fieldsOf(message: unknown): Record<string, unknown> {
  if (message === null || typeof message !== "object" || message instanceof Error) return {};
  const { msg: _msg, ...fields } = message as Record<string, unknown>;
  return fields;
}

function textOf(message: unknown): string {
  if (isString(message)) return message;
  if (message instanceof Error) return message.message;
  if (message !== null && typeof message === "object") {
    const msg = (message as Record<string, unknown>).msg;
    if (isString(msg)) return msg;
  }
  return String(message);
}
