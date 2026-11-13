import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createHttpApp } from "./app";
import { type AppConfig, ConfigValidationError, loadConfig } from "./config/app-config";

const logger = new Logger("Bootstrap");

function readConfig(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Cada instância liga apenas os papéis habilitados por variável de ambiente (ENABLE_*).
 * Isso permite rodar API e workers em processos separados, inclusive nos testes com várias instâncias.
 */
async function bootstrap(): Promise<void> {
  const config = readConfig();

  if (config.http.enabled) {
    const app = await createHttpApp(config);
    await app.listen(config.http.port);
    logger.log(`HTTP listening on port ${config.http.port}`);
  }
}

void bootstrap();
