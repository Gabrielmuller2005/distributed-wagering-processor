import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { AppConfig } from "./app-config";

export const APP_CONFIG = Symbol("APP_CONFIG");

/**
 * Disponibiliza a configuração já validada para toda a aplicação, via token APP_CONFIG.
 * A validação acontece antes do Nest subir (em loadConfig), não dentro do container.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
