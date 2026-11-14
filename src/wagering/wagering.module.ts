import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
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
import { EVENT_PUBLISHER, type EventPublisher } from "./application/ports/event-publisher";
import { UNIT_OF_WORK, type UnitOfWork } from "./application/ports/unit-of-work";
import { CreateWallet } from "./application/use-cases/create-wallet";
import { PublishOutboxBatch } from "./application/use-cases/publish-outbox-batch";
import { ReconcileWallet } from "./application/use-cases/reconcile-wallet";
import { RetryPendingReferences } from "./application/use-cases/retry-pending-references";
import { SubmitWagerTransaction } from "./application/use-cases/submit-wager-transaction";
import { WageringQueries } from "./application/use-cases/wagering-queries";
import { createOrm } from "./infrastructure/persistence/mikro-orm";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm-unit-of-work";
import { DatabaseReadinessCheck, SqsReadinessCheck } from "./infrastructure/readiness-checks";
import { createSqsClient } from "./infrastructure/sqs/sqs-client";
import { SqsEventPublisher } from "./infrastructure/sqs/sqs-event-publisher";
import { SqsQueueConsumer } from "./infrastructure/sqs/sqs-queue-consumer";
import { WageringTransactionsController } from "./interface/http/wagering-transactions.controller";
import { WalletsController } from "./interface/http/wallets.controller";
import { WagerTransactionMessageHandler } from "./interface/sqs/wager-transaction-message-handler";
import { OutboxPublisherWorker } from "./interface/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "./interface/workers/pending-reference.worker";
import { SqsConsumerWorker, WAGER_QUEUE_CONSUMER } from "./interface/workers/sqs-consumer.worker";

export const MIKRO_ORM = Symbol("MIKRO_ORM");

/**
 * Atraso antes de reentregar uma mensagem com falha transitória: 2 s, 4 s, 8 s... até 60 s.
 * Com o limite padrão de 5 entregas, uma mensagem tenta por cerca de meio minuto antes da DLQ:
 * o bastante para atravessar um lock disputado ou um failover curto do banco.
 */
/**
 * Reserva de um lote de PENDING_REFERENCE. Cada item leva milissegundos (no máximo o
 * lock_timeout); 30 s cobrem um lote inteiro com folga e limitam o atraso se o worker morrer.
 */
const PENDING_REFERENCE_LEASE_MS = 30_000;

const CONSUMER_RETRY_BACKOFF = Object.freeze({ baseDelayMs: 2_000, maxDelayMs: 60_000 });
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
    {
      provide: EVENT_PUBLISHER,
      useFactory: (sqs: SQSClient, config: AppConfig) =>
        new SqsEventPublisher(sqs, config.sqs.eventsQueueName),
      inject: [SQS_CLIENT, APP_CONFIG],
    },
    {
      provide: PublishOutboxBatch,
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, config: AppConfig) =>
        new PublishOutboxBatch(uow, publisher, clock, config.outbox),
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_CONFIG],
    },
    OutboxPublisherWorker,
    {
      provide: WagerTransactionMessageHandler,
      useFactory: (submit: SubmitWagerTransaction) => new WagerTransactionMessageHandler(submit),
      inject: [SubmitWagerTransaction],
    },
    {
      provide: WAGER_QUEUE_CONSUMER,
      useFactory: (sqs: SQSClient, handler: WagerTransactionMessageHandler, config: AppConfig) =>
        new SqsQueueConsumer(
          sqs,
          handler.handle,
          {
            queueName: config.sqs.queueName,
            deadLetterQueueName: config.sqs.deadLetterQueueName,
            batchSize: config.consumer.batchSize,
            waitTimeSeconds: config.consumer.waitTimeSeconds,
            maxReceiveCount: config.consumer.maxReceiveCount,
            retryBackoff: CONSUMER_RETRY_BACKOFF,
          },
          new Logger("SqsConsumer"),
        ),
      inject: [SQS_CLIENT, WagerTransactionMessageHandler, APP_CONFIG],
    },
    SqsConsumerWorker,
    {
      provide: RetryPendingReferences,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, config: AppConfig) =>
        new RetryPendingReferences(uow, ids, clock, {
          batchSize: config.pendingReference.batchSize,
          ttlMs: config.pendingReference.ttlMs,
          leaseMs: PENDING_REFERENCE_LEASE_MS,
        }),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, APP_CONFIG],
    },
    PendingReferenceWorker,
    { provide: PROVIDER_IDENTITY, useClass: AuthenticationDisabled },
    ProviderAuthGuard,
    {
      provide: READINESS_CHECKS,
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) => [
        new DatabaseReadinessCheck(orm),
        new SqsReadinessCheck(sqs, config.sqs.queueName),
        // A fila de eventos só é dependência da instância que publica.
        ...(config.outbox.publisherEnabled
          ? [new SqsReadinessCheck(sqs, config.sqs.eventsQueueName, "eventsQueue")]
          : []),
        // A DLQ só é dependência da instância que consome.
        ...(config.consumer.enabled
          ? [new SqsReadinessCheck(sqs, config.sqs.deadLetterQueueName, "deadLetterQueue")]
          : []),
      ],
      inject: [MIKRO_ORM, SQS_CLIENT, APP_CONFIG],
    },
  ],
  exports: [READINESS_CHECKS, UNIT_OF_WORK, ID_GENERATOR, CLOCK],
})
export class WageringModule {}
