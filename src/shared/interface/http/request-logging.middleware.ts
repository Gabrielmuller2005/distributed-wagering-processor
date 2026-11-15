import { currentLogContext } from "../../observability/log-context";

interface IncomingRequest {
  readonly method: string;
  /** Caminho sem a query string: cursores e filtros não vão para o log. */
  readonly path: string;
}

interface OutgoingResponse {
  readonly statusCode: number;
  once(event: "finish", listener: () => void): unknown;
}

export interface RequestLogger {
  debug(message: Record<string, unknown>, context: string): void;
  log(message: Record<string, unknown>, context: string): void;
  warn(message: Record<string, unknown>, context: string): void;
  error(message: Record<string, unknown>, context: string): void;
}

/**
 * Tráfego de infraestrutura (scraper e orquestrador), chamado a cada poucos segundos: sai em
 * debug quando dá certo, para não afogar as linhas de negócio.
 */
const INFRASTRUCTURE_PATHS = new Set(["/metrics", "/health/live", "/health/ready"]);

/**
 * Uma linha de log por requisição, quando a resposta termina: método, caminho, status e duração,
 * com os identificadores do contexto (correlationId e, quando já conhecidos, transactionId,
 * walletId e providerId). Corpo, headers e query string não entram.
 *
 * Precisa vir depois do middleware de correlationId, dentro do contexto de log que ele abre.
 */
export function requestLoggingMiddleware(logger: RequestLogger) {
  return (request: IncomingRequest, response: OutgoingResponse, next: () => void): void => {
    const startedAt = performance.now();
    // O evento "finish" sai fora do contexto assíncrono da requisição: guarda a referência.
    const context = currentLogContext();
    response.once("finish", () => {
      const line = {
        msg: "request completed",
        ...context,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
      if (response.statusCode >= 500) logger.error(line, "Http");
      else if (response.statusCode >= 400) logger.warn(line, "Http");
      else if (INFRASTRUCTURE_PATHS.has(request.path)) logger.debug(line, "Http");
      else logger.log(line, "Http");
    });
    next();
  };
}
