import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/app-config";
import { ID_GENERATOR, type IdGenerator } from "./shared/application/id-generator";
import { correlationIdMiddleware } from "./shared/interface/http/correlation-id.middleware";
import { HttpErrorFilter } from "./wagering/interface/http/http-error.filter";

/** Limite do corpo JSON: uma transação tem poucas centenas de bytes; nada legítimo passa disso. */
const JSON_BODY_LIMIT = "64kb";

/**
 * Cria a aplicação HTTP sem iniciar o listen, para ser reutilizada pelo main e pelos testes.
 */
export async function createHttpApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  const ids = app.get<IdGenerator>(ID_GENERATOR);
  app.use(correlationIdMiddleware(() => ids.next()));
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  return app;
}
