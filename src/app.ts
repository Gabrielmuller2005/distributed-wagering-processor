import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

/**
 * Cria a aplicação HTTP sem iniciar o listen, para ser reutilizada pelo main e pelos testes.
 */
export async function createHttpApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  return app;
}
