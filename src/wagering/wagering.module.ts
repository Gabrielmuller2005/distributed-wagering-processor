import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { AppConfig } from "../config/app-config";
import { APP_CONFIG } from "../config/config.module";
import { READINESS_CHECKS } from "../health/readiness";
import { CLOCK, type Clock, SystemClock } from "../shared/application/clock";
import {
  ID_GENERATOR,
  type IdGenerator,
  UuidV7Generator,
} from "../shared/application/id-generator";
import {
  AuthenticationDisabled,
  PROVIDER_IDENTITY,
  ProviderAuthGuard,
} from "../shared/interface/http/provider-auth.guard";
import { UNIT_OF_WORK, type UnitOfWork } from "./application/ports/unit-of-work";
import { CreateWallet } from "./application/use-cases/create-wallet";
import { ReconcileWallet } from "./application/use-cases/reconcile-wallet";
import { SubmitWagerTransaction } from "./application/use-cases/submit-wager-transaction";
import { WageringQueries } from "./application/use-cases/wagering-queries";
import { createOrm } from "./infrastructure/persistence/mikro-orm";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { DatabaseReadinessCheck, SqsReadinessCheck } from "./infrastructure/readiness-checks";
import { createSqsClient } from "./infrastructure/sqs/sqs-client";
import { WageringTransactionsController } from "./interface/http/wagering-transactions.controller";
import { WalletsController } from "./interface/http/wallets.controller";

export const MIKRO_ORM = Symbol("MIKRO_ORM");
export const SQS_CLIENT = Symbol("SQS_CLIENT");

/** Fecha o pool do banco e o cliente SQS quando a aplicação encerra (SIGTERM/SIGINT). */
@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

/**
 * Composição do contexto de apostas. Os casos de uso são classes sem decorators do Nest:
 * entram aqui por factory, com as dependências por token explícito (ver ARCHITECTURE.md, DI).
 */
@Module({
  controllers: [WalletsController, WageringTransactionsController],
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: (config: AppConfig) => createOrm(config.database),
      inject: [APP_CONFIG],
    },
    {
      provide: SQS_CLIENT,
      useFactory: (config: AppConfig) => createSqsClient(config.aws),
      inject: [APP_CONFIG],
    },
    InfrastructureLifecycle,
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new MikroOrmUnitOfWork(orm, config.database.lockTimeoutMs),
      inject: [MIKRO_ORM, APP_CONFIG],
    },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: CreateWallet,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new CreateWallet(uow, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: SubmitWagerTransaction,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new SubmitWagerTransaction(uow, ids, clock),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: WageringQueries,
      useFactory: (uow: UnitOfWork) => new WageringQueries(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork) => new ReconcileWallet(uow),
      inject: [UNIT_OF_WORK],
    },
    { provide: PROVIDER_IDENTITY, useClass: AuthenticationDisabled },
    ProviderAuthGuard,
    {
      provide: READINESS_CHECKS,
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) => [
        new DatabaseReadinessCheck(orm),
        new SqsReadinessCheck(sqs, config.sqs.queueName),
      ],
      inject: [MIKRO_ORM, SQS_CLIENT, APP_CONFIG],
    },
  ],
  exports: [READINESS_CHECKS, UNIT_OF_WORK, ID_GENERATOR, CLOCK],
})
export class WageringModule {}
