import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createHttpApp, createWorkerApp } from "./app";
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

  // Uma aplicação Nest por processo. Os workers habilitados sobem junto, no bootstrap dela.
  if (config.http.enabled) {
    const app = await createHttpApp(config);
    await app.listen(config.http.port);
    logger.log(`HTTP listening on port ${config.http.port}`);
  } else {
    const app = await createWorkerApp(config);
    await app.init();
    logger.log("worker instance started (HTTP disabled)");
  }
}

void bootstrap();
