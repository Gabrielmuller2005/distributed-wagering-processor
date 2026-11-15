import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { AppConfig } from "../../../config/app-config";
import { APP_CONFIG } from "../../../config/config.module";
import { PollingWorker } from "../../../shared/application/polling-worker";
import { PublishOutboxBatch } from "../../application/use-cases/publish-outbox-batch";
import {
  WAGERING_METRICS,
  type WageringMetrics,
} from "../../infrastructure/observability/wagering-metrics";

/** Backoff entre ciclos que falharam (ex.: PostgreSQL fora do ar): 500 ms até 30 s. */
const ERROR_BACKOFF = Object.freeze({ baseDelayMs: 500, maxDelayMs: 30_000 });

/**
 * Papel "publisher da outbox", ligado por `ENABLE_OUTBOX_PUBLISHER`. Várias instâncias podem
 * rodar o papel ao mesmo tempo: a reserva com SKIP LOCKED separa os lotes entre elas.
 *
 * O laço para em `beforeApplicationShutdown`, antes de o pool do banco e o cliente SQS
 * fecharem em `onApplicationShutdown`: o lote em andamento termina de gravar o resultado.
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("OutboxPublisher");
  private readonly worker: PollingWorker;

  constructor(
    @Inject(PublishOutboxBatch) private readonly publishBatch: PublishOutboxBatch,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
  ) {
    this.worker = new PollingWorker(
      "outbox publisher",
      () => this.tick(),
      { idleDelayMs: config.outbox.pollIntervalMs, errorBackoff: ERROR_BACKOFF },
      this.logger,
    );
  }

  get isRunning(): boolean {
    return this.worker.isRunning;
  }

  onApplicationBootstrap(): void {
    if (!this.config.outbox.publisherEnabled) return;
    this.worker.start();
    this.logger.log(`publishing outbox events to ${this.config.sqs.eventsQueueName}`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }

  /** Lote cheio indica que pode haver mais mensagens vencidas: o próximo ciclo vem na hora. */
  private async tick(): Promise<boolean> {
    const result = await this.publishBatch.execute();
    this.metrics.outboxMessagesPublished(result.published);
    this.metrics.retryScheduled("outbox_publisher", "PUBLISH_FAILED", result.retried);
    if (result.retried > 0) {
      this.logger.warn({
        msg: "outbox messages scheduled for retry",
        retried: result.retried,
        claimed: result.claimed,
      });
    }
    return result.claimed === this.config.outbox.batchSize;
  }
}
