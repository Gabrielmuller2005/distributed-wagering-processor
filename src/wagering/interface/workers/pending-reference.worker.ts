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
import { RetryPendingReferences } from "../../application/use-cases/retry-pending-references";

/** Backoff entre ciclos que falharam (ex.: PostgreSQL fora do ar): 500 ms até 30 s. */
const ERROR_BACKOFF = Object.freeze({ baseDelayMs: 500, maxDelayMs: 30_000 });

/**
 * Papel "worker de PENDING_REFERENCE", ligado por `ENABLE_PENDING_REFERENCE_WORKER`. Várias
 * instâncias podem rodá-lo: a reserva com SKIP LOCKED separa os lotes, e o lock da wallet
 * serializa o reprocessamento com as submissões da mesma wallet.
 *
 * No SIGTERM, o laço para antes de o pool do banco fechar: o lote em andamento termina; o que
 * não chegou a ser reprocessado continua reservado e volta quando a reserva vence.
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("PendingReferenceWorker");
  private readonly worker: PollingWorker;

  constructor(
    @Inject(RetryPendingReferences) private readonly retryPending: RetryPendingReferences,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.worker = new PollingWorker(
      "pending reference worker",
      () => this.tick(),
      { idleDelayMs: config.pendingReference.pollIntervalMs, errorBackoff: ERROR_BACKOFF },
      this.logger,
    );
  }

  get isRunning(): boolean {
    return this.worker.isRunning;
  }

  onApplicationBootstrap(): void {
    if (!this.config.pendingReference.workerEnabled) return;
    this.worker.start();
    this.logger.log(`retrying pending references (ttl ${this.config.pendingReference.ttlMs}ms)`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }

  private async tick(): Promise<boolean> {
    const result = await this.retryPending.execute();
    const { FAILED, EXPIRED } = result.outcomes;
    // O lote inteiro falhando indica dependência fora do ar: sobe para o backoff do laço.
    if (result.claimed > 0 && FAILED === result.claimed) throw result.firstError;
    if (FAILED > 0) {
      const reason =
        result.firstError instanceof Error ? result.firstError.message : String(result.firstError);
      this.logger.warn(`${FAILED} of ${result.claimed} pending references failed: ${reason}`);
    }
    if (EXPIRED > 0) {
      this.logger.warn(`${EXPIRED} pending references expired with REFERENCE_NOT_FOUND`);
    }
    return result.claimed === this.config.pendingReference.batchSize;
  }
}
