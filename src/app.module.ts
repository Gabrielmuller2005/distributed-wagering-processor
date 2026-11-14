import { type DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "./config/app-config";
import { ConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";
import { WageringModule } from "./wagering/wagering.module";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), WageringModule],
      controllers: [HealthController],
    };
  }
}
