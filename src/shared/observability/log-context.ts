import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identificadores que acompanham uma unidade de trabalho (uma requisição HTTP, uma mensagem
 * SQS) e entram em toda linha de log dela, sem cada chamada precisar repassá-los.
 */
export interface LogContext {
  correlationId?: string;
  /** messageId do envelope SQS. */
  messageId?: string;
  /** MessageId atribuído pelo SQS (diferente a cada envio). */
  sqsMessageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const LOG_CONTEXT_FIELDS: readonly (keyof LogContext)[] = [
  "correlationId",
  "messageId",
  "sqsMessageId",
  "transactionId",
  "walletId",
  "providerId",
];

/** Limite de cada valor: um id vindo de fora não pode inflar todas as linhas de log. */
const MAX_VALUE_LENGTH = 128;

const storage = new AsyncLocalStorage<LogContext>();

/** Roda `work` com um contexto de log próprio; tudo o que ela chamar (inclusive async) o herda. */
export function runWithLogContext<T>(initial: LogContext, work: () => T): T {
  return storage.run(sanitize(initial), work);
}

/**
 * Acrescenta identificadores ao contexto corrente, conforme ficam conhecidos (ex.: o
 * transactionId só existe depois da submissão). Fora de um contexto, não faz nada.
 */
export function enrichLogContext(fields: Partial<Record<keyof LogContext, unknown>>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, sanitize(fields));
}

export function currentLogContext(): Readonly<LogContext> {
  return storage.getStore() ?? {};
}

/** Só strings não vazias e curtas: o que vem de payload externo pode ter qualquer tipo. */
function sanitize(fields: Partial<Record<keyof LogContext, unknown>>): LogContext {
  const result: LogContext = {};
  for (const field of LOG_CONTEXT_FIELDS) {
    const value = fields[field];
    if (typeof value === "string" && value !== "") {
      result[field] = value.slice(0, MAX_VALUE_LENGTH);
    }
  }
  return result;
}
