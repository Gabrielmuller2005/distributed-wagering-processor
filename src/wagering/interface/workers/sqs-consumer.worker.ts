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
import { SqsQueueConsumer } from "../../infrastructure/sqs/sqs-queue-consumer";

export const WAGER_QUEUE_CONSUMER = Symbol("WAGER_QUEUE_CONSUMER");

/** Backoff entre ciclos que falharam (ex.: SQS fora do ar): 500 ms até 30 s. */
const ERROR_BACKOFF = Object.freeze({ baseDelayMs: 500, maxDelayMs: 30_000 });

/**
 * Papel "consumidor SQS", ligado por `ENABLE_SQS_CONSUMER`. Várias instâncias podem consumir a
 * mesma fila: o SQS entrega cada mensagem a um consumidor por vez, e a inbox e a idempotência
 * no banco cobrem as reentregas.
 *
 * Sem intervalo entre ciclos: o próprio ReceiveMessage espera (long polling).
 *
 * No SIGTERM (`beforeApplicationShutdown`, antes de o pool do banco fechar): para de buscar,
 * espera a mensagem em processamento terminar e devolve à fila (visibilidade 0) as recebidas e
 * ainda não iniciadas.
 *
 * O long polling em curso **não** é abortado. Abortar só cancela do lado do cliente: a chamada
 * continua aberta no SQS e captura a próxima mensagem que chegar, que fica invisível até o
 * visibility timeout vencer, entregue a ninguém. Esperar a chamada terminar custa no máximo
 * `SQS_WAIT_TIME_SECONDS` no encerramento, e o que ela trouxer é devolvido na hora.
 */
@Injectable()
export class SqsConsumerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("SqsConsumer");
  private readonly worker: PollingWorker;
  private stopping = false;

  constructor(
    @Inject(WAGER_QUEUE_CONSUMER) private readonly consumer: SqsQueueConsumer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.worker = new PollingWorker(
      "sqs consumer",
      () => this.tick(),
      { idleDelayMs: 0, errorBackoff: ERROR_BACKOFF },
      this.logger,
    );
  }

  get isRunning(): boolean {
    return this.worker.isRunning;
  }

  onApplicationBootstrap(): void {
    if (!this.config.consumer.enabled) return;
    this.worker.start();
    this.logger.log(`consuming ${this.config.sqs.queueName}`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.worker.stop();
  }

  private async tick(): Promise<boolean> {
    // Sem timeout próprio: o ReceiveMessage termina sozinho em até waitTimeSeconds.
    const signal = new AbortController().signal;
    const result = await this.consumer.consumeBatch(signal, () => !this.stopping);
    return result.received > 0;
  }
}
