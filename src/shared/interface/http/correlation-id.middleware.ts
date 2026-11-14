export const CORRELATION_ID_HEADER = "x-correlation-id";

/** Aceito só o que é seguro de repassar para logs e eventos; o resto é descartado e gerado de novo. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface OutgoingResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Garante um correlationId em toda requisição: usa o `x-correlation-id` recebido, se for válido,
 * ou gera um novo. O valor fica no header da requisição (lido pelos controllers) e volta no header
 * da resposta, para o cliente correlacionar logs dos dois lados.
 */
export function correlationIdMiddleware(generate: () => string) {
  return (request: IncomingRequest, response: OutgoingResponse, next: () => void): void => {
    const received = request.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof received === "string" && VALID_CORRELATION_ID.test(received) ? received : generate();
    request.headers[CORRELATION_ID_HEADER] = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  };
}
