import { type INestApplication, type INestApplicationContext, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/app-config";
import { ID_GENERATOR, type IdGenerator } from "./shared/application/id-generator";
import { correlationIdMiddleware } from "./shared/interface/http/correlation-id.middleware";
import { requestLoggingMiddleware } from "./shared/interface/http/request-logging.middleware";
import { createRootLogger, PinoLoggerService } from "./shared/observability/logger";
import {
  WAGERING_METRICS,
  type WageringMetrics,
} from "./wagering/infrastructure/observability/wagering-metrics";
import { HttpErrorFilter } from "./wagering/interface/http/http-error.filter";

/** Limite do corpo JSON: uma transação tem poucas centenas de bytes; nada legítimo passa disso. */
const JSON_BODY_LIMIT = "64kb";

/** Logger JSON (pino) da aplicação; o `Logger` do Nest passa a escrever por ele. */
function applicationLogger(config: AppConfig): PinoLoggerService {
  return new PinoLoggerService(createRootLogger(config.logLevel));
}

/**
 * Cria a aplicação HTTP sem iniciar o listen, para ser reutilizada pelo main e pelos testes.
 */
export async function createHttpApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(applicationLogger(config));
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  const ids = app.get<IdGenerator>(ID_GENERATOR);
  // Ordem importa: o correlationId abre o contexto de log em que a linha da requisição é escrita.
  app.use(correlationIdMiddleware(() => ids.next()));
  app.use(requestLoggingMiddleware(new Logger("Http")));
  app.useGlobalFilters(new HttpErrorFilter(app.get<WageringMetrics>(WAGERING_METRICS)));
  app.enableShutdownHooks();
  return app;
}

/**
 * Instância só de workers (ENABLE_HTTP=false): o mesmo módulo, sem servidor HTTP. Os papéis
 * habilitados começam no `init` (onApplicationBootstrap) e param no SIGTERM/SIGINT.
 */
export async function createWorkerApp(config: AppConfig): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(AppModule.register(config), {
    bufferLogs: true,
  });
  app.useLogger(applicationLogger(config));
  app.enableShutdownHooks();
  return app;
}
