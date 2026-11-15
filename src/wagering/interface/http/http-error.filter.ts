import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from "@nestjs/common";
import type { WageringMetrics } from "../../infrastructure/observability/wagering-metrics";
import { transientReasonOf } from "../../infrastructure/persistence/transient-errors";
import { toHttpError } from "./http-error-mapping";

/** O mínimo da resposta HTTP de que o filter precisa (independe do adapter Express). */
interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** Aplica o mapeamento único de erros (`toHttpError`) a todo endpoint. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpErrorFilter");

  constructor(private readonly metrics?: WageringMetrics) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const mapped = toHttpError(error);
    const transient = transientReasonOf(error);
    if (transient) this.metrics?.transientFailure("http", transient);
    if (mapped.unexpected) {
      this.logger.error(
        error instanceof Error ? error.message : "Non-error thrown",
        error instanceof Error ? error.stack : undefined,
      );
    }

    const response = host.switchToHttp().getResponse<HttpResponse>();
    for (const [name, value] of Object.entries(mapped.headers ?? {})) {
      response.setHeader(name, value);
    }
    response.status(mapped.status).json(mapped.body);
  }
}
