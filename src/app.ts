import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/app-config";

/**
 * Cria a aplicação HTTP sem iniciar o listen, para ser reutilizada pelo main e pelos testes.
 */
export async function createHttpApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { bufferLogs: true });
  app.enableShutdownHooks();
  return app;
}
